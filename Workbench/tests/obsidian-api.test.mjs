import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";

test("read-only Obsidian API indexes and downloads scripts without writes or workflow execution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-obsidian-api-"));
  await mkdir(path.join(root, ".raw"));
  await writeFile(path.join(root, ".raw", "check.sql"), "select api_probe from dual;");
  await writeFile(path.join(root, ".raw", "guide.md"), "# Guide\n![](pixel.png)\n");
  await writeFile(path.join(root, ".raw", "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await writeFile(path.join(root, ".raw", "secrets.json"), "PRIVATE_FIXTURE");
  const before = (await readdir(root, { recursive: true })).sort();
  const plugin = workbenchApiPlugin({ vaultRoot: root, profile: "obsidian", readOnly: true });
  let middleware;
  const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await plugin.configureServer({ httpServer: server, config: { logger: { error() {} } }, watcher: { add() {}, on() {}, off() {}, unwatch() {} }, middlewares: { use(handler) { middleware = handler; } } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await plugin.closeBundle(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const overview = await (await fetch(`${origin}/api/overview`)).json();
  assert.equal(overview.demoMode, false);
  const materials = await (await fetch(`${origin}/api/materials`)).json();
  assert.equal(materials.total, 3);
  const id = materials.recent.find((item) => item.path === ".raw/check.sql").id;
  const document = await (await fetch(`${origin}/api/documents/${id}`)).json();
  assert.equal(document.body, "select api_probe from dual;");
  assert.equal(document.readOnly, true);
  assert.equal((await fetch(`${origin}/api/reader-notes?documentId=${id}`)).status, 200);
  const file = await fetch(`${origin}/api/files/${id}`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition"), /^attachment;/);
  assert.equal(await file.text(), "select api_probe from dual;");
  const guideId = materials.recent.find((item) => item.path === ".raw/guide.md").id;
  const image = await fetch(`${origin}/api/reader-images/${guideId}?src=pixel.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  for (const route of ["/api/reader-notes", "/api/material-reading-queue", "/api/wiki-ingest", "/api/reader-explanations", "/api/open", "/api/workflows/xiaohongshu"]) {
    const response = await fetch(origin + route, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403, route);
    assert.equal((await response.json()).error.code, "VAULT_READ_ONLY");
  }
  for (const id of [Buffer.from(".raw/secrets.json").toString("base64url"), Buffer.from("../outside.txt").toString("base64url")]) {
    assert.equal((await fetch(`${origin}/api/files/${id}`)).status, 404);
  }
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  assert.equal(await readFile(path.join(root, ".raw/check.sql"), "utf8"), "select api_probe from dual;");
});
