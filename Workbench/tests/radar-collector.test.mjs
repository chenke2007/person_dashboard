import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRadarRepository } from "../server/ai-radar/radar-repository.mjs";
import { createRadarCollector } from "../server/ai-radar/radar-collector.mjs";
import { createGitHubRadarClient } from "../server/ai-radar/github-client.mjs";

const timeZone = "Asia/Shanghai";
const initial = "2026-09-02T16:30:00.000Z";
const batch = (repositories = [], patch = {}) => ({ repositories, errors: [], partial: false, retryAt: null, truncated: false, ...patch });
const repo = (id = 1, observedAt = initial, patch = {}) => ({ id, fullName: `synthetic/demo-${id}`, htmlUrl: `https://github.com/synthetic/demo-${id}`,
  description: "Synthetic demo", language: "JavaScript", topics: ["ai-agents"], focusAreas: ["agent"], stars: 100, forks: 2, openIssues: null,
  archived: false, fork: false, license: "MIT", defaultBranch: "main", createdAt: null, updatedAt: null, pushedAt: null, observedAt, preservedAt: null, ...patch });
async function fixture(t) {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "radar-collector-synthetic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let instant = initial;
  const now = () => new Date(instant);
  const repository = createRadarRepository({ directory, now, timeZone });
  return { directory, repository, now, setTime: (value) => { instant = value; } };
}
function client(discoverCandidates, getRepositories = async () => { throw new Error("Unexpected duplicate detail work"); }) { return { discoverCandidates, getRepositories }; }
function collector(f, github, options = {}) { return createRadarCollector({ github, repository: f.repository, now: f.now, timeZone, focusAreas: ["agent"], ...options }); }

test("commits fresh discovery and same-day upserts with local success and retention atomically", async (t) => {
  const f = await fixture(t);
  const c = collector(f, client(async (input) => { assert.deepEqual(input.focusAreas, ["agent"]); return batch([repo(1, f.now().toISOString())]); }));
  const first = await c.collect({ trigger: "startup" });
  assert.equal(first.run.status, "success"); assert.equal(first.persisted, true);
  assert.equal(first.run.localDate, "2026-09-03");
  f.setTime("2026-09-02T17:00:00.000Z");
  await c.collect({ trigger: "manual" });
  const s = await createRadarRepository({ directory: f.directory, now: f.now, timeZone }).getState();
  assert.equal(s.snapshots.length, 1); assert.equal(s.repositories.length, 1); assert.equal(s.runs.length, 2);
  assert.equal(s.snapshots[0].capturedAt, "2026-09-02T17:00:00.000Z");
  assert.equal(s.schedule.lastSuccessAt, "2026-09-02T17:00:00.000Z");
  assert.equal(s.retention.lastAppliedDate, "2026-09-03");
  assert.equal((await f.repository.getDashboard()).lists.established[0].repositoryId, 1);
});

test("partial detail failures keep valid observations; total failure keeps previous lists and success date", async (t) => {
  const f = await fixture(t);
  await collector(f, client(async () => batch([repo(1), repo(2)]))).collect({ trigger: "manual" });
  await f.repository.setDecision(2, "saved");
  f.setTime("2026-09-03T17:00:00.000Z");
  const bad = { fullName: "synthetic/demo-2", code: "GITHUB_HTTP_ERROR", message: "Authorization: secret synthetic", retryAt: null };
  const partial = await collector(f, client(async () => batch([repo(1, f.now().toISOString(), { stars: 120 })]), async () => batch([], { partial: true, errors: [bad] }))).collect({ trigger: "schedule" });
  assert.equal(partial.run.status, "partial"); assert.equal(partial.run.repositoryCount, 1);
  const before = await f.repository.getDashboard();
  f.setTime("2026-09-04T17:00:00.000Z");
  const failed = await collector(f, client(async () => { throw { code: "secret", message: "Authorization: synthetic" }; }, async () => { throw "private synthetic input"; })).collect({ trigger: "manual" });
  const after = await f.repository.getDashboard();
  assert.equal(failed.run.status, "failed");
  assert.deepEqual(after.lists, before.lists); assert.equal(after.freshness.lastSuccessAt, initial);
  assert.equal(after.run.status, "failed");
  assert.equal(after.freshness.stale, true); assert.equal(after.freshness.asOf, "2026-09-03T17:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(after), /Authorization|private synthetic input|secret/);
});

test("coalesces concurrent triggers without a network-held store lock and preserves independent decisions", async (t) => {
  const f = await fixture(t);
  await f.repository.upsertRepositories([repo()]);
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  const c = collector(f, client(async () => { requests++; entered(); await barrier; return batch([repo()]); }));
  const first = c.collect({ trigger: "schedule" });
  await waiting;
  const second = c.collect({ trigger: "manual" });
  const independent = createRadarRepository({ directory: f.directory, now: f.now, timeZone });
  await independent.setDecision(1, "saved");
  assert.equal((await f.repository.getDashboard()).run.status, "running");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.run.id, b.run.id); assert.equal(b.run.trigger, "schedule"); assert.equal(requests, 1);
  const s = await independent.getState(); assert.equal(s.runs.length, 1);
  assert.equal(s.decisions[0].status, "saved"); assert.equal(s.repositories[0].preservedAt, initial);
});

test("failed collection persistence never advances success or replaces usable snapshots", async (t) => {
  const f = await fixture(t);
  await collector(f, client(async () => batch([repo()]))).collect({ trigger: "manual" });
  const before = await f.repository.getState();
  f.setTime("2026-09-03T17:00:00.000Z");
  const failing = { ...f.repository, commitCollection: async () => { throw new Error("synthetic storage path must not leak"); } };
  const result = await collector(f, client(async () => batch([repo(1, f.now().toISOString(), { stars: 999 })])), { repository: failing }).collect({ trigger: "manual" });
  const after = await f.repository.getState();
  assert.equal(result.run.status, "failed"); assert.equal(result.persisted, false);
  assert.equal(after.schedule.lastSuccessAt, before.schedule.lastSuccessAt); assert.deepEqual(after.snapshots, before.snapshots);
  assert.doesNotMatch(JSON.stringify(result), /synthetic storage path/);
});

test("cooldown persists across collectors and tracked rotation survives fixed clocks and repeated rate limits", async (t) => {
  const f = await fixture(t);
  await f.repository.upsertRepositories([repo(1), repo(2), repo(3)]);
  for (const id of [1, 2, 3]) await f.repository.setDecision(id, "saved");
  const names = [];
  const deadline = "2026-09-02T17:00:00.000Z";
  let limited = true;
  const github = client(async () => batch(), async ({ repositories }) => {
    names.push(repositories[0].fullName);
    if (limited) return batch([], { partial: true, retryAt: deadline, errors: [{ fullName: repositories[0].fullName, code: "GITHUB_RATE_LIMITED", message: "safe", retryAt: deadline }] });
    return batch(repositories.map((r) => repo(Number(r.fullName.split("-").at(-1)), f.now().toISOString())));
  });
  const first = await collector(f, github, { maxDetails: 1 }).collect({ trigger: "manual" });
  assert.equal(first.run.status, "failed"); assert.equal(first.retryAt, deadline);
  const blocked = await collector(f, client(async () => { throw new Error("Cooldown request escaped"); }), { maxDetails: 1 }).collect({ trigger: "startup" });
  assert.equal(blocked.run.status, "skipped"); assert.equal(blocked.retryAt, deadline);
  f.setTime(deadline); limited = false;
  for (let n = 0; n < 3; n++) {
    const result = await collector(f, github, { maxDetails: 1 }).collect({ trigger: "manual" });
    assert.equal(result.run.status, "success"); assert.equal(result.run.collection.deferredCount, 2);
  }
  assert.deepEqual(names, ["synthetic/demo-1", "synthetic/demo-2", "synthetic/demo-3", "synthetic/demo-1"]);
});

test("deliberate discovery bounds remain successful with truncation reported separately", async (t) => {
  const f = await fixture(t);
  const result = await collector(f, client(async () => batch([repo()], { truncated: true }))).collect({ trigger: "manual" });
  assert.equal(result.run.status, "success"); assert.equal(result.run.collection.truncated, true);
  assert.equal((await f.repository.getState()).schedule.lastSuccessAt, initial);
});

test("a tracked-first round survives discovery cooldown and only attempted details advance the ring", async (t) => {
  const f = await fixture(t);
  await f.repository.upsertRepositories([repo(1), repo(2), repo(3)]);
  for (const id of [1, 2, 3]) await f.repository.setDecision(id, "saved");
  let deadline = "2026-09-02T17:00:00.000Z";
  const names = [];
  const github = client(async () => batch([], { partial: true, retryAt: deadline,
    errors: [{ fullName: null, code: "GITHUB_PRIMARY_RATE_LIMIT", message: "synthetic", retryAt: deadline }] }),
  async ({ repositories }) => {
    names.push(repositories.map((r) => r.fullName));
    return batch([], { partial: true, retryAt: deadline, errors: [{ fullName: repositories[0].fullName, code: "GITHUB_PRIMARY_RATE_LIMIT", message: "synthetic", retryAt: deadline }] });
  });
  await collector(f, github, { maxDetails: 2 }).collect({ trigger: "manual" });
  assert.deepEqual(names, []);
  f.setTime(deadline); deadline = "2026-09-02T18:00:00.000Z";
  await collector(f, github, { maxDetails: 2 }).collect({ trigger: "manual" });
  assert.deepEqual(names, [["synthetic/demo-1", "synthetic/demo-2"]]);
  assert.equal((await f.repository.getState()).collection.detailCursorId, 1);
  f.setTime(deadline); deadline = "2026-09-02T19:00:00.000Z";
  await collector(f, github, { maxDetails: 2 }).collect({ trigger: "manual" });
  f.setTime(deadline); deadline = "2026-09-02T20:00:00.000Z";
  await collector(f, github, { maxDetails: 2 }).collect({ trigger: "manual" });
  assert.deepEqual(names[1], ["synthetic/demo-2", "synthetic/demo-3"]);
});

test("old cached and future metadata are not fresh observations, and hostile thrown values stay safe", async (t) => {
  const f = await fixture(t);
  await collector(f, client(async () => batch([repo()]))).collect({ trigger: "manual" });
  f.setTime("2026-09-03T17:00:00.000Z");
  const invalid = await collector(f, client(async () => batch([repo(), repo(2, "2099-01-01T00:00:00.000Z")]))).collect({ trigger: "manual" });
  assert.equal(invalid.run.status, "failed"); assert.equal(invalid.run.repositoryCount, 0);
  assert.equal((await f.repository.getState()).snapshots.length, 1);
  const hostile = { code: { [Symbol.toPrimitive]() { throw new Error("synthetic private value"); } } };
  const safe = await collector(f, client(async () => { throw hostile; })).collect({ trigger: "manual" });
  assert.equal(safe.run.status, "failed"); assert.equal(safe.persisted, true);
  assert.doesNotMatch(JSON.stringify(safe), /synthetic private value/);
});

test("hostile batch error metadata is sanitized and the durable run still terminates", async (t) => {
  const f = await fixture(t);
  const hostile = { code: "GITHUB_HTTP_ERROR", message: "safe synthetic error", retryAt: null };
  Object.defineProperty(hostile, "fullName", { get() { throw new Error("HOSTILE_BATCH_FIELD"); } });
  const result = await collector(f, client(async () => batch([], { partial: true, errors: [hostile] }))).collect({ trigger: "manual" });
  assert.equal(result.run.status, "failed"); assert.equal(result.persisted, true);
  assert.deepEqual(result.run.errors, [{ code: "GITHUB_HTTP_ERROR", message: "GitHub request failed." }]);
  const state = await f.repository.getState();
  assert.equal(state.runs.length, 1); assert.equal(state.runs[0].status, "failed");
  assert.doesNotMatch(JSON.stringify({ result, state }), /HOSTILE_BATCH_FIELD|safe synthetic error/);
});

test("collector retention aggregates only actual unprotected history and keeps saved history sticky", async (t) => {
  const f = await fixture(t);
  await f.repository.upsertRepositories([repo(1), repo(2)]);
  await f.repository.recordSnapshots([{ repositoryId: 1, stars: 5, forks: null, openIssues: null }, { repositoryId: 2, stars: 6, forks: null, openIssues: null }], "2024-01-01T00:00:00.000Z", timeZone);
  await f.repository.setDecision(2, "saved"); await f.repository.setDecision(2, "ignored");
  await collector(f, client(async () => batch([repo(1), repo(2)]))).collect({ trigger: "manual" });
  const state = await f.repository.getState();
  assert.equal(state.monthlyAggregates.length, 1); assert.deepEqual(state.monthlyAggregates[0].observedDates, ["2024-01-01"]);
  assert.ok(state.snapshots.some((s) => s.repositoryId === 2 && s.capturedDate === "2024-01-01"));
});

test("real validated network 304 records a new day, while failed conditional fetch adds no snapshot", async (t) => {
  const f = await fixture(t); let calls = 0;
  const payload = { total_count: 1, incomplete_results: false, items: [{ id: 1, full_name: "synthetic/demo-1", html_url: "https://github.com/synthetic/demo-1", archived: false, fork: false, stargazers_count: 100 }] };
  const github = createGitHubRadarClient({ now: f.now, fetchImpl: async (_url, options) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify(payload), { headers: { etag: '"synthetic"' } });
    assert.equal(options.headers["If-None-Match"], '"synthetic"');
    return new Response(null, { status: calls === 2 ? 304 : 500 });
  } });
  const c = collector(f, github);
  await c.collect({ trigger: "manual" });
  f.setTime("2026-09-03T17:00:00.000Z");
  const revalidated = await c.collect({ trigger: "manual" }); assert.equal(revalidated.run.status, "success");
  f.setTime("2026-09-04T17:00:00.000Z");
  assert.equal((await c.collect({ trigger: "manual" })).run.status, "failed");
  const state = await f.repository.getState(); assert.equal(state.snapshots.length, 2);
  assert.equal(state.snapshots[1].capturedAt, "2026-09-03T17:00:00.000Z");
  assert.doesNotMatch(await readFile(path.join(f.directory, "radar.json"), "utf8"), /etag|If-None-Match/);
});
