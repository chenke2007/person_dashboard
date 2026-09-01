import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = { setTimeout, clearTimeout };

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const api = await import("../src/lib/project-api.js");

test("project client emits exact JSON command requests", async () => {
  calls.length = 0;
  await api.createProject({ key: "PAW", name: "Workbench" });
  await api.createTask("project-1", { title: "Build" });
  await api.moveTask("task-1", { columnId: "doing", index: 0, revision: 4 });
  await api.setTaskLabels("task-1", ["important"]);
  await api.removeTaskLink("link-1");

  assert.deepEqual(calls.map(({ url, options }) => ({
    url,
    method: options.method,
    body: options.body && JSON.parse(options.body),
  })), [
    { url: "/api/projects", method: "POST", body: { key: "PAW", name: "Workbench" } },
    { url: "/api/projects/project-1/tasks", method: "POST", body: { title: "Build" } },
    { url: "/api/tasks/task-1/move", method: "POST", body: { columnId: "doing", index: 0, revision: 4 } },
    { url: "/api/tasks/task-1/labels", method: "PUT", body: { labelIds: ["important"] } },
    { url: "/api/task-links/link-1", method: "DELETE", body: {} },
  ]);
});
