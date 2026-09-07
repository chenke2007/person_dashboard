import assert from "node:assert/strict";
import test from "node:test";

import { projectRadarDashboard } from "../src/lib/ai-radar-model.js";

function repository(id, overrides = {}) {
  return {
    id,
    fullName: `synthetic/repo-${id}`,
    htmlUrl: `https://github.com/synthetic/repo-${id}`,
    description: `Synthetic repository ${id}`,
    language: "TypeScript",
    topics: [],
    license: "MIT",
    stars: 100 + id,
    forks: 2,
    openIssues: 1,
    archived: false,
    fork: false,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    pushedAt: "2026-09-01T00:00:00.000Z",
    observedAt: "2026-09-02T01:00:00.000Z",
    preservedAt: null,
    focusAreas: ["agent"],
    ...overrides,
  };
}

function risingEntry(id, overrides = {}) {
  return {
    repositoryId: id,
    repository: repository(id),
    status: "complete",
    observedStarDelta: id,
    currentStars: 100 + id,
    coverage: { observedDays: 1, expectedDays: 1, missingDays: 0, complete: true },
    baseline: { effectiveDate: "2026-09-01", stars: 100 },
    latest: { effectiveDate: "2026-09-02", stars: 100 + id },
    reasons: [`观测 Star 变化：+${id}。`, "与 1 天前基线相比。"],
    decision: { repositoryId: id, status: "unread", updatedAt: null },
    ...overrides,
  };
}

function establishedEntry(id, overrides = {}) {
  return {
    repositoryId: id,
    repository: repository(id),
    currentStars: 100 + id,
    maintainedAt: "2026-09-01T00:00:00.000Z",
    license: "MIT",
    preservedHistory: false,
    reasons: [`当前 Star：${100 + id}。`, "最近维护：2026-09-01。"],
    decision: { repositoryId: id, status: "unread", updatedAt: null },
    ...overrides,
  };
}

function relevantEntry(id, overrides = {}) {
  return {
    repositoryId: id,
    repository: repository(id),
    focusAreas: ["agent"],
    focusMatch: { level: "explicit", directions: ["agent"], reasons: ["明确关注方向：agent。"] },
    preferenceMatches: { more: [], less: [] },
    classifierRelevance: null,
    reasons: ["明确关注方向：agent。"],
    decision: { repositoryId: id, status: "unread", updatedAt: null },
    ...overrides,
  };
}

function payload(overrides = {}) {
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
    run: { id: "00000000-0000-4000-8000-000000000001", trigger: "startup", status: "success", localDate: "2026-09-02", timeZone: "Etc/UTC", sequence: 1 },
    schedule: { enabled: true, time: "08:00", timeZone: "Etc/UTC", lastAttemptAt: null, lastSuccessAt: null, nextRunAt: "2026-09-03T08:00:00.000Z" },
    ...overrides,
  };
}

function entries(n, entryFactory) {
  return Array.from({ length: n }, (_, index) => entryFactory(index + 1));
}

test("period view limits cap the projected cards at 8, 12, and 20", () => {
  const base = payload({ lists: { rising: entries(25, risingEntry), established: [], relevant: [] } });

  const day = projectRadarDashboard(base, { period: "day", list: "rising" });
  assert.equal(day.viewLimit, 8);
  assert.equal(day.cards.length, 8);
  assert.deepEqual(day.cards.map((card) => card.repositoryId), [1, 2, 3, 4, 5, 6, 7, 8]);

  const week = projectRadarDashboard(base, { period: "week", list: "rising" });
  assert.equal(week.cards.length, 12);
  assert.deepEqual(week.cards.map((card) => card.repositoryId)[11], 12);

  const month = projectRadarDashboard(base, { period: "month", list: "rising" });
  assert.equal(month.cards.length, 20);
  assert.deepEqual(month.cards.map((card) => card.repositoryId).at(-1), 20);
});

test("the model preserves server list order without re-sorting", () => {
  const unordered = [risingEntry(9), risingEntry(2), risingEntry(5), risingEntry(1)];
  const base = payload({ lists: { rising: unordered, established: [], relevant: [] } });

  const view = projectRadarDashboard(base, { period: "day", list: "rising" });

  assert.deepEqual(view.cards.map((card) => card.repositoryId), [9, 2, 5, 1]);
});

test("the model does not mutate the input payload", () => {
  const future = payload({ lists: { rising: entries(6, risingEntry), established: [], relevant: [] } });
  const original = structuredClone(future);

  projectRadarDashboard(future, { period: "week", list: "rising" });
  projectRadarDashboard(future, { period: "day", list: "rising", state: "saved" });

  assert.deepEqual(future, original);
});

test("each list projects stable card fields from the server entry", () => {
  const rising = risingEntry(7, {
    observedStarDelta: 42,
    status: "incomplete",
    coverage: { observedDays: 3, expectedDays: 7, missingDays: 4, complete: false },
    decision: { repositoryId: 7, status: "saved", updatedAt: "2026-09-02T00:30:00.000Z" },
  });
  const base = payload({ lists: { rising: [rising], established: [establishedEntry(7)], relevant: [] } });

  const risingCard = projectRadarDashboard(base, { period: "day", list: "rising" }).cards[0];
  assert.deepEqual(risingCard, {
    repositoryId: 7,
    fullName: "synthetic/repo-7",
    htmlUrl: "https://github.com/synthetic/repo-7",
    description: "Synthetic repository 7",
    language: "TypeScript",
    topics: [],
    license: "MIT",
    archived: false,
    fork: false,
    focusAreas: ["agent"],
    stars: 107,
    observedStarDelta: 42,
    trendStatus: "incomplete",
    coverage: { observedDays: 3, expectedDays: 7, missingDays: 4, complete: false },
    maintainedAt: "2026-09-01T00:00:00.000Z",
    reasons: ["观测 Star 变化：+7。", "与 1 天前基线相比。"],
    decisionStatus: "saved",
    decisionUpdatedAt: "2026-09-02T00:30:00.000Z",
  });

  const establishedCard = projectRadarDashboard(base, { period: "day", list: "established" }).cards[0];
  assert.equal(establishedCard.observedStarDelta, null);
  assert.equal(establishedCard.currentStars, undefined);
  assert.equal(establishedCard.stars, 107);
  assert.equal(establishedCard.maintainedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(establishedCard.reasons[0], "当前 Star：107。");

  const relevantCard = projectRadarDashboard(payload({ lists: { rising: [], established: [], relevant: [relevantEntry(7)] } }), { period: "day", list: "relevant" }).cards[0];
  assert.equal(relevantCard.focusAreas[0], "agent");
  assert.deepEqual(relevantCard.reasons, ["明确关注方向：agent。"]);
});

test("state filtering keeps only matching decisions while all keeps everything", () => {
  const list = [
    risingEntry(1, { decision: { repositoryId: 1, status: "saved", updatedAt: "2026-09-02T00:00:00.000Z" } }),
    risingEntry(2, { decision: { repositoryId: 2, status: "ignored", updatedAt: "2026-09-02T00:00:00.000Z" } }),
    risingEntry(3, { decision: { repositoryId: 3, status: "saved", updatedAt: "2026-09-02T00:00:00.000Z" } }),
    risingEntry(4, { decision: { repositoryId: 4, status: "unread", updatedAt: null } }),
  ];
  const base = payload({ lists: { rising: list, established: [], relevant: [] } });

  const saved = projectRadarDashboard(base, { period: "day", list: "rising", state: "saved" });
  assert.deepEqual(saved.cards.map((card) => card.repositoryId), [1, 3]);

  const all = projectRadarDashboard(base, { period: "day", list: "rising", state: "all" });
  assert.equal(all.cards.length, 4);
});

test("focus filtering keeps only repositories carrying the selected direction", () => {
  const list = [
    risingEntry(1, { repository: repository(1, { focusAreas: ["agent"] }) }),
    risingEntry(2, { repository: repository(2, { focusAreas: ["rag-knowledge"] }) }),
    risingEntry(3, { repository: repository(3, { focusAreas: ["agent", "ai-coding"] }) }),
  ];
  const base = payload({ lists: { rising: list, established: [], relevant: [] } });

  const agents = projectRadarDashboard(base, { period: "day", list: "rising", focus: "agent" });
  assert.deepEqual(agents.cards.map((card) => card.repositoryId), [1, 3]);

  const all = projectRadarDashboard(base, { period: "day", list: "rising", focus: "all" });
  assert.equal(all.cards.length, 3);
});

test("the view preserves local observation dates, coverage, stale/asOf, and counts", () => {
  const stale = payload({
    lists: { rising: [risingEntry(1)], established: [], relevant: [] },
    freshness: {
      queriedAt: "2026-09-04T01:00:00.000Z",
      asOf: "2026-09-02T01:00:00.000Z",
      lastDataAt: "2026-09-02T01:00:00.000Z",
      lastSuccessAt: "2026-09-02T01:00:00.000Z",
      stale: true,
    },
    coverage: { discoveredCount: 30, trackedCount: 2, detailRequestedCount: 10, observedCount: 30, failedCount: 1, deferredCount: 0, truncated: false, partial: true, retryAt: "2026-09-04T02:00:00.000Z" },
    retryAt: "2026-09-04T02:00:00.000Z",
    errors: [{ code: "GITHUB_HTTP_ERROR", message: "GitHub request failed." }],
  });
  delete stale.counts;

  const view = projectRadarDashboard(stale, { period: "day", list: "rising" });

  assert.equal(view.localDate, "2026-09-02");
  assert.equal(view.timeZone, "Etc/UTC");
  assert.equal(view.freshness.stale, true);
  assert.equal(view.freshness.asOf, "2026-09-02T01:00:00.000Z");
  assert.equal(view.coverage.partial, true);
  assert.equal(view.coverage.failedCount, 1);
  assert.equal(view.retryAt, "2026-09-04T02:00:00.000Z");
  assert.deepEqual(view.errors, [{ code: "GITHUB_HTTP_ERROR", message: "GitHub request failed." }]);
  assert.equal(view.counts, null);
  assert.equal(view.cards[0].coverage.observedDays, 1);
});

test("a null or list-less payload projects an empty view", () => {
  const empty = projectRadarDashboard(null, { period: "week", list: "established" });

  assert.deepEqual(empty.cards, []);
  assert.equal(empty.empty, true);
  assert.equal(empty.viewLimit, 12);
  assert.equal(empty.period, "week");
  assert.equal(empty.list, "established");
  assert.equal(empty.counts, null);
  assert.equal(empty.freshness, null);
  assert.equal(empty.localDate, null);

  const noLists = projectRadarDashboard({ period: "day" }, { period: "day", list: "rising" });
  assert.deepEqual(noLists.cards, []);
  assert.equal(noLists.empty, true);
});

test("unknown period, list, state, or focus values are rejected", () => {
  const base = payload({ lists: { rising: [risingEntry(1)], established: [], relevant: [] } });
  for (const options of [
    { period: "decade" },
    { period: "day", list: "trending" },
    { period: "day", list: "rising", state: "starred" },
    { period: "day", list: "rising", focus: "machine-learning" },
  ]) {
    assert.throws(() => projectRadarDashboard(base, options), RangeError);
  }
});