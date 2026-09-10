import assert from "node:assert/strict";
import test from "node:test";

const uuid = (char) => char.repeat(8) + "-2222-4333-8444-555555555555";

test("learning browser client emits exact request methods, urls, and JSON bodies", async () => {
  const calls = [];
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const api = await import("../src/lib/learning-api.js");

  await api.loadLearningCapabilities();
  await api.loadLearningWorkspaces();
  await api.loadLearningWorkspaces({ includeArchived: true });
  await api.loadLearningWorkspace(uuid("1"));
  await api.createLearningDraft(101, { goal: "learn-usage", notes: "Synthetic task" });
  await api.editLearningDraft(uuid("1"), 3, { goal: "analyze-design", notes: "Edited" });
  await api.previewLearningDraft(uuid("1"));
  await api.confirmLearning("synthetic.token");
  await api.activateLearning(uuid("1"), 3);
  await api.archiveLearning(uuid("1"));

  assert.deepEqual(calls.map(({ url, options }) => ({
    url,
    method: options.method,
    body: options.body && JSON.parse(options.body),
  })), [
    { url: "/api/learning/capabilities", method: "GET", body: undefined },
    { url: "/api/learning", method: "GET", body: undefined },
    { url: "/api/learning?includeArchived=1", method: "GET", body: undefined },
    { url: `/api/learning/${uuid("1")}`, method: "GET", body: undefined },
    { url: "/api/learning/drafts", method: "POST", body: { repositoryId: 101, mission: { goal: "learn-usage", notes: "Synthetic task" } } },
    { url: `/api/learning/${uuid("1")}/draft`, method: "PATCH", body: { expectedRevision: 3, mission: { goal: "analyze-design", notes: "Edited" } } },
    { url: `/api/learning/${uuid("1")}/preview`, method: "POST", body: {} },
    { url: "/api/learning/confirm", method: "POST", body: { token: "synthetic.token" } },
    { url: `/api/learning/${uuid("1")}/activate`, method: "POST", body: { expectedRevision: 3 } },
    { url: `/api/learning/${uuid("1")}/archive`, method: "POST", body: {} },
  ]);
});

test("learning client surfaces safe server errors for the UI", async () => {
  const { WorkbenchApiError } = await import("../src/lib/api-errors.js");
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: "WORKSPACE_BINDING_CHANGED", message: "工作区绑定已改变，请重新加载后重试。" } }),
    { status: 409, headers: { "Content-Type": "application/json" } },
  );
  const api = await import("../src/lib/learning-api.js");

  const failure = await api.confirmLearning("x").then(
    () => null,
    (error) => error,
  );

  assert.ok(failure instanceof WorkbenchApiError);
  assert.equal(failure.status, 409);
  assert.equal(failure.code, "WORKSPACE_BINDING_CHANGED");
});

test("radar client passes the learning filter through while omitting it when 'all'", async () => {
  const calls = [];
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const api = await import("../src/lib/ai-radar-api.js");

  await api.loadRadar({ period: "day", learning: "active" });
  await api.loadRadar({ period: "day", learning: "all" });
  await api.loadRadar({ period: "day", state: "saved", focus: "agent", learning: "queued" });

  assert.deepEqual(calls.map(({ url }) => url), [
    "/api/ai-radar?period=day&learning=active",
    "/api/ai-radar?period=day",
    "/api/ai-radar?period=day&state=saved&focus=agent&learning=queued",
  ]);
});