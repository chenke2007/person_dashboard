import assert from "node:assert/strict";
import test from "node:test";
import { observedDelta, rankRadar } from "../shared/ai-radar-ranking.mjs";

const NOW = new Date("2026-09-02T12:00:00.000Z");

function repository(id, overrides = {}) {
  return {
    id,
    fullName: `synthetic-lab/project-${id}`,
    htmlUrl: `https://github.com/synthetic-lab/project-${id}`,
    description: "Synthetic repository for ranking tests.",
    language: "JavaScript",
    topics: ["agent"],
    focusAreas: ["agent"],
    stars: 100,
    forks: 10,
    openIssues: 2,
    archived: false,
    fork: false,
    license: "MIT",
    defaultBranch: "main",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    pushedAt: "2026-09-01T00:00:00.000Z",
    observedAt: "2026-09-02T00:00:00.000Z",
    preservedAt: null,
    ...overrides,
  };
}

function snapshot(repositoryId, capturedAt, stars, overrides = {}) {
  return {
    repositoryId,
    stars,
    forks: 1,
    openIssues: 0,
    capturedAt,
    capturedDate: capturedAt.slice(0, 10),
    timeZone: "UTC",
    ...overrides,
  };
}

function rank(input = {}) {
  return rankRadar({
    repositories: [repository(1)],
    snapshots: [],
    period: "week",
    preferences: [],
    relevance: [],
    now: NOW,
    timeZone: "UTC",
    ...input,
  });
}

test("does not manufacture a delta when a baseline is missing", () => {
  const ranked = rank({ snapshots: [snapshot(1, "2026-09-02T08:00:00.000Z", 120)] });

  assert.equal(ranked.rising[0].observedStarDelta, null);
  assert.equal(ranked.rising[0].status, "collecting");
  assert.deepEqual(ranked.rising[0].coverage, { observedDays: 1, expectedDays: 7, missingDays: 6, complete: false });
  assert.match(ranked.rising[0].reasons.join(" "), /缺少.*基线/);
});

test("uses exact one, seven, and thirty-day baselines without inventing gaps", () => {
  const snapshots = [
    snapshot(1, "2026-08-03T08:00:00.000Z", 10),
    snapshot(1, "2026-08-26T08:00:00.000Z", 30),
    snapshot(1, "2026-09-01T08:00:00.000Z", 35),
    snapshot(1, "2026-09-02T08:00:00.000Z", 40),
  ];

  assert.deepEqual(observedDelta(snapshots, 1, 1, NOW, "UTC"), {
    observedStarDelta: 5,
    baselineDate: "2026-09-01",
    currentDate: "2026-09-02",
    observedWindowDays: 1,
    exactWindow: true,
  });
  assert.deepEqual(observedDelta(snapshots, 1, 7, NOW, "UTC"), {
    observedStarDelta: 10,
    baselineDate: "2026-08-26",
    currentDate: "2026-09-02",
    observedWindowDays: 7,
    exactWindow: true,
  });
  assert.deepEqual(observedDelta(snapshots, 1, 30, NOW, "UTC"), {
    observedStarDelta: 30,
    baselineDate: "2026-08-03",
    currentDate: "2026-09-02",
    observedWindowDays: 30,
    exactWindow: true,
  });
});

test("uses the nearest earlier baseline and labels its actual window", () => {
  const ranked = rank({
    snapshots: [
      snapshot(1, "2026-08-24T08:00:00.000Z", 80),
      snapshot(1, "2026-09-02T08:00:00.000Z", 100),
    ],
  });

  assert.equal(ranked.rising[0].observedStarDelta, 20);
  assert.equal(ranked.rising[0].baseline.effectiveDate, "2026-08-24");
  assert.equal(ranked.rising[0].baseline.exactWindow, false);
  assert.equal(ranked.rising[0].baseline.observedWindowDays, 9);
  assert.match(ranked.rising[0].reasons.join(" "), /实际 9 天/);
});

test("separates complete and incomplete rising coverage with real missing dates", () => {
  const dates = ["2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"];
  const complete = dates.map((date, index) => snapshot(1, `${date}T08:00:00.000Z`, 10 + index));
  const incomplete = [
    snapshot(2, "2026-08-26T08:00:00.000Z", 1),
    snapshot(2, "2026-08-28T08:00:00.000Z", 2),
    snapshot(2, "2026-08-30T08:00:00.000Z", 3),
    snapshot(2, "2026-09-01T08:00:00.000Z", 4),
    snapshot(2, "2026-09-02T08:00:00.000Z", 5),
  ];
  const ranked = rank({ repositories: [repository(1), repository(2)], snapshots: [...incomplete, ...complete] });

  assert.deepEqual(ranked.rising.map((item) => item.repositoryId), [1, 2]);
  assert.deepEqual(ranked.rising[0].coverage, { observedDays: 7, expectedDays: 7, missingDays: 0, complete: true });
  assert.deepEqual(ranked.rising[1].coverage, { observedDays: 4, expectedDays: 7, missingDays: 3, complete: false });
  assert.equal(ranked.rising[1].status, "incomplete");
});

test("keeps a full seven-date series with an older baseline below an exact seven-day comparison", () => {
  const windowDates = ["2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"];
  const exact = [snapshot(1, "2026-08-26T08:00:00.000Z", 10), ...windowDates.map((date, index) => snapshot(1, `${date}T08:00:00.000Z`, 11 + index))];
  const older = [snapshot(2, "2026-08-24T08:00:00.000Z", 1), ...windowDates.map((date, index) => snapshot(2, `${date}T08:00:00.000Z`, 101 + index))];
  const ranked = rank({ repositories: [repository(1), repository(2)], snapshots: [...older, ...exact] });

  assert.deepEqual(ranked.rising.map((item) => item.repositoryId), [1, 2]);
  assert.equal(ranked.rising[0].status, "complete");
  assert.equal(ranked.rising[1].status, "incomplete");
  assert.deepEqual(ranked.rising[1].coverage, { observedDays: 7, expectedDays: 7, missingDays: 0, complete: true });
  assert.equal(ranked.rising[1].baseline.exactWindow, false);
  assert.equal(ranked.rising[1].baseline.observedWindowDays, 9);
});

test("keeps negative observed growth and resolves equal ranks by stable id", () => {
  const ranked = rank({
    repositories: [repository(9), repository(2), repository(3)],
    snapshots: [
      snapshot(9, "2026-08-26T08:00:00.000Z", 20), snapshot(9, "2026-09-02T08:00:00.000Z", 10),
      snapshot(2, "2026-08-26T08:00:00.000Z", 10), snapshot(2, "2026-09-02T08:00:00.000Z", 15),
      snapshot(3, "2026-08-26T08:00:00.000Z", 10), snapshot(3, "2026-09-02T08:00:00.000Z", 15),
    ],
  });

  assert.deepEqual(ranked.rising.map((item) => item.repositoryId), [2, 3, 9]);
  assert.equal(ranked.rising[2].observedStarDelta, -10);
});

test("projects snapshots into the requested timezone, excludes future instants, and keeps source provenance", () => {
  const ranked = rank({
    timeZone: "America/Los_Angeles",
    now: new Date("2026-09-02T07:30:00.000Z"),
    snapshots: [
      snapshot(1, "2026-08-26T07:00:00.000Z", 10, { capturedDate: "2026-08-26", timeZone: "UTC" }),
      snapshot(1, "2026-09-02T07:00:00.000Z", 20, { capturedDate: "2026-09-02", timeZone: "UTC" }),
      snapshot(1, "2026-09-02T08:00:00.000Z", 999),
    ],
  });

  assert.equal(ranked.rising[0].latest.effectiveDate, "2026-09-02");
  assert.equal(ranked.rising[0].latest.sourceCapturedDate, "2026-09-02");
  assert.equal(ranked.rising[0].latest.sourceTimeZone, "UTC");
  assert.equal(ranked.rising[0].latest.stars, 20);
  assert.equal(ranked.rising[0].observedStarDelta, 10);
  assert.deepEqual(Object.keys(ranked.rising[0].latest).sort(), [
    "capturedAt", "effectiveDate", "forks", "openIssues", "sourceCapturedDate", "sourceTimeZone", "stars",
  ]);
});

test("uses the latest actual observation once per effective date and preserves null metrics", () => {
  const ranked = rank({
    snapshots: [
      snapshot(1, "2026-08-26T08:00:00.000Z", 10),
      snapshot(1, "2026-09-02T07:00:00.000Z", 20),
      snapshot(1, "2026-09-02T08:00:00.000Z", null),
    ],
  });

  assert.equal(ranked.rising[0].coverage.observedDays, 1);
  assert.equal(ranked.rising[0].latest.stars, null);
  assert.equal(ranked.rising[0].observedStarDelta, null);
  assert.equal(ranked.rising[0].status, "collecting");
});

test("handles leap-month boundaries without expanding missing days", () => {
  const ranked = rank({
    period: "month",
    now: new Date("2024-03-01T12:00:00.000Z"),
    snapshots: [
      snapshot(1, "2024-01-31T12:00:00.000Z", 5),
      snapshot(1, "2024-02-29T12:00:00.000Z", 9),
      snapshot(1, "2024-03-01T12:00:00.000Z", 10),
    ],
  });

  assert.equal(ranked.rising[0].baseline.effectiveDate, "2024-01-31");
  assert.equal(ranked.rising[0].baseline.exactWindow, true);
  assert.equal(ranked.rising[0].coverage.observedDays, 2);
  assert.equal(ranked.rising[0].coverage.expectedDays, 30);
});

test("ranks maintained licensed repositories ahead of archived entries without changing their history marker", () => {
  const ranked = rank({
    repositories: [
      repository(1, { stars: 1000, archived: true, preservedAt: "2026-01-01T00:00:00.000Z" }),
      repository(2, { stars: 400, archived: false, license: "Apache-2.0", pushedAt: "2026-09-01T00:00:00.000Z" }),
    ],
  });

  assert.deepEqual(ranked.established.map((item) => item.repositoryId), [2, 1]);
  assert.equal(ranked.established[1].preservedHistory, true);
  assert.match(ranked.established[1].reasons.join(" "), /已归档/);
  assert.match(ranked.established[0].reasons.join(" "), /许可证/);
});

test("uses deterministic focus and validated classifier relevance while ignoring reverted feedback", () => {
  const ranked = rank({
    repositories: [
      repository(1, { language: "Python", topics: ["agent"], focusAreas: ["agent"] }),
      repository(2, { language: "Rust", topics: ["rag"], focusAreas: ["rag-knowledge"] }),
    ],
    preferences: [
      { id: "one", repositoryId: null, kind: "topic", value: "agent", direction: "more", revertedAt: null },
      { id: "two", repositoryId: null, kind: "language", value: "Rust", direction: "less", revertedAt: "2026-09-01T00:00:00.000Z" },
    ],
    relevance: [
      { repositoryId: 2, direction: "rag-knowledge", relevance: "high", reasonCode: "TOPIC_MATCH", reason: "匹配 RAG 知识方向" },
      { repositoryId: 1, direction: "invalid", relevance: "high", reasonCode: "TOPIC_MATCH", reason: "ignored" },
    ],
  });

  assert.deepEqual(ranked.relevant.map((item) => item.repositoryId), [1, 2]);
  assert.match(ranked.relevant[0].reasons.join(" "), /偏好更多：主题 agent/);
  assert.match(ranked.relevant[1].reasons.join(" "), /匹配 RAG 知识方向/);
  assert.doesNotMatch(ranked.relevant[1].reasons.join(" "), /偏好更少/);
});

test("applies active less-like feedback reversibly and rejects invalid timezone input", () => {
  const active = rank({
    repositories: [repository(1, { topics: ["agent"] }), repository(2, { topics: ["rag"] })],
    preferences: [{ id: "less", repositoryId: null, kind: "topic", value: "agent", direction: "less", revertedAt: null }],
  });
  const reverted = rank({
    repositories: [repository(1, { topics: ["agent"] }), repository(2, { topics: ["rag"] })],
    preferences: [{ id: "less", repositoryId: null, kind: "topic", value: "agent", direction: "less", revertedAt: "2026-09-01T00:00:00.000Z" }],
  });

  assert.deepEqual(active.relevant.map((item) => item.repositoryId), [2, 1]);
  assert.deepEqual(reverted.relevant.map((item) => item.repositoryId), [1, 2]);
  assert.throws(() => rank({ timeZone: "Mars/Olympus" }), RangeError);
});
