import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer as createViteServer } from "vite";
import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";

async function startFixture(t, { readOnly = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-project-api-"));
  const vaultRoot = path.join(root, "vault");
  const projectDirectory = path.join(root, "state", "projects");
  await mkdir(path.join(vaultRoot, "wiki"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "plan.md"), "# Project plan\n", "utf8");
  const vite = await createViteServer({
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [workbenchApiPlugin({ vaultRoot, projectDirectory, readOnly })],
  });
  const server = http.createServer(vite.middlewares);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await vite.close();
    await rm(root, { recursive: true, force: true });
  });
  return { origin };
}

async function request(origin, route, { method = "GET", body, headers } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("creates and reads a project through the local API", async (t) => {
  const { origin } = await startFixture(t);
  const created = await request(origin, "/api/projects", {
    method: "POST",
    body: { key: "PAW", name: "Workbench" },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.project.key, "PAW");
  assert.equal(created.body.columns.length, 3);

  const listed = await request(origin, "/api/projects");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.projects[0].name, "Workbench");

  const detail = await request(origin, `/api/projects/${created.body.project.id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.project.id, created.body.project.id);
});

test("mutates the complete first-phase project model through command endpoints", async (t) => {
  const { origin } = await startFixture(t);
  const created = (await request(origin, "/api/projects", {
    method: "POST",
    body: { key: "PAW", name: "Workbench" },
  })).body;
  const projectId = created.project.id;

  const column = await request(origin, `/api/projects/${projectId}/columns`, {
    method: "POST",
    body: { name: "验证中", color: "#876cc9" },
  });
  assert.equal(column.response.status, 201);
  const orderedIds = [column.body.column.id, ...created.columns.map((item) => item.id)];
  const reordered = await request(origin, `/api/projects/${projectId}/columns/order`, {
    method: "PUT",
    body: { orderedIds },
  });
  assert.deepEqual(reordered.body.columns.map((item) => item.id), orderedIds);

  const createdTask = await request(origin, `/api/projects/${projectId}/tasks`, {
    method: "POST",
    body: { title: "实现项目接口", priority: "high" },
  });
  assert.equal(createdTask.response.status, 201);
  const taskId = createdTask.body.task.id;
  const updated = await request(origin, `/api/tasks/${taskId}`, {
    method: "PATCH",
    body: { title: "实现完整项目接口", dueDate: "2026-09-10" },
  });
  assert.equal(updated.body.task.title, "实现完整项目接口");

  const moved = await request(origin, `/api/tasks/${taskId}/move`, {
    method: "POST",
    body: { columnId: created.columns[1].id, index: 0, revision: updated.body.revision },
  });
  assert.equal(moved.body.task.columnId, created.columns[1].id);
  const stale = await request(origin, `/api/tasks/${taskId}/move`, {
    method: "POST",
    body: { columnId: created.columns[0].id, index: 0, revision: updated.body.revision },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "PROJECT_REVISION_CONFLICT");

  const label = await request(origin, "/api/projects/labels", {
    method: "POST",
    body: { name: "重要", color: "#e05252" },
  });
  const labeled = await request(origin, `/api/tasks/${taskId}/labels`, {
    method: "PUT",
    body: { labelIds: [label.body.label.id] },
  });
  assert.equal(labeled.body.taskLabels.length, 1);

  const linked = await request(origin, `/api/tasks/${taskId}/links`, {
    method: "POST",
    body: { documentId: "wiki/plan.md" },
  });
  assert.equal(linked.response.status, 201);
  assert.equal(linked.body.link.relativePath, "wiki/plan.md");
  const removed = await request(origin, `/api/task-links/${linked.body.link.id}`, { method: "DELETE", body: {} });
  assert.equal(removed.body.removedLinkId, linked.body.link.id);

  assert.equal((await request(origin, `/api/tasks/${taskId}/archive`, { method: "POST", body: {} })).response.status, 200);
  assert.equal((await request(origin, `/api/projects/${projectId}/archive`, { method: "POST", body: {} })).response.status, 200);
  assert.equal((await request(origin, "/api/projects")).body.projects.length, 0);
  assert.equal((await request(origin, "/api/projects?archived=include")).body.projects[0].archivedAt != null, true);
  assert.equal((await request(origin, `/api/projects/${projectId}/restore`, { method: "POST", body: {} })).body.project.archivedAt, null);
});

test("rejects unsafe, read-only, stale, and malformed mutations", async (t) => {
  const writable = await startFixture(t);
  const crossOrigin = await fetch(`${writable.origin}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
    body: JSON.stringify({ key: "PAW", name: "Workbench" }),
  });
  assert.equal(crossOrigin.status, 403);

  const malformed = await fetch(`${writable.origin}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "PROJECT_INVALID_JSON");

  const readOnly = await startFixture(t, { readOnly: true });
  const denied = await request(readOnly.origin, "/api/projects", {
    method: "POST",
    body: { key: "PAW", name: "Workbench" },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, "VAULT_READ_ONLY");
});
