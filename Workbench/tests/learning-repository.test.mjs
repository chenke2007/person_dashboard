import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLearningRepository, LearningWorkspaceError } from "../server/learning/learning-repository.mjs";
import { createWorkspaceBackup } from "../server/workspace-state/workspace-backup.mjs";

const instant = "2026-09-02T06:00:00.000Z";
const now = () => new Date(instant);
const commitSha = (char) => char.repeat(40);
function mission(goal = "understand-architecture", notes = "Synthetic study task") {
  return { goal, notes };
}
function draftInput(repositoryId = 101, patch = {}) {
  return {
    repositoryId,
    fullName: `synthetic/repository-${repositoryId}`,
    sourceUrl: `https://github.com/synthetic/repository-${repositoryId}`,
    sourceCommitSha: commitSha("a"),
    mission: mission(),
    ...patch,
  };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "learning");
  return { root, directory, learning: createLearningRepository({ directory, now }) };
}
const isCode = (code) => (error) => error instanceof LearningWorkspaceError && error.code === code;

test("creates an independent draft per repository idempotently without overwriting", async (t) => {
  const { learning } = await fixture(t);
  const first = await learning.createDraft(draftInput(101));
  assert.equal(first.workspace.state, "draft");
  assert.equal(first.workspace.draftRevision, 1);
  assert.match(first.workspace.workspaceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(first.workspace.sourceCommitSha, commitSha("a"));
  assert.deepEqual(first.workspace.mission, mission());

  // Same repository returns the existing draft; no duplicate, no overwrite.
  const edited = await learning.editDraft({ workspaceId: first.workspace.workspaceId, expectedRevision: 1, mission: mission("learn-usage", "Edited notes") });
  const second = await learning.createDraft(draftInput(101));
  assert.equal(second.workspace.workspaceId, first.workspace.workspaceId);
  assert.equal(second.workspace.draftRevision, edited.workspace.draftRevision);
  assert.deepEqual(second.workspace.mission, mission("learn-usage", "Edited notes"));

  const other = await learning.createDraft(draftInput(102));
  assert.notEqual(other.workspace.workspaceId, first.workspace.workspaceId);
  assert.equal((await learning.list()).workspaces.length, 2);
});

test("editDraft bumps revision and rejects stale expectedRevision", async (t) => {
  const { learning } = await fixture(t);
  const { workspace } = await learning.createDraft(draftInput(101));
  const versioned = await learning.editDraft({ workspaceId: workspace.workspaceId, expectedRevision: 1, mission: mission("analyze-design", "v2") });
  assert.equal(versioned.workspace.draftRevision, 2);
  assert.deepEqual(versioned.workspace.mission, mission("analyze-design", "v2"));
  await assert.rejects(
    learning.editDraft({ workspaceId: workspace.workspaceId, expectedRevision: 1, mission: mission("learn-usage", "stale") }),
    isCode("REVISION_CONFLICT"),
  );
  const after = await learning.get(workspace.workspaceId);
  assert.equal(after.workspace.draftRevision, 2);
  assert.deepEqual(after.workspace.mission, mission("analyze-design", "v2"));
});

test("preview returns the full reviewable mission, fixed source and draft revision", async (t) => {
  const { learning } = await fixture(t);
  const { workspace } = await learning.createDraft(draftInput(101));
  const preview = await learning.preview({ workspaceId: workspace.workspaceId });
  assert.equal(typeof preview.token, "string");
  assert.ok(preview.token.length >= 32);
  assert.equal(preview.draftRevision, 1);
  assert.equal(preview.sourceCommitSha, commitSha("a"));
  assert.deepEqual(preview.mission, mission());
  assert.ok(Date.parse(preview.expiresAt) > Date.parse(instant));
});

test("confirm transitions under capacity: first three active, fourth queues", async (t) => {
  const { learning } = await fixture(t);
  const drafts = [];
  for (const id of [101, 102, 103, 104]) drafts.push(await learning.createDraft(draftInput(id)));
  const outcomes = [];
  for (const { workspace } of drafts) {
    const page = await learning.preview({ workspaceId: workspace.workspaceId });
    outcomes.push((await learning.confirm({ token: page.token })).confirmed);
  }
  assert.deepEqual(outcomes, ["active", "active", "active", "queued"]);
  const state = (await learning.getState()).workspaces;
  assert.equal(state.filter((w) => w.state === "active").length, 3);
  assert.equal(state.filter((w) => w.state === "queued").length, 1);
});

test("replaying a consumed token returns the same receipt and does not mask later archive", async (t) => {
  const { learning } = await fixture(t);
  const { workspace } = await learning.createDraft(draftInput(101));
  const page = await learning.preview({ workspaceId: workspace.workspaceId });
  const first = await learning.confirm({ token: page.token });
  assert.equal(first.confirmed, "active");
  const replay = await learning.confirm({ token: page.token });
  assert.equal(replay.confirmed, first.confirmed);
  assert.equal(replay.workspace.workspaceId, first.workspace.workspaceId);

  const archived = await learning.archive(workspace.workspaceId);
  assert.equal(archived.workspace.state, "archived");
  const replayAfterArchive = await learning.confirm({ token: page.token });
  assert.equal(replayAfterArchive.confirmed, "active");
  assert.equal(replayAfterArchive.workspace.state, "archived");
});

test("rejects expired, drifted, unknown and ownership-mismatched confirm tokens", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-expiry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = Date.parse(instant);
  const clock = () => new Date((tick += 1000));
  const learning = createLearningRepository({ directory: path.join(root, "learning"), now: clock });
  const { workspace } = await learning.createDraft(draftInput(101));
  const page = await learning.preview({ workspaceId: workspace.workspaceId });

  // Drift: editing the mission after preview invalidates the old token.
  await learning.editDraft({ workspaceId: workspace.workspaceId, expectedRevision: 1, mission: mission("learn-usage", "changed") });
  await assert.rejects(learning.confirm({ token: page.token }), isCode("CONFIRM_TOKEN_INVALID"));

  // Unknown / ownership-mismatched token.
  await assert.rejects(learning.confirm({ token: "f".repeat(64) }), isCode("CONFIRM_TOKEN_INVALID"));

  // Expiry on a fresh preview after the clock advances well past expiresAt.
  const second = await learning.preview({ workspaceId: workspace.workspaceId });
  tick += 25 * 60 * 60 * 1000;
  await assert.rejects(learning.confirm({ token: second.token }), isCode("CONFIRM_TOKEN_INVALID"));
});

test("activate promotes queued into active up to the limit and reports capacity otherwise", async (t) => {
  const { learning } = await fixture(t);
  const drafts = [];
  for (const id of [101, 102, 103, 104]) drafts.push(await learning.createDraft(draftInput(id)));
  const confirmed = [];
  for (const { workspace } of drafts) {
    const page = await learning.preview({ workspaceId: workspace.workspaceId });
    confirmed.push(await learning.confirm({ token: page.token }));
  }
  const active = confirmed.find((c) => c.confirmed === "active");
  const queued = confirmed.find((c) => c.confirmed === "queued");
  const queuedId = queued.workspace.workspaceId;

  // While still queued, a stale revision must conflict before any state change.
  await assert.rejects(learning.activate({ workspaceId: queuedId, expectedRevision: 2 }), isCode("REVISION_CONFLICT"));
  assert.equal((await learning.get(queuedId)).workspace.state, "queued");

  const result = await learning.activate({ workspaceId: queuedId, expectedRevision: 1 });
  assert.equal(result.outcome, "ACTIVE_LIMIT_REACHED");
  assert.equal(result.workspace.state, "queued");
  await learning.archive(active.workspace.workspaceId);
  const promoted = await learning.activate({ workspaceId: queuedId, expectedRevision: 1 });
  assert.equal(promoted.outcome, "active");
  assert.equal(promoted.workspace.state, "active");
  const still = await learning.activate({ workspaceId: queuedId, expectedRevision: 1 });
  assert.equal(still.outcome, "already-active");
});

test("archive is idempotent and only affects its own workspace", async (t) => {
  const { learning } = await fixture(t);
  const first = await learning.createDraft(draftInput(101));
  const second = await learning.createDraft(draftInput(102));
  const archived = await learning.archive(first.workspace.workspaceId);
  assert.equal(archived.workspace.state, "archived");
  const again = await learning.archive(first.workspace.workspaceId);
  assert.equal(again.workspace.state, "archived");
  const other = await learning.get(second.workspace.workspaceId);
  assert.equal(other.workspace.state, "draft");
  assert.equal((await learning.list({ includeArchived: true })).workspaces.length, 2);
  assert.equal((await learning.list()).workspaces.map((w) => w.state).includes("archived"), false);
});

test("read-only queries on a missing store return empty without creating a directory", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-readonly-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "learning");
  const learning = createLearningRepository({ directory, now });
  assert.deepEqual(await learning.list(), { workspaces: [] });
  await assert.rejects(learning.get(101), isCode("WORKSPACE_NOT_FOUND"));
  assert.equal((await learning.exportState()).workspaces.length, 0);
  await assert.rejects(lstat(directory), (error) => error.code === "ENOENT");
});

test("restart persistence re-reads workspaces and receipts through the same interface", async (t) => {
  const { directory } = await fixture(t);
  const first = createLearningRepository({ directory, now });
  const { workspace } = await first.createDraft(draftInput(101));
  const page = await first.preview({ workspaceId: workspace.workspaceId });
  await first.confirm({ token: page.token });
  const snapshot = await first.getState();

  const restarted = createLearningRepository({ directory, now });
  const listed = await restarted.list();
  assert.equal(listed.workspaces.length, 1);
  assert.deepEqual(listed.workspaces[0], snapshot.workspaces[0]);
  const replay = await restarted.confirm({ token: page.token });
  assert.equal(replay.confirmed, "active");
  assert.equal(replay.workspace.state, "active");
});

test("backup provider contract round-trips, omits raw tokens and rejects unknown versions", async (t) => {
  const { directory, learning } = await fixture(t);
  const provider = learning.registerBackupProvider();
  assert.equal(provider.id, "learning");
  assert.equal(provider.schemaVersion, 1);
  assert.equal(provider.optionalForImport, true);

  const { workspace } = await learning.createDraft(draftInput(101));
  const page = await learning.preview({ workspaceId: workspace.workspaceId });
  await learning.confirm({ token: page.token });
  const exported = await provider.exportState();
  assert.equal(exported.workspaces.length, 1);
  assert.equal(JSON.stringify(exported).includes(page.token), false);
  assert.equal(JSON.stringify(exported).includes("tokenDigest"), false);

  const backup = createWorkspaceBackup({ providers: [provider], now, secret: Buffer.alloc(32, 7) });
  const bundle = await backup.exportBundle();
  const previewImport = await backup.previewImport(bundle);
  assert.deepEqual(previewImport.providers, [{ id: "learning", version: 1, count: 1 }]);
  await backup.confirmImport(previewImport.token);
  assert.equal((await learning.getState()).workspaces.length, 1);

  // Unknown storage version is rejected by validateImport.
  await assert.rejects(provider.validateImport({ version: 2 }), isCode("LEARNING_STORAGE_VERSION_UNSUPPORTED"));

  // Raw token no longer authorizes after state was replaced with a token-free export.
  await provider.replaceState((await provider.exportState()));
  await assert.rejects(learning.confirm({ token: page.token }), isCode("CONFIRM_TOKEN_INVALID"));
});

test("independent instances and processes keep at most three active under concurrent confirms", async (t) => {
  const { directory } = await fixture(t);
  const first = createLearningRepository({ directory, now });
  const other = createLearningRepository({ directory, now });
  const drafts = [];
  for (const id of [101, 102, 103, 104, 105]) drafts.push(await first.createDraft(draftInput(id)));
  const previews = [];
  for (const { workspace } of drafts) previews.push(await first.preview({ workspaceId: workspace.workspaceId }));
  await Promise.all(previews.map((page, index) => (index % 2 ? first : other).confirm({ token: page.token })));
  const state = (await first.getState()).workspaces;
  assert.equal(state.filter((w) => w.state === "active").length, 3);
  assert.equal(state.filter((w) => w.state === "queued").length, 2);

  // A genuinely different OS process confirms against the same store directory.
  const source = new URL("../server/learning/learning-repository.mjs", import.meta.url).href;
  const run = promisify(execFile);
  await Promise.all([201, 202, 203, 204].map((id) => run(process.execPath, ["--input-type=module", "-e", `
    import { createLearningRepository } from ${JSON.stringify(source)};
    const repository = createLearningRepository({ directory: process.argv[1], now: () => new Date("2026-09-02T06:00:00Z") });
    const id = Number(process.argv[2]);
    const draft = await repository.createDraft({ repositoryId: id, fullName: "synthetic/r-"+id, sourceUrl: "https://github.com/synthetic/r-"+id, sourceCommitSha: "a".repeat(40), mission: { goal: "learn-usage", notes: "child process" } });
    const page = await repository.preview({ workspaceId: draft.workspace.workspaceId });
    await repository.confirm({ token: page.token });
  `, directory, String(id)])));
  const finalState = (await first.getState()).workspaces;
  assert.equal(finalState.filter((w) => w.state === "active").length, 3);
  assert.equal(finalState.map((w) => w.repositoryId).includes(204), true);
});
