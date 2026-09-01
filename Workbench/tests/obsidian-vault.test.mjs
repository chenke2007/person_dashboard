import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import XLSX from "xlsx";
import { buildVaultIndex, getDocument, searchIndex } from "../server/vault-index.mjs";
import { materialsHomePayload, materialFolderPayload } from "../server/materials.mjs";
import { affectedScopesForPaths } from "../server/vault-sync.mjs";
import { readIndexedFile } from "../server/obsidian-vault.mjs";

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-obsidian-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Obsidian profile reads raw scripts and root notes without indexing plugin or secret files", async (t) => {
  const root = await fixture(t, {
    ".raw/DBA/check.sql": "select database_probe from dual;",
    ".raw/DBA/backup.sh": "#!/bin/sh\necho backup_probe\n",
    ".raw/DBA/README.md": "# DBA guide\n",
    "operations.md": "# Operations\n[[Database]]",
    "wiki/entities/Database.md": "---\ntype: entity\n---\n# Database\n",
    "wiki/concepts/Recovery.md": "# Recovery\n[[Database]]",
    "skills/example/SKILL.md": "PLUGIN_ONLY",
    "README.md": "PLUGIN_ONLY",
    ".raw/DBA/node_modules/vendor/index.js": "VENDOR_ONLY",
    ".raw/DBA/__pycache__/cached.pyc": "CACHE_ONLY",
    ".raw/DBA/.env": "SECRET_ONLY",
    ".raw/DBA/prod.connections": "SECRET_ONLY",
    ".raw/DBA/private.pem": "SECRET_ONLY",
    ".obsidian/settings.json": "SECRET_ONLY",
  });
  const before = (await readdir(root, { recursive: true })).sort();
  const index = await buildVaultIndex(root, { profile: "obsidian" });
  assert.equal(index.demoMode, false);
  assert.equal(index.stats.rawFiles, 4);
  assert.equal(index.stats.formalWikiPages, 2);
  assert.equal(index.stats.documents, 6);
  assert.equal(searchIndex(index, "database_probe")[0]?.path, ".raw/DBA/check.sql");
  assert.equal(searchIndex(index, "backup_probe")[0]?.path, ".raw/DBA/backup.sh");
  assert.equal(searchIndex(index, "SECRET_ONLY").length, 0);
  assert.equal(searchIndex(index, "PLUGIN_ONLY").length, 0);
  assert.equal(getDocument(index, ".raw/DBA/check.sql").previewKind, "text");
  assert.equal(getDocument(index, ".raw/DBA/check.sql").content, "select database_probe from dual;");
  const home = materialsHomePayload(index);
  assert.equal(home.total, 4);
  const folder = materialFolderPayload(index, { items: [] }, "10_raw/原始资料/DBA");
  assert.equal(folder.items.length, 3);
  assert.ok(folder.items.every((item) => item.path.startsWith(".raw/DBA/")));
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  assert.equal(await readFile(path.join(root, ".raw/DBA/check.sql"), "utf8"), "select database_probe from dual;");
});

test("Obsidian profile decodes legacy Chinese and extensionless scripts and keeps binary files metadata-only", async (t) => {
  const root = await fixture(t, {
    ".raw/中文.sql": Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),
    ".raw/runbook": "#!/bin/sh\necho extensionless_probe",
    ".raw/binary": Buffer.from([0, 1, 2, 3]),
    ".raw/large.txt": "x".repeat(8 * 1024 * 1024 + 1),
  });
  const index = await buildVaultIndex(root, { profile: "obsidian" });
  assert.equal(getDocument(index, ".raw/中文.sql").content, "测试");
  assert.equal(searchIndex(index, "extensionless_probe").length, 1);
  assert.equal(getDocument(index, ".raw/binary").content, null);
  assert.equal(getDocument(index, ".raw/large.txt").content, null);
  assert.equal(getDocument(index, ".raw/large.txt").contentStatus, "too_large");
});

function wordFixture() {
  const zip = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(zip, "[Content_Types].xml", Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  XLSX.CFB.utils.cfb_add(zip, "_rels/.rels", Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  XLSX.CFB.utils.cfb_add(zip, "word/document.xml", Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>word_recovery_probe</w:t></w:r></w:p></w:body></w:document>'));
  return XLSX.CFB.write(zip, { type: "buffer", fileType: "zip" });
}

function pdfFixture(padding = "") {
  const stream = "BT /F1 12 Tf 50 100 Td (pdf_recovery_probe) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = `%PDF-1.4\n%${padding}\n`;
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

test("Word and PDF text is searchable; damaged documents remain listed with explicit status", async (t) => {
  const root = await fixture(t, {
    "manual.docx": wordFixture(),
    ".raw/manual.pdf": pdfFixture(),
    ".raw/broken.doc": "not a word document",
  });
  const index = await buildVaultIndex(root, { profile: "obsidian" });
  assert.equal(searchIndex(index, "word_recovery_probe")[0]?.path, "manual.docx");
  assert.equal(searchIndex(index, "pdf_recovery_probe")[0]?.path, ".raw/manual.pdf");
  assert.equal(getDocument(index, ".raw/broken.doc").contentStatus, "extraction_failed");
});

test("raw and root-file changes invalidate the material view", () => {
  assert.ok(affectedScopesForPaths([".raw/DBA/check.sql"]).includes("materials"));
  assert.ok(affectedScopesForPaths(["manual.docx"]).includes("materials"));
});

test("office files larger than the script text limit still get searchable text", async (t) => {
  const root = await fixture(t, { ".raw/large-manual.pdf": pdfFixture(" ".repeat(9 * 1024 * 1024)) });
  const index = await buildVaultIndex(root, { profile: "obsidian" });
  assert.equal(searchIndex(index, "pdf_recovery_probe")[0]?.path, ".raw/large-manual.pdf");
});

test("explicit wiki links resolve the correct attachment when basenames repeat", async (t) => {
  const root = await fixture(t, {
    "wiki/procedures/Recovery.md": "# Recovery\n[[../../.raw/oracle/check.sql]]\n[[../../.raw/postgres/check.sql]]",
    ".raw/oracle/check.sql": "select oracle_probe from dual;",
    ".raw/postgres/check.sql": "select postgres_probe;",
  });
  const index = await buildVaultIndex(root, { profile: "obsidian" });
  const guide = getDocument(index, "wiki/procedures/Recovery.md");
  assert.deepEqual(guide.wikiLinks.map((link) => link.resolvedId), [getDocument(index, ".raw/oracle/check.sql").id, getDocument(index, ".raw/postgres/check.sql").id]);
  assert.equal(getDocument(index, ".raw/oracle/check.sql").backlinks[0]?.id, guide.id);
});

test("spreadsheet text is searchable without evaluating formulas", async (t) => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["spreadsheet_probe", "DBA inventory"]]);
  sheet.A2 = { t: "n", v: 7, f: "3+4" };
  sheet["!ref"] = "A1:B2";
  XLSX.utils.book_append_sheet(book, sheet, "Inventory");
  const root = await fixture(t, { ".raw/inventory.xlsx": XLSX.write(book, { type: "buffer", bookType: "xlsx" }) });
  const index = await buildVaultIndex(root, { profile: "obsidian" });
  assert.equal(searchIndex(index, "spreadsheet_probe")[0]?.path, ".raw/inventory.xlsx");
  assert.equal(getDocument(index, ".raw/inventory.xlsx").previewKind, "text");
});

test("indexed reads reject a parent replaced with an external directory link", async (t) => {
  const root = await fixture(t, { ".raw/check.sql": "local_probe" });
  const outside = await fixture(t, { "check.sql": "outside_probe" });
  const index = await buildVaultIndex(root, { profile: "obsidian" });
  const document = getDocument(index, ".raw/check.sql");
  await rename(path.join(root, ".raw"), path.join(root, "original-raw"));
  await symlink(outside, path.join(root, ".raw"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readIndexedFile(root, document.path), /SYMLINK_SKIPPED/);
});
