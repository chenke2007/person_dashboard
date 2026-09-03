import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer as createViteServer } from "vite";
import { createProjectRepository } from "../server/projects/project-repository.mjs";
import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";
import { createWorkspaceRegistry } from "../server/workspace-state/workspace-registry.mjs";

const fetchForbiddenPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

async function listenOnFetchSafePort(server) {
  for (;;) {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.removeListener("listening", onListening); reject(error); };
      const onListening = () => { server.removeListener("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    if (!fetchForbiddenPorts.has(server.address().port)) return;
    await new Promise((resolve) => server.close(resolve));
  }
}

async function startFixture(t, { readOnly = false, profile = "default", projectReadOnly, useWorkspaceRegistry = false, hosted = false, beforeStart } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-project-api-"));
  const vaultRoot = path.join(root, "vault");
  const appDataRoot = path.join(root, "app-data");
  const projectDirectory = useWorkspaceRegistry ? null : path.join(root, "state", "projects");
  await mkdir(path.join(vaultRoot, "wiki"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "plan.md"), "# Project plan\n", "utf8");
  await beforeStart?.({ root, vaultRoot, appDataRoot });
  const vite = await createViteServer({
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [workbenchApiPlugin({ vaultRoot, profile, projectDirectory, appDataRoot, readOnly, projectReadOnly, hosted })],
  });
  const server = http.createServer(vite.middlewares);
  await listenOnFetchSafePort(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await vite.close();
    await rm(root, { recursive: true, force: true });
  });
  return { origin, root, vaultRoot, appDataRoot };
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

test("lists archived tasks only on request and restores them through the local API", async (t) => {
  const { origin } = await startFixture(t);
  const created = (await request(origin, "/api/projects", {
    method: "POST",
    body: { key: "PAW", name: "Workbench" },
  })).body;
  const task = (await request(origin, `/api/projects/${created.project.id}/tasks`, {
    method: "POST",
    body: { title: "Synthetic task" },
  })).body.task;

  await request(origin, `/api/tasks/${task.id}/archive`, { method: "POST", body: {} });

  assert.equal((await request(origin, `/api/projects/${created.project.id}`)).body.tasks.length, 0);
  assert.equal((await request(origin, `/api/projects/${created.project.id}?archived=include`)).body.tasks.length, 1);
  const restored = await request(origin, `/api/tasks/${task.id}/restore`, { method: "POST", body: {} });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.task.archivedAt, null);
  assert.equal(restored.body.activities[0].type, "task.restored");
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

test("keeps external project state writable while the Vault remains read-only", async (t) => {
  const fixture = await startFixture(t, { readOnly: true, projectReadOnly: false });
  const created = await request(fixture.origin, "/api/projects", {
    method: "POST",
    body: { key: "PAW", name: "Workbench" },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.project.key, "PAW");
});

test("adopts legacy hashed project state without moving or losing projects", async (t) => {
  let legacyDirectory;
  const fixture = await startFixture(t, {
    useWorkspaceRegistry: true,
    async beforeStart({ vaultRoot, appDataRoot }) {
      const legacyId = createHash("sha256")
        .update(path.resolve(vaultRoot).toLowerCase())
        .digest("hex")
        .slice(0, 24);
      legacyDirectory = path.join(appDataRoot, "PersonalAIWorkbench", legacyId, "projects");
      const legacy = createProjectRepository({ directory: legacyDirectory });
      await legacy.createProject({ key: "OLD", name: "Synthetic legacy project" });
    },
  });

  const listed = await request(fixture.origin, "/api/projects");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.projects[0].name, "Synthetic legacy project");
  assert.equal((await readFile(path.join(legacyDirectory, "projects.json"), "utf8")).includes("Synthetic legacy project"), true);

  const registry = JSON.parse(await readFile(
    path.join(fixture.appDataRoot, "PersonalAIWorkbench", "workspace-registry.json"),
    "utf8",
  ));
  assert.equal(registry.workspaces[0].workspaceId, path.basename(path.dirname(legacyDirectory)));
  assert.equal(JSON.stringify(registry).includes(fixture.vaultRoot), false);
});

test("read-only project listing does not create registry or workspace state", async (t) => {
  const fixture = await startFixture(t, { readOnly: true, useWorkspaceRegistry: true });

  const listed = await request(fixture.origin, "/api/projects");

  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.projects, []);
  await assert.rejects(
    access(path.join(fixture.appDataRoot, "PersonalAIWorkbench")),
    (error) => error?.code === "ENOENT",
  );
});

test("rejects a versioned projects junction at the API integration seam", async (t) => {
  let outside;
  const fixture = await startFixture(t, {
    useWorkspaceRegistry: true,
    async beforeStart({ root, vaultRoot, appDataRoot }) {
      outside = path.join(root, "outside-project-state");
      await mkdir(outside);
      const fingerprint = createHash("sha256")
        .update(path.resolve(vaultRoot).toLowerCase())
        .digest("hex");
      const registry = createWorkspaceRegistry({
        directory: path.join(appDataRoot, "PersonalAIWorkbench"),
        makeId: () => "workspace-versioned",
      });
      const workspace = await registry.resolveVault({ fingerprint, label: "Synthetic Vault" });
      await symlink(
        outside,
        path.join(appDataRoot, "PersonalAIWorkbench", "workspaces", workspace.workspaceId, "projects"),
        process.platform === "win32" ? "junction" : "dir",
      );
    },
  });

  const listed = await request(fixture.origin, "/api/projects");

  assert.equal(listed.response.status, 500);
  assert.equal(listed.body.error.code, "PROJECT_STORAGE_PATH_UNSAFE");
  assert.deepEqual(await readdir(outside), []);
});

test("exports and restores project state only after a safe preview is confirmed", async (t) => {
  const fixture = await startFixture(t, { useWorkspaceRegistry: true });
  await request(fixture.origin, "/api/projects", {
    method: "POST",
    body: { key: "ONE", name: "Synthetic original project" },
  });
  const exported = await request(fixture.origin, "/api/workspace/backup");
  assert.equal(exported.response.status, 200);
  assert.deepEqual(Object.keys(exported.body.providers), ["projects"]);
  assert.equal(JSON.stringify(exported.body).includes(fixture.vaultRoot), false);

  await request(fixture.origin, "/api/projects", {
    method: "POST",
    body: { key: "TWO", name: "Synthetic later project" },
  });
  const preview = await request(fixture.origin, "/api/workspace/restore/preview", {
    method: "POST",
    body: exported.body,
  });
  assert.equal(preview.response.status, 200);
  assert.deepEqual(preview.body.providers, [{ id: "projects", version: 1, count: 4 }]);
  assert.equal((await request(fixture.origin, "/api/projects")).body.projects.length, 2);

  const confirmed = await request(fixture.origin, "/api/workspace/restore/confirm", {
    method: "POST",
    body: { token: preview.body.token },
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.restored, true);
  assert.equal((await request(fixture.origin, "/api/projects")).body.projects.length, 1);
});

test("workspace restore routes keep origin, JSON, read-only, checksum, and hosted gates", async (t) => {
  const writable = await startFixture(t, { useWorkspaceRegistry: true });
  const bundle = (await request(writable.origin, "/api/workspace/backup")).body;

  const crossOrigin = await fetch(`${writable.origin}/api/workspace/restore/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
    body: JSON.stringify(bundle),
  });
  assert.equal(crossOrigin.status, 403);

  const wrongContentType = await fetch(`${writable.origin}/api/workspace/restore/preview`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(bundle),
  });
  assert.equal(wrongContentType.status, 415);

  bundle.providers.projects.data.revision += 1;
  const altered = await request(writable.origin, "/api/workspace/restore/preview", {
    method: "POST",
    body: bundle,
  });
  assert.equal(altered.response.status, 400);
  assert.equal(altered.body.error.code, "WORKSPACE_BACKUP_CHECKSUM_INVALID");

  const readOnly = await startFixture(t, { readOnly: true, useWorkspaceRegistry: true });
  const denied = await request(readOnly.origin, "/api/workspace/restore/confirm", {
    method: "POST",
    body: { token: "synthetic-invalid-token" },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, "VAULT_READ_ONLY");

  const hosted = await startFixture(t, { hosted: true, useWorkspaceRegistry: true });
  const absent = await request(hosted.origin, "/api/workspace/backup");
  assert.equal(absent.response.status, 404);
});

test("lists safe workspace candidates and requires preview confirmation before rebind", async (t) => {
  let existingWorkspaceId;
  const fixture = await startFixture(t, {
    useWorkspaceRegistry: true,
    async beforeStart({ appDataRoot }) {
      const registryDirectory = path.join(appDataRoot, "PersonalAIWorkbench");
      const registry = createWorkspaceRegistry({ directory: registryDirectory, makeId: () => "workspace-existing" });
      const existing = await registry.resolveVault({
        fingerprint: "a".repeat(64),
        label: "Synthetic Existing Workspace",
      });
      existingWorkspaceId = existing.workspaceId;
      const repository = createProjectRepository({
        directory: path.join(registryDirectory, "workspaces", existing.workspaceId, "projects"),
      });
      await repository.createProject({ key: "OLD", name: "Synthetic retained project" });
    },
  });

  const candidates = await request(fixture.origin, "/api/workspace/rebind/candidates");
  assert.equal(candidates.response.status, 200);
  assert.deepEqual(candidates.body.items, [{
    workspaceId: existingWorkspaceId,
    label: "Synthetic Existing Workspace",
    updatedAt: candidates.body.items[0].updatedAt,
    isCurrent: false,
  }]);
  assert.equal(JSON.stringify(candidates.body).includes("fingerprint"), false);

  // A user commonly discovers the move by first opening the empty Projects page.
  assert.deepEqual((await request(fixture.origin, "/api/projects")).body.projects, []);

  const preview = await request(fixture.origin, "/api/workspace/rebind/preview", {
    method: "POST",
    body: { workspaceId: existingWorkspaceId },
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.requiresConfirmation, true);
  assert.equal((await request(fixture.origin, "/api/workspace/rebind/candidates")).body.items[0].isCurrent, false);

  const confirmed = await request(fixture.origin, "/api/workspace/rebind/confirm", {
    method: "POST",
    body: { token: preview.body.token },
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.workspaceId, existingWorkspaceId);
  const projects = await request(fixture.origin, "/api/projects");
  assert.equal(projects.body.projects[0].name, "Synthetic retained project");
});

test("runtime advertises independent recovery capabilities for actual Obsidian and workspace policies", async (t) => {
  for (const [readOnly, projectReadOnly, hosted] of [[true, false, false], [false, true, false], [true, true, false], [false, false, true]]) {
    const fixture = await startFixture(t, { profile: "obsidian", readOnly, projectReadOnly, hosted, useWorkspaceRegistry: true });
    const runtime = (await request(fixture.origin, "/api/runtime")).body;
    assert.equal(runtime.readOnly, readOnly);
    assert.equal(runtime.profile, "obsidian");
    assert.deepEqual(runtime.workspaceCapabilities, { export: !hosted, list: !hosted, restore: !hosted && !projectReadOnly, rebind: !hosted && !projectReadOnly });
    if (!projectReadOnly && !hosted) {
      const made = await request(fixture.origin, "/api/projects", { method: "POST", body: { key: "OBS", name: "Synthetic Obsidian state" } });
      assert.equal(made.response.status, 201);
      const bundle = (await request(fixture.origin, "/api/workspace/backup")).body;
      const preview = await request(fixture.origin, "/api/workspace/restore/preview", { method: "POST", body: bundle });
      assert.equal(preview.response.status, 200);
      assert.equal((await request(fixture.origin, "/api/workspace/restore/confirm", { method: "POST", body: { token: preview.body.token } })).response.status, 200);
      assert.equal(await readFile(path.join(fixture.vaultRoot, "wiki", "plan.md"), "utf8"), "# Project plan\n");
    }
  }
});

test("Obsidian overview hides Douyin metrics and their notices while default keeps missing-data semantics", async (t) => {
  for (const profile of ["obsidian", "default"]) {
    const fixture = await startFixture(t, { profile, readOnly: true });
    const overview = (await request(fixture.origin, "/api/overview")).body;
    assert.equal(overview.capabilities.douyin, profile === "default");
    if (profile === "obsidian") {
      assert.equal("publishedWorks" in overview.metrics, false);
      assert.equal("totalPlays" in overview.metrics, false);
      assert.deepEqual(overview.qualityNotices, []);
    } else {
      assert.equal(overview.metrics.publishedWorks, null);
      assert.equal(overview.metrics.totalPlays, null);
      assert.match(overview.qualityNotices.join(" "), /抖音数据源不可用/);
    }
  }
});
