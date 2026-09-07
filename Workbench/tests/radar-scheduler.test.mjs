import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRadarRepository } from "../server/ai-radar/radar-repository.mjs";
import { createRadarScheduler } from "../server/ai-radar/radar-scheduler.mjs";
import { radarLocalDate } from "../server/ai-radar/radar-schema.mjs";
import { createWorkspaceRegistry } from "../server/workspace-state/workspace-registry.mjs";
import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";

function schedule(overrides = {}) {
  return {
    enabled: true,
    time: "08:00",
    timeZone: "Asia/Shanghai",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    ...overrides,
  };
}

function createStore(initialSchedule = schedule(), { runs = [], retryAt = null } = {}) {
  const state = {
    schedule: structuredClone(initialSchedule),
    runs: structuredClone(runs),
    collection: { retryAt },
  };
  const patches = [];
  return {
    state,
    patches,
    async getSchedule() {
      return structuredClone(state.schedule);
    },
    async getState() {
      return structuredClone(state);
    },
    async updateSchedule(patch) {
      patches.push(structuredClone(patch));
      Object.assign(state.schedule, patch);
      return structuredClone(state.schedule);
    },
  };
}

function createClock(instant) {
  let value = new Date(instant);
  return {
    now: () => new Date(value),
    set(iso) {
      value = new Date(iso);
    },
  };
}

function createTimers() {
  let sequence = 0;
  const timers = new Map();
  const delays = [];
  return {
    delays,
    setTimeoutImpl(callback, delay) {
      const id = ++sequence;
      delays.push(delay);
      timers.set(id, callback);
      return id;
    },
    clearTimeoutImpl(id) {
      timers.delete(id);
    },
    get size() {
      return timers.size;
    },
    async fireNext() {
      const entry = timers.entries().next().value;
      assert.ok(entry, "expected an armed timer");
      timers.delete(entry[0]);
      await entry[1]();
    },
  };
}

function durableResult({ trigger, localDate, timeZone, status = "success", retryAt = null }) {
  return {
    persisted: true,
    retryAt,
    run: {
      id: "00000000-0000-4000-8000-000000000001",
      trigger,
      startedAt: "2026-09-02T00:00:00.000Z",
      finishedAt: "2026-09-02T00:00:01.000Z",
      status,
      localDate,
      timeZone,
      repositoryCount: 0,
      errors: status === "success" ? [] : [{ code: "GITHUB_HTTP_ERROR", message: "GitHub request failed." }],
      sequence: 1,
      collection: null,
    },
  };
}

function schedulerFixture({ instant, initialSchedule, state, collect } = {}) {
  const clock = createClock(instant ?? "2026-09-02T01:00:00.000Z");
  const timers = createTimers();
  const store = createStore(initialSchedule, state);
  const calls = [];
  const collectImpl = collect ?? (async ({ trigger }) => {
    calls.push({ trigger });
    return durableResult({
      trigger,
      localDate: radarLocalDate(clock.now(), store.state.schedule.timeZone),
      timeZone: store.state.schedule.timeZone,
    });
  });
  const scheduler = createRadarScheduler({
    collect: collectImpl,
    store,
    now: clock.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  return { scheduler, store, clock, timers, calls };
}

test("catches up once after the daily time and exposes tomorrow's run", async () => {
  const fixture = schedulerFixture();

  await fixture.scheduler.start();

  assert.deepEqual(fixture.calls, [{ trigger: "startup" }]);
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-03T00:00:00.000Z");
  assert.equal(fixture.timers.size, 1);
});

test("before-time startup waits for today's run and midnight remains on the intended local date", async () => {
  const success = durableResult({ trigger: "manual", localDate: "2026-09-01", timeZone: "Pacific/Kiritimati" }).run;
  const fixture = schedulerFixture({
    instant: "2026-09-01T09:30:00.000Z",
    initialSchedule: schedule({ time: "00:00", timeZone: "Pacific/Kiritimati" }),
    state: { runs: [success] },
  });

  await fixture.scheduler.start();

  assert.deepEqual(fixture.calls, []);
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-01T10:00:00.000Z");
});

test("disabled schedules remain idle while manual collection still runs", async () => {
  const fixture = schedulerFixture({ initialSchedule: schedule({ enabled: false }) });

  await fixture.scheduler.start();
  const manual = await fixture.scheduler.runNow();

  assert.equal(manual.run.trigger, "manual");
  assert.deepEqual(fixture.calls, [{ trigger: "manual" }]);
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, null);
  assert.equal(fixture.timers.size, 0);
});

test("a resolved non-durable or partial collection does not advance the successful day", async () => {
  let attempts = 0;
  const fixture = schedulerFixture({
    collect: async ({ trigger }) => {
      attempts += 1;
      const result = durableResult({ trigger, localDate: "2026-09-02", timeZone: "Asia/Shanghai", status: attempts === 1 ? "success" : "partial" });
      if (attempts === 1) result.persisted = false;
      return result;
    },
  });

  await fixture.scheduler.start();

  assert.equal(attempts, 1);
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-02T01:15:00.000Z");
  fixture.clock.set("2026-09-02T01:15:00.000Z");
  await fixture.scheduler.runDue();
  assert.equal(attempts, 2);
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-02T01:30:00.000Z");
});

test("rate-limit retryAt defers attempts without a busy loop", async () => {
  const fixture = schedulerFixture({
    collect: async ({ trigger }) => durableResult({
      trigger,
      localDate: "2026-09-02",
      timeZone: "Asia/Shanghai",
      status: "failed",
      retryAt: "2026-09-02T03:00:00.000Z",
    }),
  });

  await fixture.scheduler.start();
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-02T03:00:00.000Z");
  await fixture.scheduler.runDue();
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-02T03:00:00.000Z");
});

test("durable same-day success prevents duplicate startup catch-up", async () => {
  const success = durableResult({ trigger: "manual", localDate: "2026-09-02", timeZone: "Asia/Shanghai" }).run;
  const fixture = schedulerFixture({ state: { runs: [success] } });

  await fixture.scheduler.start();

  assert.deepEqual(fixture.calls, []);
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-03T00:00:00.000Z");
});

test("refreshSchedule clears the old timer and applies changed time and timezone", async () => {
  const fixture = schedulerFixture({
    instant: "2026-09-02T12:00:00.000Z",
    initialSchedule: schedule({ time: "21:00" }),
  });
  await fixture.scheduler.start();
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-02T13:00:00.000Z");

  Object.assign(fixture.store.state.schedule, { time: "09:30", timeZone: "America/New_York", nextRunAt: null });
  await fixture.scheduler.refreshSchedule();

  assert.equal(fixture.timers.size, 1);
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-02T13:30:00.000Z");
});

test("refreshSchedule runs a newly enabled schedule when today's time is already due", async () => {
  const fixture = schedulerFixture({ initialSchedule: schedule({ enabled: false }) });
  await fixture.scheduler.start();
  fixture.store.state.schedule.enabled = true;

  await fixture.scheduler.refreshSchedule();

  assert.deepEqual(fixture.calls, [{ trigger: "schedule" }]);
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-03T00:00:00.000Z");
});

test("DST gaps use the first valid instant after the gap and folds use the first occurrence", async () => {
  const gap = schedulerFixture({
    instant: "2026-03-07T12:00:00.000Z",
    initialSchedule: schedule({ time: "02:30", timeZone: "America/New_York" }),
  });
  await gap.scheduler.start();
  assert.equal((await gap.scheduler.getStatus()).nextRunAt, "2026-03-08T07:00:00.000Z");

  const fold = schedulerFixture({
    instant: "2026-10-31T12:00:00.000Z",
    initialSchedule: schedule({ time: "01:30", timeZone: "America/New_York" }),
  });
  await fold.scheduler.start();
  assert.equal((await fold.scheduler.getStatus()).nextRunAt, "2026-11-01T05:30:00.000Z");
});

test("long timers are capped and rechecking after a clock jump runs the due collection", async () => {
  const fixture = schedulerFixture({
    instant: "2026-09-01T00:00:00.000Z",
    initialSchedule: schedule({ time: "23:00" }),
  });
  await fixture.scheduler.start();
  assert.ok(fixture.timers.delays[0] <= 6 * 60 * 60 * 1000);

  fixture.clock.set("2026-09-02T15:30:00.000Z");
  await fixture.timers.fireNext();

  assert.deepEqual(fixture.calls, [{ trigger: "schedule" }]);
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, "2026-09-03T15:00:00.000Z");
});

test("concurrent triggers coalesce and stop invalidates timers before awaiting the collector", async () => {
  let release;
  let calls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const fixture = schedulerFixture({
    collect: async ({ trigger }) => {
      calls += 1;
      await blocked;
      return durableResult({ trigger, localDate: "2026-09-02", timeZone: "Asia/Shanghai" });
    },
  });

  const first = fixture.scheduler.runNow();
  const second = fixture.scheduler.runDue();
  await Promise.resolve();
  assert.equal(calls, 1);
  const stopping = fixture.scheduler.stop();
  assert.equal(fixture.timers.size, 0);
  release();
  assert.strictEqual(await second, await first);
  await stopping;
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, null);
});

test("timer failures are handled and exposed without leaking thrown details", async () => {
  const fixture = schedulerFixture({ collect: async () => { throw new Error("synthetic-secret"); } });

  await fixture.scheduler.start();

  const status = await fixture.scheduler.getStatus();
  assert.deepEqual(status.error, { code: "RADAR_SCHEDULER_RUN_FAILED", message: "AI Radar collection failed." });
  assert.equal(JSON.stringify(status).includes("synthetic-secret"), false);
  assert.equal(status.nextRunAt, "2026-09-02T01:15:00.000Z");
});

test("stop and restart are idempotent and do not leave orphan timers", async () => {
  const fixture = schedulerFixture({ instant: "2026-09-01T00:00:00.000Z" });
  await Promise.all([fixture.scheduler.start(), fixture.scheduler.start()]);
  assert.equal(fixture.timers.size, 1);

  await Promise.all([fixture.scheduler.stop(), fixture.scheduler.stop()]);
  assert.equal(fixture.timers.size, 0);
  assert.equal((await fixture.scheduler.getStatus()).nextRunAt, null);

  await fixture.scheduler.start();
  assert.equal(fixture.timers.size, 1);
});

async function pluginLifecycleFixture(t, { projectReadOnly = false, hosted = false, prebind = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-radar-lifecycle-"));
  const vaultRoot = path.join(root, "vault");
  const appDataRoot = path.join(root, "app-data");
  const events = [];
  const schedulers = [];
  const middlewares = [];
  await mkdir(vaultRoot, { recursive: true });
  if (prebind && !hosted) {
    const directory = path.join(appDataRoot, "PersonalAIWorkbench");
    const registry = createWorkspaceRegistry({ directory });
    const fingerprint = createHash("sha256").update(path.resolve(vaultRoot).toLowerCase()).digest("hex");
    await registry.resolveVault({ fingerprint, label: "vault" });
  }
  const plugin = workbenchApiPlugin({
    vaultRoot,
    appDataRoot,
    projectReadOnly,
    hosted,
    radarOptions: {
      createScheduler() {
        const scheduler = {
          async start() { events.push(["start", schedulers.indexOf(scheduler)]); },
          async stop() { events.push(["stop", schedulers.indexOf(scheduler)]); },
        };
        schedulers.push(scheduler);
        return scheduler;
      },
    },
  });
  const closeListeners = [];
  await plugin.configureServer({
    watcher: { on() {}, off() {} },
    httpServer: { once(event, callback) { if (event === "close") closeListeners.push(callback); } },
    middlewares: { use(handler) { middlewares.push(handler); } },
    config: { logger: { error() {} } },
  });
  t.after(async () => {
    await plugin.closeBundle();
    await rm(root, { recursive: true, force: true });
  });
  async function request(url, body) {
    const raw = JSON.stringify(body);
    const req = {
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() { yield raw; },
    };
    let status;
    let responseBody;
    const res = {
      writeHead(value) { status = value; },
      end(value) { responseBody = value; },
    };
    await middlewares.at(-1)(req, res, () => {});
    return { status, body: JSON.parse(responseBody) };
  }
  return { root, vaultRoot, appDataRoot, events, schedulers, plugin, request, close: async () => Promise.all(closeListeners.map((listener) => listener())) };
}

test("plugin starts only with mutable local radar capability and closes its scheduler", async (t) => {
  const mutable = await pluginLifecycleFixture(t);
  assert.deepEqual(mutable.events, [["start", 0]]);
  await mutable.close();
  assert.deepEqual(mutable.events, [["start", 0], ["stop", 0]]);

  const readOnly = await pluginLifecycleFixture(t, { projectReadOnly: true });
  const hosted = await pluginLifecycleFixture(t, { hosted: true });
  assert.deepEqual(readOnly.events, []);
  assert.deepEqual(hosted.events, []);
});

test("disabled Radar startup does not create an unbound workspace or scheduler", async (t) => {
  const fixture = await pluginLifecycleFixture(t, { prebind: false });

  assert.deepEqual(fixture.events, []);
  await assert.rejects(access(path.join(fixture.appDataRoot, "PersonalAIWorkbench")), { code: "ENOENT" });
});

test("plugin schedule helper replaces the timezone-bound collector lifecycle", async (t) => {
  const fixture = await pluginLifecycleFixture(t);

  const updated = await fixture.plugin.api.radar.updateSchedule({ timeZone: "Pacific/Kiritimati" });

  assert.equal(updated.timeZone, "Pacific/Kiritimati");
  assert.deepEqual(fixture.plugin.api.radar.capabilities, { read: true, collect: true, schedule: true });
  assert.deepEqual(fixture.events.slice(0, 3), [["start", 0], ["stop", 0], ["start", 1]]);
});

test("plugin stops the old scheduler before workspace rebind and starts a replacement", async (t) => {
  const fixture = await pluginLifecycleFixture(t);
  const registryDirectory = path.join(fixture.appDataRoot, "PersonalAIWorkbench");
  const registry = createWorkspaceRegistry({ directory: registryDirectory });
  const fingerprint = createHash("sha256").update(path.resolve(fixture.vaultRoot).toLowerCase()).digest("hex");
  const current = await registry.resolveVault({ fingerprint, label: "Synthetic current radar workspace" });
  const candidate = await registry.resolveVault({ fingerprint: "f".repeat(64), label: "Synthetic radar target" });
  await createRadarRepository({
    directory: path.join(registryDirectory, "workspaces", candidate.workspaceId, "ai-radar"),
    timeZone: "UTC",
  }).updateSchedule({ enabled: false });
  const preview = await registry.previewRebind({ currentFingerprint: fingerprint, workspaceId: candidate.workspaceId });

  const response = await fixture.request("/api/workspace/rebind/confirm", { token: preview.token });

  assert.ok(current);
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.events.slice(0, 3), [["start", 0], ["stop", 0], ["start", 1]]);
});

test("failed workspace rebind restarts the scheduler it quiesced", async (t) => {
  const fixture = await pluginLifecycleFixture(t);

  const response = await fixture.request("/api/workspace/rebind/confirm", { token: "x".repeat(32) });

  assert.equal(response.status, 400);
  assert.deepEqual(fixture.events.slice(0, 3), [["start", 0], ["stop", 0], ["start", 0]]);
});
