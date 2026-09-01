import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildVaultIndex } from "../server/vault-index.mjs";
import { createEvidenceContext } from "../server/knowledge-chat/retrieval.mjs";

test("Chinese questions retrieve exact script evidence without same-name ambiguity or private paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-retrieval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".raw/oracle"), { recursive: true });
  await mkdir(path.join(root, ".raw/postgres"), { recursive: true });
  await writeFile(path.join(root, ".raw/oracle/check.sql"), "-- Oracle RMAN 备份\nselect backup_probe;");
  await writeFile(path.join(root, ".raw/postgres/check.sql"), "-- PostgreSQL\nselect version();");
  await writeFile(path.join(root, ".raw/secrets.json"), '{"password":"private_probe"}');
  const index = await buildVaultIndex(root, { profile: "obsidian" });
  const ctx = createEvidenceContext({ vaultRoot: root, getIndex: async () => index });
  const hits = await ctx.search("请帮我查找 Oracle RMAN 备份相关资料");
  assert.equal(hits[0].path, ".raw/oracle/check.sql");
  const read = await ctx.read(hits[0].id, 0, 8000);
  assert.equal(read.text, "-- Oracle RMAN 备份\nselect backup_probe;");
  assert.equal(read.key, "S1");
  assert.equal(ctx.sources()[0].documentId, hits[0].id);
  assert.match(ctx.sources()[0].hash, /^[a-f0-9]{64}$/);
  assert.equal((await ctx.search("private_probe")).length, 0);
  await assert.rejects(ctx.read("../outside", 0, 100), { code: "SOURCE_UNAVAILABLE" });
  await assert.rejects(ctx.read(hits[0].id, -1, 100), { code: "INVALID_TOOL_INPUT" });
});
