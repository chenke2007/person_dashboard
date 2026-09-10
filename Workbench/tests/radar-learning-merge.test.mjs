import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRadarRepository } from "../server/ai-radar/radar-repository.mjs";
import { createLearningRepository } from "../server/learning/learning-repository.mjs";

const instant = "2026-09-02T06:00:00.000Z";
const now = () => new Date(instant);
const timeZone = "UTC";
const commitSha = (char) => char.repeat(40);

function syntheticRepository(id = 101, patch = {}) {
  return {
    id,
    fullName: `synthetic/repository-${id}`,
    htmlUrl: `https://github.com/synthetic/repository-${id}`,
    description: "Synthetic demo repository",
    language: "JavaScript",
    topics: ["agents"],
    focusAreas: ["agent"],
    stars: 100,
    forks: 2,
    openIssues: null,
    archived: false,
    fork: false,
    license: "MIT",
    defaultBranch: "main",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: instant,
    pushedAt: null,
    observedAt: instant,
    ...patch,
  };
}

// A real learning store beside the radar store, sharing the same workspace
// directory, exactly like the bound-workspace layout the plugin derives.
async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-radar-learning-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const radarDirectory = path.join(root, "ai-radar");
  const learningDirectory = path.join(root, "learning");
  return {
    root,
    radarDirectory,
    learningDirectory,
    radar: createRadarRepository({ directory: radarDirectory, now, timeZone }),
    learning: createLearningRepository({ directory: learningDirectory, now }),
  };
}

async function drafts(learning, ids) {
  const drafts = [];
  for (const id of ids) {
    drafts.push(await learning.createDraft({
      repositoryId: id,
      fullName: `synthetic/repository-${id}`,
      sourceUrl: `https://github.com/synthetic/repository-${id}`,
      sourceCommitSha: commitSha("a"),
      mission: { goal: "understand-architecture", notes: "Synthetic study task" },
    }));
  }
  return drafts.map(({ workspace }) => workspace);
}

// Builds the lifecycle map the plugin passes onto getDashboard from the real
// learning store: repositoryId -> lifecycle state.
async function learningStateOf(learning) {
  const { workspaces } = await learning.list({ includeArchived: true });
  return new Map(workspaces.map((workspace) => [workspace.repositoryId, workspace.state]));
}

function allEntries(dashboard) {
  return [...dashboard.lists.established, ...dashboard.lists.rising, ...dashboard.lists.relevant];
}

test("dashboard entries gain a learning facet from the injected lifecycle map", async (t) => {
  const { radar, learning } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository(101, { stars: 500 }), syntheticRepository(102, { stars: 300 })]);
  const [draft] = await drafts(learning, [101, 102]);

  // repo 101 -> archived, repo 102 stays a draft with no learning workspace.
  await learning.archive(draft.workspaceId);
  const states = await learningStateOf(learning);

  const board = await radar.getDashboard({ learningState: states });
  const entries = allEntries(board);
  const byId = new Map(entries.map((entry) => [entry.repositoryId, entry]));
  assert.equal(byId.get(101).learning, "archived");
  assert.equal(byId.get(102).learning, "draft");

  // A repo with no learning workspace carries a null facet, never a fake state.
  await radar.upsertRepositories([syntheticRepository(103, { stars: 200 })]);
  const boardNull = await radar.getDashboard({ learningState: await learningStateOf(learning) });
  assert.equal(new Map(allEntries(boardNull).map((entry) => [entry.repositoryId, entry])).get(103).learning, null);
});

test("the learning filter selects draft/queued/active/archived workspaces", async (t) => {
  const { radar, learning } = await fixture(t);
  await radar.upsertRepositories([
    syntheticRepository(101, { stars: 900 }), syntheticRepository(102, { stars: 500 }),
    syntheticRepository(103, { stars: 400 }), syntheticRepository(104, { stars: 300 }),
    syntheticRepository(105, { stars: 200 }),
  ]);
  const [d1, d2, d3, d4, d5] = await drafts(learning, [101, 102, 103, 104, 105]);
  // 101 stays a draft; confirm 102,104,105 first (active), then 103 last so it
  // queues; archive an active (104) so one workspace sits in archived.
  for (const d of [d2, d4, d5]) {
    const page = await learning.preview({ workspaceId: d.workspaceId });
    assert.equal((await learning.confirm({ token: page.token })).confirmed, "active");
  }
  const queuedPage = await learning.preview({ workspaceId: d3.workspaceId });
  assert.equal((await learning.confirm({ token: queuedPage.token })).confirmed, "queued");
  await learning.archive(d4.workspaceId);
  const states = await learningStateOf(learning);

  const draft = await radar.getDashboard({ learning: "draft", learningState: states });
  assert.equal(new Map(allEntries(draft).map((entry) => [entry.repositoryId, entry.learning])).get(101), "draft");

  const queued = await radar.getDashboard({ learning: "queued", learningState: states });
  assert.deepEqual([...new Set(allEntries(queued).map((entry) => entry.repositoryId))].sort((a, b) => a - b), [103]);

  const active = await radar.getDashboard({ learning: "active", learningState: states });
  assert.deepEqual([...new Set(allEntries(active).map((entry) => entry.repositoryId))].sort((a, b) => a - b), [102, 105]);
  assert.ok(allEntries(active).every((entry) => entry.learning === "active"));

  const archived = await radar.getDashboard({ learning: "archived", learningState: states });
  assert.equal(new Map(allEntries(archived).map((entry) => [entry.repositoryId, entry.learning])).get(104), "archived");

  // The merged card exposes both the radar decision and the learning overlay.
  const board = await radar.getDashboard({ learningState: states });
  const entries = new Map(allEntries(board).map((entry) => [entry.repositoryId, entry]));
  assert.equal(entries.get(101).learning, "draft");
  assert.equal(entries.get(101).decision.status, "unread");
});

test("the learning filter gate applies before rank truncation", async (t) => {
  const { radar, learning } = await fixture(t);
  // 12 repos; established is capped at the period "day" limit of 8.
  const repos = Array.from({ length: 12 }, (_, index) =>
    syntheticRepository(index + 1, { stars: 1200 - index }));
  await radar.upsertRepositories(repos);

  // The lowly-ranked repo #12 gets the only active learning workspace.
  const created12 = await learning.createDraft({
    repositoryId: 12,
    fullName: `synthetic/repository-${12}`,
    sourceUrl: `https://github.com/synthetic/repository-${12}`,
    sourceCommitSha: commitSha("a"),
    mission: { goal: "learn-usage", notes: "Synthetic study task" },
  });
  const page12 = await learning.preview({ workspaceId: created12.workspace.workspaceId });
  assert.equal((await learning.confirm({ token: page12.token })).confirmed, "active");

  const full = await radar.getDashboard({ learningState: await learningStateOf(learning) });
  assert.equal(full.lists.established.length, 8);
  assert.equal(full.lists.established.some((entry) => entry.repositoryId === 12), false);

  const activeOnly = await radar.getDashboard({ learning: "active", learningState: await learningStateOf(learning) });
  // Applied before truncation, repo #12 (which normal ranking would cut) is ranked.
  const establishedIds = activeOnly.lists.established.map((entry) => entry.repositoryId);
  assert.ok(establishedIds.includes(12), `expected repo 12 in established, got ${establishedIds}`);
});

test("dashboard entries expose the learning workspace id alongside the lifecycle facet", async (t) => {
  const { radar, learning } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository(101)]);
  const [draft] = await drafts(learning, [101]);
  const ids = new Map([[101, draft.workspaceId]]);

  const board = await radar.getDashboard({
    learningState: await learningStateOf(learning),
    learningWorkspaceIds: ids,
  });
  const entry = allEntries(board).find((item) => item.repositoryId === 101);
  assert.equal(entry.learning, "draft");
  assert.equal(entry.learningWorkspaceId, draft.workspaceId);

  // Without an id map the facet stays null, never a fabricated id.
  const bare = await radar.getDashboard({ learningState: await learningStateOf(learning) });
  assert.equal(allEntries(bare).find((item) => item.repositoryId === 101).learningWorkspaceId, null);
});

test("the learning filter leaves radar decision counts and eligibleCount untouched", async (t) => {
  const { radar, learning } = await fixture(t);
  await radar.upsertRepositories([
    syntheticRepository(101, { stars: 900 }), syntheticRepository(102, { stars: 500 }),
    syntheticRepository(103, { stars: 400 }), syntheticRepository(104, { stars: 300 }),
  ]);
  await radar.setDecision(101, "saved");
  await radar.setDecision(103, "ignored");
  // One learning workspace (active) on a repo that exists in the radar list.
  await drafts(learning, [102]);
  const states = await learningStateOf(learning);

  const all = await radar.getDashboard({ learningState: states });
  const active = await radar.getDashboard({ learning: "active", learningState: states });

  // counts come from radar DECISION status and ignore the learning overlay.
  assert.deepEqual(active.counts, all.counts);
  assert.equal(active.counts.all, 3); // 101 saved, 102 unread, 103 ignored -> all = non-ignored
  // eligibleCount reflects the radar decision/focus set, not the learning subset.
  assert.equal(active.eligibleCount, all.eligibleCount);
  assert.equal(active.eligibleCount, 3); // 101, 102, 104 (ignored 103 excluded)
  assert.equal(active.filters.learning, "active");
  assert.equal(all.filters.learning, "all");
});

test("a corrupt learning store surfaces unavailable and keeps base radar lists rendering", async (t) => {
  const { radar, learning, radarDirectory, learningDirectory } = await fixture(t);
  await radar.upsertRepositories([syntheticRepository(101, { stars: 500 }), syntheticRepository(102, { stars: 300 })]);
  // Corrupt the learning store exactly like a disk/blob corruption would.
  await mkdir(learningDirectory, { recursive: true });
  await writeFile(path.join(learningDirectory, "learning.json"), "<not-json>%corrupt%", "utf8");

  // Proving the real learning store is genuinely unreadable.
  await assert.rejects(learning.list(), (error) => error?.code === "LEARNING_STORAGE_CORRUPT");

  // The plugin wrapper turns a corrupt read into learningStatus "unavailable";
  // the base radar read must still render its reliable data with null facets.
  const base = await radar.getDashboard({ learningStatus: "unavailable" });
  assert.equal(base.learningStatus, "unavailable");
  assert.equal(base.lists.established.length, 2);
  assert.ok(allEntries(base).every((entry) => entry.learning === null));
  const ids = new Set(allEntries(base).map((entry) => entry.repositoryId));
  assert.ok(ids.has(101) && ids.has(102));

  // A learning-filtered read must never masquerade as "no learning projects":
  // with the store unavailable the filter matches nothing.
  const filtered = await radar.getDashboard({ learning: "active", learningStatus: "unavailable", learningState: null });
  assert.equal(filtered.learningStatus, "unavailable");
  assert.equal(filtered.lists.established.length, 0);
});
