import assert from "node:assert/strict";
import test from "node:test";

import { RadarRepositoryError } from "../server/ai-radar/radar-repository.mjs";
import { createRadarRoutes } from "../server/ai-radar/radar-routes.mjs";
import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceRegistry } from "../server/workspace-state/workspace-registry.mjs";

function safeDashboard() {
  return {
    period: "day",
    timeZone: "Etc/UTC",
    localDate: "2026-09-02",
    filters: { state: "all", focus: "all" },
    counts: { all: 30, unread: 20, saved: 3, summarized: 1, queued: 2, learning: 1, completed: 1, ignored: 2 },
    eligibleCount: 28,
    lists: { rising: [], established: [], relevant: [] },
    freshness: { queriedAt: "2026-09-02T01:00:00.000Z", asOf: "2026-09-02T01:00:00.000Z", lastDataAt: "2026-09-02T01:00:00.000Z", lastSuccessAt: "2026-09-02T01:00:00.000Z", stale: false },
    coverage: { discoveredCount: 30, trackedCount: 2, detailRequestedCount: 10, observedCount: 30, failedCount: 0, deferredCount: 0, truncated: false, partial: false, retryAt: null },
    retryAt: null,
    errors: [],
    run: { id: "00000000-0000-4000-8000-000000000001", trigger: "startup", startedAt: "2026-09-02T01:00:00.000Z", finishedAt: "2026-09-02T01:00:01.000Z", status: "success", localDate: "2026-09-02", timeZone: "Etc/UTC", repositoryCount: 0, errors: [], sequence: 1, collection: null },
    schedule: { enabled: true, time: "08:00", timeZone: "Etc/UTC", lastAttemptAt: null, lastSuccessAt: null, nextRunAt: "2026-09-03T08:00:00.000Z" },
  };
}

function fakeRepository(overrides = {}) {
  const calls = [];
  const repository = {
    calls,
    async getDashboard(options) {
      calls.push(["getDashboard", options]);
      return safeDashboard();
    },
    async setDecision(repositoryId, status) {
      calls.push(["setDecision", repositoryId, status]);
      return { repositoryId, status, updatedAt: "2026-09-02T01:00:00.000Z" };
    },
    async addPreference(input) {
      calls.push(["addPreference", input]);
      return { ...input, id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-09-02T01:00:00.000Z", revertedAt: null };
    },
    async revertPreference(id) {
      calls.push(["revertPreference", id]);
      return { id, revertedAt: "2026-09-02T01:00:00.000Z" };
    },
    async resetPreferences() {
      calls.push(["resetPreferences"]);
      return [];
    },
    async listPreferences() {
      calls.push(["listPreferences"]);
      return [];
    },
  };
  return Object.assign(repository, overrides);
}

function fakeScheduler(overrides = {}) {
  const calls = [];
  const scheduler = {
    calls,
    async getStatus() {
      calls.push(["getStatus"]);
      return { running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null };
    },
    async runNow() {
      calls.push(["runNow"]);
      return {
        persisted: true,
        retryAt: null,
        run: { id: "00000000-0000-4000-8000-000000000002", trigger: "manual", status: "success", localDate: "2026-09-02", timeZone: "Etc/UTC", sequence: 2 },
        dashboard: { period: "day" },
      };
    },
    async updateSchedule(patch) {
      calls.push(["updateSchedule", patch]);
      return { enabled: true, time: "08:00", timeZone: "Etc/UTC", lastAttemptAt: null, lastSuccessAt: null, nextRunAt: "2026-09-03T08:00:00.000Z" };
    },
  };
  return Object.assign(scheduler, overrides);
}

async function request(routes, method, url, body, headers = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = {
    method,
    url,
    headers: { "content-type": "application/json", ...headers },
    async *[Symbol.asyncIterator]() {
      if (raw) yield raw;
    },
  };
  let status = 0;
  let payload = null;
  const res = {
    writeHead(value) { status = value; },
    end(value) { payload = value; },
  };
  await routes.handle(req, res, new URL(url, "http://127.0.0.1"));
  return { status, body: payload === null ? null : JSON.parse(payload) };
}

async function rawRequest(routes, method, url, raw) {
  const req = {
    method,
    url,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { yield raw; },
  };
  let status = 0;
  let payload = null;
  const res = {
    writeHead(value) { status = value; },
    end(value) { payload = value; },
  };
  await routes.handle(req, res, new URL(url, "http://127.0.0.1"));
  return { status, body: JSON.parse(payload) };
}

// Splits a UTF-8 body into Buffer chunks with boundaries guaranteed to cut
// through multi-byte code points (after the first byte of the first non-ASCII
// character, then in irregular three-byte slices that break inside 4-byte
// emoji sequences).
function splitMidCodepoint(raw) {
  const buffer = Buffer.from(raw, "utf8");
  const chunks = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] >= 0x80) {
      chunks.push(buffer.subarray(0, index + 1));
      start = index + 1;
      break;
    }
  }
  if (chunks.length === 0) return [buffer];
  for (let index = start; index < buffer.length; index += 3) {
    chunks.push(buffer.subarray(index, Math.min(index + 3, buffer.length)));
  }
  return chunks;
}

async function chunkedRequest(routes, method, url, raw) {
  const chunks = splitMidCodepoint(raw);
  const req = {
    method,
    url,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
  let status = 0;
  let payload = null;
  const res = {
    writeHead(value) { status = value; },
    end(value) { payload = value; },
  };
  await routes.handle(req, res, new URL(url, "http://127.0.0.1"));
  return { status, body: payload === null ? null : JSON.parse(payload) };
}

function routeFixture({ repository, scheduler, readOnly = false } = {}) {
  return createRadarRoutes({
    repository: repository ?? fakeRepository(),
    scheduler: scheduler ?? fakeScheduler(),
    readOnly,
  });
}

test("GET /api/ai-radar passes period/state/focus to the repository dashboard query", async () => {
  const repository = fakeRepository();
  const routes = routeFixture({ repository });

  const response = await request(routes, "GET", "/api/ai-radar?period=week&state=saved&focus=agent");

  assert.equal(response.status, 200);
  assert.deepEqual(repository.calls[0], ["getDashboard", { period: "week", state: "saved", focus: "agent" }]);
  assert.equal(response.body.localDate, "2026-09-02");
});

test("GET /api/ai-radar defaults missing filters and rejects invalid periods safely", async () => {
  const repository = fakeRepository({
    async getDashboard(options) {
      repository.calls.push(["getDashboard", options]);
      if (options.period !== "day") {
        throw new RadarRepositoryError("RADAR_INVALID_INPUT", "雷达输入格式无效。");
      }
      return safeDashboard();
    },
  });
  const routes = routeFixture({ repository });

  const bare = await request(routes, "GET", "/api/ai-radar");
  assert.equal(bare.status, 200);
  assert.deepEqual(repository.calls[0], ["getDashboard", { period: "day", state: "all", focus: "all" }]);

  const invalid = await request(routes, "GET", "/api/ai-radar?period=hourly");
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.error, { code: "RADAR_INVALID_INPUT", message: "雷达输入格式无效。" });
});

test("GET /api/ai-radar/status returns scheduler status with safe defaults", async () => {
  const scheduler = fakeScheduler();
  const routes = routeFixture({ scheduler });

  const response = await request(routes, "GET", "/api/ai-radar/status");

  assert.equal(response.status, 200);
  assert.deepEqual(scheduler.calls, [["getStatus"]]);
  assert.deepEqual(response.body, { running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
});

test("GET status reports a missing scheduler without creating one", async () => {
  const routes = routeFixture({ scheduler: fakeScheduler({ getStatus: async () => null }) });

  const response = await request(routes, "GET", "/api/ai-radar/status");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
});

test("POST /api/ai-radar/collect runs the manual collection and drops heavy dashboard from the response", async () => {
  const scheduler = fakeScheduler();
  const routes = routeFixture({ scheduler });

  const response = await request(routes, "POST", "/api/ai-radar/collect");

  assert.equal(response.status, 200);
  assert.deepEqual(scheduler.calls, [["runNow"]]);
  assert.deepEqual(response.body, {
    persisted: true,
    retryAt: null,
    run: { id: "00000000-0000-4000-8000-000000000002", trigger: "manual", status: "success", localDate: "2026-09-02", timeZone: "Etc/UTC", sequence: 2 },
    error: null,
  });
  assert.equal(Object.hasOwn(response.body, "dashboard"), false);
});

test("PATCH /api/ai-radar/schedule delegates to the scheduler update hook", async () => {
  const scheduler = fakeScheduler();
  const routes = routeFixture({ scheduler });

  const response = await request(routes, "PATCH", "/api/ai-radar/schedule", { enabled: true, time: "09:30", timeZone: "Asia/Shanghai" });

  assert.equal(response.status, 200);
  assert.deepEqual(scheduler.calls, [["updateSchedule", { enabled: true, time: "09:30", timeZone: "Asia/Shanghai" }]]);
  assert.equal(response.body.enabled, true);
});

test("PUT /api/ai-radar/repositories/:id/decision persists through the repository", async () => {
  const repository = fakeRepository();
  const routes = routeFixture({ repository });

  const response = await request(routes, "PUT", "/api/ai-radar/repositories/9876/decision", { status: "saved" });

  assert.equal(response.status, 200);
  assert.deepEqual(repository.calls, [["setDecision", 9876, "saved"]]);
  assert.deepEqual(response.body, { repositoryId: 9876, status: "saved", updatedAt: "2026-09-02T01:00:00.000Z" });
});

test("PUT decision rejects non-numeric ids and invalid statuses safely", async () => {
  const repository = fakeRepository({
    async setDecision(repositoryId, status) {
      if (!["saved", "ignored"].includes(status)) {
        throw new RadarRepositoryError("RADAR_INVALID_INPUT", "雷达输入格式无效。");
      }
      return { repositoryId, status, updatedAt: "2026-09-02T01:00:00.000Z" };
    },
  });
  const routes = routeFixture({ repository });

  const badId = await request(routes, "PUT", "/api/ai-radar/repositories/abc/decision", { status: "saved" });
  assert.equal(badId.status, 404);
  assert.equal(badId.body.error.code, "RADAR_ROUTE_NOT_FOUND");

  const badStatus = await request(routes, "PUT", "/api/ai-radar/repositories/1/decision", { status: "starred" });
  assert.equal(badStatus.status, 400);
  assert.deepEqual(badStatus.body.error, { code: "RADAR_INVALID_INPUT", message: "雷达输入格式无效。" });
});

test("POST /api/ai-radar/preferences adds a durable reversible preference", async () => {
  const repository = fakeRepository();
  const routes = routeFixture({ repository });

  const response = await request(routes, "POST", "/api/ai-radar/preferences", {
    repositoryId: null,
    kind: "topic",
    value: "autonomous agents",
    direction: "less",
  });

  assert.equal(response.status, 201);
  assert.deepEqual(repository.calls, [["addPreference", { repositoryId: null, kind: "topic", value: "autonomous agents", direction: "less" }]]);
  assert.equal(response.body.id, "00000000-0000-4000-8000-000000000001");
  assert.equal(response.body.revertedAt, null);
});

test("POST /api/ai-radar/preferences/:id/revert reverts a durable preference", async () => {
  const repository = fakeRepository();
  const routes = routeFixture({ repository });
  const uuid = "11111111-2222-4333-8444-555555555555";

  const response = await request(routes, "POST", `/api/ai-radar/preferences/${uuid}/revert`);

  assert.equal(response.status, 200);
  assert.deepEqual(repository.calls, [["revertPreference", uuid]]);
  assert.equal(response.body.revertedAt, "2026-09-02T01:00:00.000Z");
});

test("DELETE /api/ai-radar/preferences resets all preferences", async () => {
  const repository = fakeRepository();
  const routes = routeFixture({ repository });

  const response = await request(routes, "DELETE", "/api/ai-radar/preferences");

  assert.equal(response.status, 200);
  assert.deepEqual(repository.calls, [["resetPreferences"]]);
  assert.deepEqual(response.body, []);
});

test("read-only mode rejects every mutation without touching repository or scheduler", async () => {
  const repository = fakeRepository();
  const scheduler = fakeScheduler();
  const routes = routeFixture({ repository, scheduler, readOnly: true });

  for (const probe of [
    ["POST", "/api/ai-radar/collect", undefined],
    ["PATCH", "/api/ai-radar/schedule", { enabled: true }],
    ["PUT", "/api/ai-radar/repositories/1/decision", { status: "saved" }],
    ["POST", "/api/ai-radar/preferences", { kind: "topic", value: "x", direction: "less", repositoryId: null }],
    ["POST", "/api/ai-radar/preferences/11111111-2222-4333-8444-555555555555/revert", undefined],
    ["DELETE", "/api/ai-radar/preferences", undefined],
  ]) {
    const response = await request(routes, probe[0], probe[1], probe[2]);
    assert.equal(response.status, 403, `${probe[0]} ${probe[1]}`);
    assert.deepEqual(response.body.error, { code: "RADAR_READ_ONLY", message: "AI 雷达调度在当前工作区不可用。" });
  }
  assert.deepEqual(repository.calls, []);
  assert.deepEqual(scheduler.calls, []);
});

test("read-only mode still serves reads", async () => {
  const routes = routeFixture({ readOnly: true });

  const dashboard = await request(routes, "GET", "/api/ai-radar?period=day");
  const status = await request(routes, "GET", "/api/ai-radar/status");

  assert.equal(dashboard.status, 200);
  assert.equal(status.status, 200);
});

test("GET /api/ai-radar/preferences lists active reversible preferences", async () => {
  const preferences = [
    { id: "11111111-2222-4333-8444-555555555555", repositoryId: null, kind: "topic", value: "agents", direction: "less", createdAt: "2026-09-02T01:00:00.000Z", revertedAt: null },
  ];
  const calls = [];
  const repository = fakeRepository({ listPreferences: async () => { calls.push("listPreferences"); return preferences; } });
  const routes = routeFixture({ repository });

  const response = await request(routes, "GET", "/api/ai-radar/preferences");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, preferences);
  assert.deepEqual(calls, ["listPreferences"]);
});

test("unknown radar routes and method mismatches return 404", async () => {
  const routes = routeFixture();

  const missing = await request(routes, "GET", "/api/ai-radar/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "RADAR_ROUTE_NOT_FOUND");

  const mismatch = await request(routes, "DELETE", "/api/ai-radar/collect");
  assert.equal(mismatch.status, 404);
  assert.equal(mismatch.body.error.code, "RADAR_ROUTE_NOT_FOUND");
});

test("radar routes do not match other API prefixes", async () => {
  const routes = routeFixture();

  assert.equal(routes.matches(null, new URL("/api/projects", "http://127.0.0.1")), false);
  assert.equal(routes.matches(null, new URL("/api/ai-radar/status", "http://127.0.0.1")), true);
  assert.equal(routes.matches(null, new URL("/api/ai-radar-extra", "http://127.0.0.1")), false);
});

test("invalid JSON bodies and oversized bodies are rejected safely", async () => {
  const routes = routeFixture();

  const invalid = await rawRequest(routes, "PATCH", "/api/ai-radar/schedule", "{not json");
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.error, { code: "RADAR_INVALID_JSON", message: "请求内容不是有效 JSON。" });

  const oversized = await rawRequest(routes, "PATCH", "/api/ai-radar/schedule", "x".repeat(300 * 1024));
  assert.equal(oversized.status, 413);
  assert.deepEqual(oversized.body.error, { code: "RADAR_REQUEST_TOO_LARGE", message: "请求内容超过容量限制。" });
});

test("multibyte bodies split across Buffer boundaries decode exactly like a single chunk", async () => {
  const repository = fakeRepository();
  const scheduler = fakeScheduler();
  const routes = routeFixture({ repository, scheduler });

  const value = "深思熟虑 🤖 智能体助手（中文+emoji）";
  const preference = { kind: "topic", value, direction: "more", repositoryId: null };
  const created = await chunkedRequest(routes, "POST", "/api/ai-radar/preferences", JSON.stringify(preference));
  assert.equal(created.status, 201);
  assert.equal(created.body.value, value);
  assert.equal(created.body.kind, "topic");
  assert.equal(created.body.direction, "more");
  assert.deepEqual(repository.calls.at(-1)[1], preference);

  const note = "调度说明：支持中文与 emoji 🚀 同值解析";
  const patch = { enabled: true, time: "08:00", timeZone: "Etc/UTC", note };
  const scheduled = await chunkedRequest(routes, "PATCH", "/api/ai-radar/schedule", JSON.stringify(patch));
  assert.equal(scheduled.status, 200);
  assert.deepEqual(scheduler.calls.at(-1)[1], patch);
});

test("internal failures never leak GitHub details, tokens, or absolute paths", async () => {
  const repository = fakeRepository({
    async getDashboard() {
      const hostile = new Error("raw x-rate-limit header and token ghp_abcdefghijklmnopqrstuvwxyz leaked");
      hostile.headers = { "x-ratelimit-reset": "1700000000", authorization: "Bearer ghp_secret" };
      hostile.path = "C:\\Users\\owner\\AppData\\Local\\PersonalAIWorkbench\\ai-radar";
      throw hostile;
    },
  });
  const routes = routeFixture({ repository });

  const response = await request(routes, "GET", "/api/ai-radar?period=day");
  const serialized = JSON.stringify(response.body);

  assert.equal(response.status, 500);
  assert.deepEqual(response.body.error, { code: "RADAR_INTERNAL_ERROR", message: "雷达服务暂时不可用。" });
  assert.equal(serialized.includes("ghp_"), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(serialized.includes("x-rate-limit"), false);
  assert.equal(serialized.includes("AppData"), false);
  assert.equal(serialized.includes("C:\\"), false);
});

test("malicious exceptions smuggling code/status never leak original messages or headers", async () => {
  const repository = fakeRepository({
    async getDashboard() {
      const hostile = new Error("raw x-rate-limit header, ghp_abcdefghijklmnopqrstuvwxyz and C:\\Users\\owner\\AppData leaked");
      hostile.code = "RADAR_INTERNAL_ERROR";
      hostile.status = 418;
      hostile.headers = { "x-ratelimit-reset": "1700000000", authorization: "Bearer ghp_secret" };
      hostile.path = "C:\\Users\\owner\\AppData\\Local\\PersonalAIWorkbench\\ai-radar";
      throw hostile;
    },
  });
  const routes = routeFixture({ repository });

  const response = await request(routes, "GET", "/api/ai-radar?period=day");
  const serialized = JSON.stringify(response.body);

  assert.equal(response.status, 500);
  assert.deepEqual(response.body.error, { code: "RADAR_INTERNAL_ERROR", message: "雷达服务暂时不可用。" });
  assert.equal(serialized.includes("ghp_"), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(serialized.includes("x-ratelimit"), false);
  assert.equal(serialized.includes("AppData"), false);
  assert.equal(serialized.includes("C:\\"), false);
});

test("ad-hoc errors wearing known code/status are still mapped to the fixed internal error", async () => {
  const repository = fakeRepository({
    async getDashboard() {
      const hostile = new Error("C:\\Vault\\private note content");
      hostile.code = "RADAR_INVALID_INPUT";
      hostile.status = 400;
      throw hostile;
    },
  });
  const routes = routeFixture({ repository });

  const response = await request(routes, "GET", "/api/ai-radar?period=day");

  assert.equal(response.status, 500);
  assert.deepEqual(response.body.error, { code: "RADAR_INTERNAL_ERROR", message: "雷达服务暂时不可用。" });
  assert.equal(JSON.stringify(response.body).includes("Vault"), false);
});

test("repository 404s remain safe 404 responses", async () => {
  const repository = fakeRepository({
    async revertPreference() {
      throw new RadarRepositoryError("RADAR_PREFERENCE_NOT_FOUND", "偏好记录不存在。", 404);
    },
  });
  const routes = routeFixture({ repository });

  const response = await request(routes, "POST", "/api/ai-radar/preferences/00000000-0000-4000-8000-000000000000/revert");

  assert.equal(response.status, 404);
  assert.deepEqual(response.body.error, { code: "RADAR_PREFERENCE_NOT_FOUND", message: "偏好记录不存在。" });
});

test("plugin middleware rejects cross-site radar mutations with the existing same-origin rule", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-radar-routes-"));
  const vaultRoot = path.join(root, "vault");
  const appDataRoot = path.join(root, "app-data");
  const middlewares = [];
  await mkdir(vaultRoot, { recursive: true });
  const directory = path.join(appDataRoot, "PersonalAIWorkbench");
  const registry = createWorkspaceRegistry({ directory });
  const fingerprint = createHash("sha256").update(path.resolve(vaultRoot).toLowerCase()).digest("hex");
  await registry.resolveVault({ fingerprint, label: "Synthetic radar vault" });
  const plugin = workbenchApiPlugin({
    vaultRoot,
    appDataRoot,
    radarOptions: {
      github: {
        async discoverCandidates() {
          return { repositories: [], errors: [], partial: false, retryAt: null, truncated: false };
        },
        async getRepositories() {
          return { repositories: [], errors: [], partial: false, retryAt: null, truncated: false };
        },
      },
    },
  });
  await plugin.configureServer({
    watcher: { on() {}, off() {} },
    httpServer: null,
    middlewares: { use(handler) { middlewares.push(handler); } },
    config: { logger: { error() {} } },
  });
  t.after(async () => {
    await plugin.closeBundle();
    await rm(root, { recursive: true, force: true });
  });

  const response = await (async () => {
    const req = {
      method: "POST",
      url: "/api/ai-radar/collect",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      async *[Symbol.asyncIterator]() {},
    };
    let status = 0;
    let payload = null;
    const res = {
      writeHead(value) { status = value; },
      end(value) { payload = value; },
    };
    await middlewares.at(-1)(req, res, () => {});
    return { status, body: JSON.parse(payload) };
  })();

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "LOCAL_API_ORIGIN_DENIED");
});

test("plugin hosted mode blocks radar mutations and reads safely", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-radar-hosted-"));
  const vaultRoot = path.join(root, "vault");
  const appDataRoot = path.join(root, "app-data");
  const middlewares = [];
  await mkdir(vaultRoot, { recursive: true });
  const plugin = workbenchApiPlugin({
    vaultRoot,
    appDataRoot,
    hosted: true,
  });
  await plugin.configureServer({
    watcher: { on() {}, off() {} },
    httpServer: null,
    middlewares: { use(handler) { middlewares.push(handler); } },
    config: { logger: { error() {} } },
  });
  t.after(async () => {
    await plugin.closeBundle();
    await rm(root, { recursive: true, force: true });
  });

  async function via(method, url, body) {
    const req = {
      method,
      url,
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield JSON.stringify(body);
      },
    };
    let status = 0;
    let payload = null;
    const res = {
      writeHead(value) { status = value; },
      end(value) { payload = value; },
    };
    await middlewares.at(-1)(req, res, () => {});
    return { status, body: payload === null ? null : JSON.parse(payload) };
  }

  const collect = await via("POST", "/api/ai-radar/collect");
  assert.equal(collect.status, 403);
  assert.equal(collect.body.error.code, "RADAR_READ_ONLY");

  const patch = await via("PATCH", "/api/ai-radar/schedule", { enabled: true });
  assert.equal(patch.status, 403);

  const dashboard = await via("GET", "/api/ai-radar?period=day");
  assert.equal(dashboard.status, 404);
  assert.equal(dashboard.body.error.code, "RADAR_UNAVAILABLE");
});

// Browser client contract -----------------------------------------------------

test("radar browser client emits exact request methods, urls, and JSON bodies", async () => {
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

  await api.loadRadar({ period: "day" });
  await api.loadRadar({ period: "week", state: "saved", focus: "agent" });
  await api.loadRadarStatus();
  await api.collectRadar();
  await api.updateRadarSchedule({ enabled: true, time: "08:00", timeZone: "Etc/UTC" });
  await api.setRadarDecision(9876, "saved");
  await api.loadRadarPreferences();
  await api.addRadarPreference({ repositoryId: null, kind: "topic", value: "agents", direction: "less" });
  await api.revertRadarPreference("11111111-2222-4333-8444-555555555555");
  await api.resetRadarPreferences();

  assert.deepEqual(calls.map(({ url, options }) => ({
    url,
    method: options.method,
    body: options.body && JSON.parse(options.body),
  })), [
    { url: "/api/ai-radar?period=day", method: "GET", body: undefined },
    { url: "/api/ai-radar?period=week&state=saved&focus=agent", method: "GET", body: undefined },
    { url: "/api/ai-radar/status", method: "GET", body: undefined },
    { url: "/api/ai-radar/collect", method: "POST", body: {} },
    { url: "/api/ai-radar/schedule", method: "PATCH", body: { enabled: true, time: "08:00", timeZone: "Etc/UTC" } },
    { url: "/api/ai-radar/repositories/9876/decision", method: "PUT", body: { status: "saved" } },
    { url: "/api/ai-radar/preferences", method: "GET", body: undefined },
    { url: "/api/ai-radar/preferences", method: "POST", body: { repositoryId: null, kind: "topic", value: "agents", direction: "less" } },
    { url: "/api/ai-radar/preferences/11111111-2222-4333-8444-555555555555/revert", method: "POST", body: {} },
    { url: "/api/ai-radar/preferences", method: "DELETE", body: {} },
  ]);
});

test("radar client surfaces safe server errors for the UI", async () => {
  const { WorkbenchApiError } = await import("../src/lib/api-errors.js");
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: "RADAR_INVALID_INPUT", message: "雷达输入格式无效。" } }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
  const api = await import("../src/lib/ai-radar-api.js");

  const failure = await api.updateRadarSchedule({ enabled: true }).then(
    () => null,
    (error) => error,
  );

  assert.ok(failure instanceof WorkbenchApiError);
  assert.equal(failure.status, 400);
  assert.equal(failure.code, "RADAR_INVALID_INPUT");
  assert.equal(failure.message, "雷达输入格式无效。");
});