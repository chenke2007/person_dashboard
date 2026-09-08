import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRadarRepository } from "../server/ai-radar/radar-repository.mjs";

const instant = "2026-09-02T06:00:00.000Z";
const now = () => new Date(instant);
const timeZone = "Asia/Shanghai";
const runId = "00000000-0000-4000-8000-000000000001";
function syntheticRepository(id = 101, patch = {}) {
  return { id, fullName: `synthetic/repository-${id}`, htmlUrl: `https://github.com/synthetic/repository-${id}`,
    description: "Synthetic demo repository", language: "JavaScript", topics: ["agents"], focusAreas: ["agent"],
    stars: 100, forks: 2, openIssues: null, archived: false, fork: false, license: "MIT", defaultBranch: "main",
    createdAt: "2025-01-01T00:00:00.000Z", updatedAt: instant, pushedAt: null, observedAt: instant, ...patch };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-radar-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "ai-radar");
  return { root, directory, radar: createRadarRepository({ directory, now, timeZone }) };
}
const snapshot = (repositoryId = 101, stars = 100) => ({ repositoryId, stars, forks: null, openIssues: null });
const isCode = (code) => (error) => error.code === code;

test("dashboard filters before all three cutoffs, excludes ignored by default and does not mutate", async (t) => {
  const { radar } = await fixture(t);
  await radar.upsertRepositories(Array.from({ length: 15 }, (_, index) => syntheticRepository(index + 1, {
    stars: 1000 - index, focusAreas: index === 14 ? [] : ["agent"], topics: index === 14 ? ["rag"] : ["agents"],
  })));
  await radar.setDecision(14, "saved"); await radar.setDecision(13, "ignored");
  const before = await radar.getState();
  const normal = await radar.getDashboard({ period: "day" });
  assert.equal(normal.lists.established.length, 8); assert.equal(normal.counts.all, 14); assert.equal(normal.counts.ignored, 1);
  assert.ok(normal.lists.relevant.every((entry) => entry.repositoryId !== 13));
  const saved = await radar.getDashboard({ state: "saved" });
  assert.equal(saved.lists.established[0].repositoryId, 14); assert.equal(saved.lists.rising[0].decision.status, "saved");
  assert.deepEqual(saved.filters, { state: "saved", focus: "all" });
  assert.equal((await radar.getDashboard({ state: "ignored" })).lists.established[0].repositoryId, 13);
  assert.equal((await radar.getDashboard({ focus: "rag-knowledge" })).lists.relevant[0].repositoryId, 15);
  await assert.rejects(radar.getDashboard({ period: "year" }), isCode("RADAR_INVALID_INPUT"));
  await assert.rejects(radar.getDashboard({ state: "deleted" }), isCode("RADAR_INVALID_INPUT"));
  assert.deepEqual(await radar.getState(), before);
});

test("collection commit rejects invalid payload atomically and older completion cannot regress metadata or control", async (t) => {
  const { radar } = await fixture(t);
  const start = (id, at) => ({ id, trigger: "manual", startedAt: at, finishedAt: null, status: "running", localDate: "2026-09-02", timeZone, repositoryCount: 0, errors: [] });
  const old = await radar.beginCollection(start(runId, "2026-09-02T00:00:00.000Z"));
  const recent = await radar.beginCollection(start("00000000-0000-4000-8000-000000000002", instant));
  const finish = (run) => ({ ...run, finishedAt: instant, status: "success", repositoryCount: 1 });
  const control = { retryAt: null, detailCursorId: 2, detailsFirst: true };
  await radar.commitCollection({ repositories: [syntheticRepository(101, { stars: 200 })], run: finish(recent), control });
  const before = await radar.getState();
  await assert.rejects(radar.commitCollection({ repositories: [syntheticRepository(101, { stars: -1 })], run: finish(old), control }));
  assert.deepEqual(await radar.getState(), before);
  await radar.commitCollection({ repositories: [syntheticRepository(101, { stars: 10, observedAt: "2026-09-02T00:00:00.000Z" })], run: finish(old), control: { ...control, detailCursorId: 1, detailsFirst: false } });
  const after = await radar.getState();
  assert.equal(after.repositories[0].stars, 200); assert.equal(after.snapshots[0].stars, 200);
  assert.equal(after.collection.detailCursorId, 2); assert.equal(after.schedule.lastSuccessAt, instant);
});

test("dashboard selected schedule timezone counts real observations at the durable as-of instant", async (t) => {
  const { radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository()]);
  await radar.recordSnapshots([snapshot(101, 80)], "2026-09-01T15:30:00.000Z", "UTC");
  await radar.recordSnapshots([snapshot(101, 100)], "2026-09-01T16:30:00.000Z", "UTC");
  // Persisted UTC day has one row; the selected local date must come from its actual instant.
  const board = await radar.getDashboard();
  assert.equal(board.timeZone, timeZone); assert.equal(board.localDate, "2026-09-02");
  assert.equal(board.lists.rising[0].coverage.observedDays, 1);
  assert.equal(board.lists.rising[0].latest.effectiveDate, "2026-09-02");
});

test("dashboard future imported observations do not move the usable as-of anchor", async (t) => {
  const { radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository()]);
  await radar.recordSnapshots([snapshot(101, 100)], instant, timeZone);
  await radar.recordSnapshots([snapshot(101, 999)], "2099-01-01T00:00:00.000Z", timeZone);
  const dashboard = await radar.getDashboard();
  assert.equal(dashboard.freshness.asOf, instant);
  assert.equal(dashboard.lists.rising[0].currentStars, 100);
});

test("absent reads and export return disabled local schedule without creating files or locks", async (t) => {
  const { directory, radar } = await fixture(t);
  assert.equal((await radar.getState()).version, 1);
  assert.deepEqual(await radar.getSchedule(), { enabled: false, time: "08:00", timeZone, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null });
  assert.equal((await radar.exportState()).repositories.length, 0);
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("round-trips repositories and keeps latest timestamp for one snapshot per local date", async (t) => {
  const { directory, radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository()]);
  await radar.recordSnapshots([snapshot(101, 105)], instant, timeZone);
  await radar.recordSnapshots([snapshot(101, 100)], "2026-09-02T00:00:00.000Z", timeZone);
  await radar.recordSnapshots([snapshot(101, 106)], "2026-09-02T08:00:00+02:00", timeZone);
  await radar.recordSnapshots([snapshot(101, null)], "2026-09-02T17:00:00.000Z", timeZone);
  const state = await createRadarRepository({ directory, now, timeZone }).getState();
  assert.equal(state.snapshots.length, 2);
  assert.deepEqual(state.snapshots.map(({ capturedDate, stars }) => [capturedDate, stars]), [["2026-09-02", 105], ["2026-09-03", null]]);
  assert.equal(state.snapshots[0].capturedAt, instant);
  await radar.upsertRepositories([syntheticRepository(101, { stars: 1, observedAt: "2025-01-01T00:00:00.000Z" })]);
  assert.equal((await radar.getState()).repositories[0].stars, 100);
});

test("strict imports reject unknown fields, versions, duplicate identities, orphan records and unsafe values", async (t) => {
  const { radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository()]);
  await radar.recordSnapshots([snapshot()], instant, timeZone);
  const baseline = await radar.getState();
  const invalid = [
    (s) => { s.version = 2; }, (s) => { s.extra = true; },
    (s) => { s.repositories.push(s.repositories[0]); },
    (s) => { s.repositories[0].headers = {}; },
    (s) => { s.repositories[0].readme = "Synthetic body"; },
    (s) => { s.repositories[0].description = "C:\\synthetic\\private"; },
    (s) => { s.repositories[0].stars = -1; },
    (s) => { s.repositories[0].htmlUrl = "https://example.invalid/repo"; },
    (s) => { s.snapshots[0].repositoryId = 404; },
    (s) => { s.snapshots[0].capturedDate = "2026-02-30"; },
    (s) => { s.snapshots[0].capturedDate = "2026-09-03"; },
    (s) => { s.schedule.timeZone = "Invalid/Zone"; },
  ];
  for (const change of invalid) {
    const input = structuredClone(baseline); change(input);
    await assert.rejects(radar.validateImport(input));
    await assert.rejects(radar.replaceState(input));
  }
  await assert.rejects(radar.recordSnapshots([snapshot(404)], instant, timeZone));
  assert.deepEqual(await radar.getState(), baseline);
});

test("failed writes preserve malformed bytes, staged recovery rolls back bytes, unknown versions never downgrade", async (t) => {
  const { directory, radar } = await fixture(t);
  const valid = await radar.exportState();
  await mkdir(directory);
  const target = path.join(directory, "radar.json");
  await writeFile(target, "{broken synthetic data");
  await assert.rejects(radar.upsertRepositories([syntheticRepository()]), isCode("RADAR_STORAGE_CORRUPT"));
  assert.equal(await readFile(target, "utf8"), "{broken synthetic data");
  const transaction = await radar.stageImport(valid);
  await transaction.commit(); await transaction.rollback(); await transaction.cleanup();
  assert.equal(await readFile(target, "utf8"), "{broken synthetic data");
  await radar.replaceState(valid);
  assert.deepEqual(await radar.getState(), valid);
  await writeFile(target, '{"version":2}');
  await assert.rejects(radar.replaceState(valid), isCode("RADAR_STORAGE_VERSION_UNSUPPORTED"));
  await assert.rejects(radar.getState(), isCode("RADAR_STORAGE_VERSION_UNSUPPORTED"));
  assert.equal(await readFile(target, "utf8"), '{"version":2}');
  assert.deepEqual((await readdir(directory)).sort(), ["radar.json", "radar.lock"]);
});

test("independent instances and processes serialize writers and preserve every repository", async (t) => {
  const { directory, radar } = await fixture(t);
  const other = createRadarRepository({ directory, now, timeZone });
  await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? radar : other).upsertRepositories([syntheticRepository(index + 1)])));
  const source = new URL("../server/ai-radar/radar-repository.mjs", import.meta.url).href;
  const run = promisify(execFile);
  await Promise.all([11, 12].map((id) => run(process.execPath, ["--input-type=module", "-e",
    `import { createRadarRepository } from ${JSON.stringify(source)}; await createRadarRepository({directory:process.argv[1],timeZone:'UTC'}).upsertRepositories([JSON.parse(process.argv[2])]);`, directory, JSON.stringify(syntheticRepository(id))])));
  assert.deepEqual((await radar.getState()).repositories.map(({ id }) => id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 11, 12]);
});

test("records runs, sticky decision preservation, reversible preferences and validated schedules", async (t) => {
  const { radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository()]);
  const run = { id: runId, trigger: "manual", startedAt: instant, finishedAt: null, status: "running", localDate: "2026-09-02", timeZone, repositoryCount: 0, errors: [] };
  await radar.recordRun(run);
  await radar.recordRun({ ...run, finishedAt: instant, status: "success", repositoryCount: 1 });
  assert.equal((await radar.getState()).runs.length, 1);
  await radar.setDecision(101, "saved");
  await radar.setDecision(101, "ignored");
  assert.equal((await radar.getState()).repositories[0].preservedAt, instant);
  assert.equal((await radar.getState()).decisions[0].status, "ignored");
  const pref = await radar.addPreference({ repositoryId: 101, kind: "topic", value: "agents", direction: "more" });
  await radar.revertPreference(pref.id);
  assert.equal((await radar.getState()).preferences[0].revertedAt, instant);
  await radar.addPreference({ repositoryId: null, kind: "language", value: "JavaScript", direction: "less" });
  await radar.resetPreferences();
  assert.equal((await radar.getState()).preferences.filter((p) => p.revertedAt === null).length, 0);
  await radar.updateSchedule({ enabled: true, time: "09:15", lastAttemptAt: instant });
  assert.equal((await radar.getSchedule()).time, "09:15");
  await assert.rejects(radar.updateSchedule({ time: "24:00" }));
  await assert.rejects(radar.setDecision(404, "saved"));
  await assert.rejects(radar.addPreference({ repositoryId: 404, kind: "topic", value: "agents", direction: "more" }));
});

test("lists only active preferences newest first and drops reverted ones", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-radar-pref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = Date.parse(instant);
  const radar = createRadarRepository({ directory: path.join(root, "ai-radar"), now: () => new Date((tick += 1000)), timeZone });
  await radar.upsertRepositories([syntheticRepository()]);
  const first = await radar.addPreference({ repositoryId: 101, kind: "topic", value: "agents", direction: "less" });
  const second = await radar.addPreference({ repositoryId: 101, kind: "language", value: "JavaScript", direction: "less" });
  const third = await radar.addPreference({ repositoryId: 101, kind: "topic", value: "rag", direction: "more" });
  await radar.revertPreference(third.id);

  const active = await radar.listPreferences();

  assert.deepEqual(active.map((preference) => preference.id), [second.id, first.id]);
  assert.ok(active.every((preference) => preference.revertedAt === null));
  assert.equal(active.some((preference) => preference.id === third.id), false);
});

test("retention aggregates actual old observations but preserves saved history and the 400 day boundary", async (t) => {
  const { radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository(), syntheticRepository(102)]);
  await radar.setDecision(102, "queued");
  for (const date of ["2025-07-01", "2025-07-29", "2025-07-30"]) {
    await radar.recordSnapshots([snapshot(101, date === "2025-07-01" ? null : 100), snapshot(102, 5)], `${date}T00:00:00.000Z`, "UTC");
  }
  await radar.applyRetention("2026-09-03");
  const state = await radar.getState();
  assert.equal(state.snapshots.filter((s) => s.repositoryId === 101).length, 1);
  assert.equal(state.snapshots.filter((s) => s.repositoryId === 102).length, 3);
  assert.equal(state.monthlyAggregates.length, 1);
  assert.deepEqual(state.monthlyAggregates[0].observedDates, ["2025-07-01", "2025-07-29"]);
  assert.equal(state.monthlyAggregates[0].first.stars, null);
  assert.equal(state.monthlyAggregates[0].last.stars, 100);
  await radar.applyRetention("2026-09-03");
  assert.deepEqual((await radar.getState()).monthlyAggregates, state.monthlyAggregates);
});

test("rejects linked store directories and ancestor junction escapes before creating outside state", async (t) => {
  const { root } = await fixture(t);
  const outside = path.join(root, "outside"); await mkdir(outside);
  const link = path.join(root, "linked");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  for (const directory of [link, path.join(link, "child")]) {
    const radar = createRadarRepository({ directory, now, timeZone });
    await assert.rejects(radar.getState(), isCode("RADAR_STORAGE_PATH_UNSAFE"));
    await assert.rejects(radar.upsertRepositories([syntheticRepository()]), isCode("RADAR_STORAGE_PATH_UNSAFE"));
  }
  assert.deepEqual(await readdir(outside), []);
});

test("bounded reads and collection limits reject oversized stores and imports", async (t) => {
  const { directory, radar } = await fixture(t);
  const state = await radar.getState();
  state.repositories = Array.from({ length: 10001 }, (_, i) => ({ ...syntheticRepository(i + 1), preservedAt: null }));
  await assert.rejects(radar.validateImport(state));
  await mkdir(directory);
  await writeFile(path.join(directory, "radar.json"), " ".repeat(32 * 1024 * 1024 + 1));
  await assert.rejects(radar.getState(), isCode("RADAR_STORAGE_CORRUPT"));
});

test("strict schema failures preserve typed errors and never retain sensitive metadata", async (t) => {
  const { directory, radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository()]);
  const baseline = await radar.getState();
  for (const change of [
    (s) => { s.repositories[0].topics = ["/synthetic/private"]; },
    (s) => { s.repositories[0].description = "Error reading C:\\synthetic\\private"; },
    (s) => { s.repositories[0].description = "Authorization: Bearer synthetic-example"; },
    (s) => { s.snapshots = [{ ...snapshot(), capturedAt: "invalid", capturedDate: "2026-09-02", timeZone }]; },
  ]) {
    const invalid = structuredClone(baseline); change(invalid);
    await assert.rejects(radar.validateImport(invalid), isCode("RADAR_STORAGE_CORRUPT"));
    await writeFile(path.join(directory, "radar.json"), JSON.stringify(invalid));
    await assert.rejects(radar.getState(), isCode("RADAR_STORAGE_CORRUPT"));
  }
});

test("staged restore holds its own lock until cleanup and rolls back before independent writers proceed", async (t) => {
  const { directory, radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository()]);
  const original = await radar.exportState();
  const replacement = structuredClone(original); replacement.schedule.time = "12:00";
  const transaction = await radar.stageImport(replacement);
  const other = createRadarRepository({ directory, now, timeZone });
  let finished = false;
  const writing = other.upsertRepositories([syntheticRepository(102)]).then(() => { finished = true; });
  try {
    await transaction.commit();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(finished, false);
    assert.equal(JSON.parse(await readFile(path.join(directory, "radar.json"), "utf8")).schedule.time, "12:00");
    await transaction.rollback();
  } finally { await transaction.cleanup(); }
  await writing;
  assert.equal((await radar.getState()).schedule.time, "08:00");
  assert.deepEqual((await radar.getState()).repositories.map(({ id }) => id), [101, 102]);
});

test("validateImport enforces byte budget before accepting data for backup preview", async (t) => {
  const { radar } = await fixture(t);
  const state = await radar.getState();
  await assert.rejects(radar.validateImport({ ...state, oversized: " ".repeat(32 * 1024 * 1024) }), isCode("RADAR_STORAGE_TOO_LARGE"));
});

test("retention supports actual local dates across timezone changes even when UTC order differs", async (t) => {
  const { radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository()]);
  await radar.recordSnapshots([snapshot(101, 10)], "2025-07-01T23:00:00.000Z", "Pacific/Honolulu");
  await radar.recordSnapshots([snapshot(101, 5)], "2025-07-01T11:00:00.000Z", "Pacific/Kiritimati");
  await radar.applyRetention("2026-09-03");
  const [aggregate] = (await radar.getState()).monthlyAggregates;
  assert.deepEqual(aggregate.observedDates, ["2025-07-01", "2025-07-02"]);
  assert.equal(aggregate.first.stars, 10);
  assert.equal(aggregate.last.stars, 5);
});

test("imports reject conflicting complete endpoints for one observed monthly date", async (t) => {
  const { radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository()]);
  await radar.recordSnapshots([snapshot()], "2025-01-01T00:00:00.000Z", timeZone);
  await radar.applyRetention("2026-09-03");
  const baseline = await radar.getState();
  for (const patch of [
    { stars: 999 }, { forks: 7 }, { openIssues: 8 },
    { capturedAt: "2025-01-01T06:00:00.000Z" }, { timeZone: "UTC" },
  ]) {
    const invalid = structuredClone(baseline);
    Object.assign(invalid.monthlyAggregates[0].last, patch);
    await assert.rejects(radar.validateImport(invalid), isCode("RADAR_STORAGE_CORRUPT"));
    await assert.rejects(radar.replaceState(invalid), isCode("RADAR_STORAGE_CORRUPT"));
  }
  assert.deepEqual(await radar.getState(), baseline);
});

test("single-date aggregate imports compare normalized observations and retain distinct dates normally", async (t) => {
  const { radar } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository()]);
  await radar.recordSnapshots([snapshot(101, 100)], "2025-01-01T00:00:00.000Z", timeZone);
  await radar.applyRetention("2026-09-03");
  const single = await radar.getState();
  assert.deepEqual(single.monthlyAggregates[0].first, single.monthlyAggregates[0].last);
  single.monthlyAggregates[0].last.capturedAt = "2025-01-01T08:00:00+08:00";
  const normalized = await radar.validateImport(single);
  assert.deepEqual(normalized.monthlyAggregates[0].first, normalized.monthlyAggregates[0].last);
  await radar.recordSnapshots([snapshot(101, 120)], "2025-01-02T00:00:00.000Z", timeZone);
  await radar.applyRetention("2026-09-03");
  const [aggregate] = (await radar.getState()).monthlyAggregates;
  assert.deepEqual(aggregate.observedDates, ["2025-01-01", "2025-01-02"]);
  assert.equal(aggregate.first.stars, 100);
  assert.equal(aggregate.last.stars, 120);
});
