import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  const state = (await learning.list()).workspaces;
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
  const snapshot = await first.list();

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
  assert.equal((await learning.list()).workspaces.length, 1);

  // Unknown storage version is rejected by validateImport.
  await assert.rejects(provider.validateImport({ version: 2 }), isCode("LEARNING_STORAGE_VERSION_UNSUPPORTED"));

  // Raw token no longer authorizes after state was replaced with a token-free export.
  await provider.replaceState((await provider.exportState()));
  await assert.rejects(learning.confirm({ token: page.token }), isCode("CONFIRM_TOKEN_INVALID"));
});

const uuidFor = (char) => char.repeat(8) + "-2222-4333-8444-555555555555";
const filePlanHashFor = (paths) => createHash("sha256").update(JSON.stringify(paths)).digest("hex");
function contentBinding() {
  return {
    repositoryId: 101,
    sourceCommitSha: commitSha("a"),
    sourceUrl: "https://github.com/synthetic/repository-101",
  };
}
function contentPlan() {
  return {
    learningGoal: "理解该仓库的核心架构",
    expectedOutcome: "能够说明关键取舍并完成小实验",
    milestones: [
      { milestoneId: uuidFor("1"), title: "阅读架构文档", done: false },
      { milestoneId: uuidFor("2"), title: "复现核心流程", done: false },
    ],
    currentMilestone: uuidFor("1"),
  };
}
// Seeds a written ingestion record (selection + preview token + written record)
// through the composed learning repository's ingestion store, returning the
// raw preview token so tests can assert it never crosses a backup boundary.
async function seedIngestion(learning, workspace) {
  const workspaceId = workspace.workspaceId;
  const targetVaultId = "a".repeat(64);
  const ingestionBinding = { fingerprint: "f".repeat(64), workspaceId: "workspace-abc123" };
  const selectedTypes = ["plan", "notes"];
  const files = [
    { relativePath: "Wiki/学习/synthetic-repository-101/学习计划.md", kind: "plan", artifactId: null, existed: false },
    { relativePath: "Wiki/学习/synthetic-repository-101/学习笔记.md", kind: "notes", artifactId: null, existed: false },
  ];
  const planHash = filePlanHashFor(files.map((file) => file.relativePath).sort());
  await learning.ingestion.setSelection({ workspaceId, targetVaultId, targetVaultDisplayName: "目标知识库", targetMaskedPath: "…/目标知识库" });
  const preview = await learning.ingestion.issuePreview({
    workspaceId,
    binding: ingestionBinding,
    sourceCommitSha: commitSha("a"),
    contentRevision: 3,
    selectedContentTypes: selectedTypes,
    files,
    filePlanHash: planHash,
    target: { targetVaultId, targetVaultDisplayName: "目标知识库", targetMaskedPath: "…/目标知识库" },
  });
  await learning.ingestion.beginConfirm({
    token: preview.token,
    sourceCommitSha: commitSha("a"),
    contentRevision: 3,
    targetVaultId,
    selectedContentTypes: selectedTypes,
    filePlanHash: planHash,
    binding: ingestionBinding,
  });
  await learning.ingestion.finishConfirm({
    token: preview.token,
    outcome: { status: "written", writtenFiles: files.map((file) => file.relativePath) },
  });
  return { token: preview.token };
}

test("bundle export carries token-free ingestion state and restore round-trips records and selections", async (t) => {
  const { directory, learning } = await fixture(t);
  const provider = learning.registerBackupProvider();
  const { workspace } = await learning.createDraft(draftInput(101));
  const page = await learning.preview({ workspaceId: workspace.workspaceId });
  await learning.confirm({ token: page.token }); // active + receipt persisted in the store
  // Authored content and a written ingestion record so the bundle carries all three stores.
  await learning.content.savePlan({ workspaceId: workspace.workspaceId, expectedRevision: null, plan: contentPlan(), binding: contentBinding() });
  await learning.content.saveNotes({ workspaceId: workspace.workspaceId, expectedRevision: 1, notes: { markdownText: "合成学习笔记正文" }, binding: contentBinding() });
  await learning.content.addArtifact({ workspaceId: workspace.workspaceId, expectedRevision: 2, artifact: { type: "总结", title: "架构分析", markdownText: "合成产出正文" }, binding: contentBinding() });
  const { token } = await seedIngestion(learning, workspace);

  const exported = await provider.exportState();
  assert.ok(exported.ingestionRecords, "bundle export must carry the ingestion store");
  assert.ok(!Object.hasOwn(exported.ingestionRecords, "tokens"), "ingestion tokens must never be exported");
  assert.equal(exported.ingestionRecords.records[0].status, "written");
  assert.equal(JSON.stringify(exported).includes(token), false);

  const backup = createWorkspaceBackup({ providers: [provider], now, secret: Buffer.alloc(32, 7) });
  const bundle = await backup.exportBundle();
  const previewImport = await backup.previewImport(bundle);
  assert.deepEqual(previewImport.providers, [{ id: "learning", version: 1, count: 1 }]);
  await backup.confirmImport(previewImport.token);

  // Records, selections and authored content all came back with the restore.
  const records = await learning.ingestion.listRecords(workspace.workspaceId);
  assert.equal(records.records[0].status, "written");
  const selection = await learning.ingestion.getSelection(workspace.workspaceId);
  assert.equal(selection.selection.targetVaultDisplayName, "目标知识库");
  const content = await learning.content.getContent({ workspaceId: workspace.workspaceId });
  assert.equal(content.content.artifacts.length, 1);
  assert.equal(content.content.notes.markdownText, "合成学习笔记正文");
  // The pre-restore preview token was stripped with all token material.
  assert.equal(await learning.ingestion.ownerOf({ token }), null);
});

test("restoring a legacy bundle without ingestion fields imports cleanly and preserves existing state", async (t) => {
  const { directory, learning } = await fixture(t);
  const provider = learning.registerBackupProvider();
  const { workspace } = await learning.createDraft(draftInput(101));
  const page = await learning.preview({ workspaceId: workspace.workspaceId });
  await learning.confirm({ token: page.token });
  await learning.content.saveNotes({ workspaceId: workspace.workspaceId, expectedRevision: 1, notes: { markdownText: "既有学习笔记" }, binding: contentBinding() });
  const { token } = await seedIngestion(learning, workspace);
  const beforeSelection = await learning.ingestion.getSelection(workspace.workspaceId);

  // A legacy backup predates both the content and ingestion bundles.
  const legacyExport = await provider.exportState();
  delete legacyExport.contentRecords;
  delete legacyExport.ingestionRecords;
  const legacyProvider = {
    id: "learning",
    schemaVersion: 1,
    optionalForImport: true,
    exportState: async () => legacyExport,
    validateImport: provider.validateImport,
    replaceState: provider.replaceState,
    stageImport: provider.stageImport,
  };
  const backup = createWorkspaceBackup({ providers: [legacyProvider], now, secret: Buffer.alloc(32, 7) });
  const bundle = await backup.exportBundle();
  const previewImport = await backup.previewImport(bundle);
  assert.deepEqual(previewImport.providers.map(({ id }) => id), ["learning"]);
  await backup.confirmImport(previewImport.token);

  // Import succeeded and the absent stores were left untouched.
  assert.equal((await learning.list()).workspaces.length, 1);
  assert.deepEqual(await learning.ingestion.getSelection(workspace.workspaceId), beforeSelection);
  assert.equal((await learning.ingestion.listRecords(workspace.workspaceId)).records[0].status, "written");
  assert.equal((await learning.ingestion.ownerOf({ token })) !== null, true);
  assert.equal((await learning.content.getContent({ workspaceId: workspace.workspaceId })).content.notes.markdownText, "既有学习笔记");
});

test("bundle import rejects ingestion token material and restores strip issued preview tokens", async (t) => {
  const { directory, learning } = await fixture(t);
  const provider = learning.registerBackupProvider();
  const { workspace } = await learning.createDraft(draftInput(101));
  const { token } = await seedIngestion(learning, workspace);

  const exported = await provider.exportState();
  const tainted = {
    ...exported,
    ingestionRecords: { ...exported.ingestionRecords, tokens: [{ tokenDigest: "0".repeat(64) }] },
  };
  await assert.rejects(
    provider.validateImport(tainted),
    (error) => error.code === "INGESTION_IMPORT_TOKEN_MATERIAL_REJECTED",
  );
  await assert.rejects(
    provider.replaceState(tainted),
    (error) => error.code === "INGESTION_IMPORT_TOKEN_MATERIAL_REJECTED",
  );

  // A legitimate token-free restore cannot resurrect the live preview token.
  await provider.replaceState(await provider.exportState());
  assert.equal(await learning.ingestion.ownerOf({ token }), null);
});

test("a later bundle commit failure rolls back learning, content and ingestion together", async (t) => {
  const { directory, learning } = await fixture(t);
  const provider = learning.registerBackupProvider();
  const { workspace } = await learning.createDraft(draftInput(101));
  const page = await learning.preview({ workspaceId: workspace.workspaceId });
  await learning.confirm({ token: page.token }); // active + receipt persisted in the store
  await learning.content.saveNotes({ workspaceId: workspace.workspaceId, expectedRevision: 1, notes: { markdownText: "既有学习笔记" }, binding: contentBinding() });
  const { token } = await seedIngestion(learning, workspace);
  const beforeSelection = await learning.ingestion.getSelection(workspace.workspaceId);
  const beforeRecords = await learning.ingestion.listRecords(workspace.workspaceId);
  await learning.createDraft(draftInput(102)); // live change after the snapshot

  const failingProjects = {
    id: "projects",
    schemaVersion: 1,
    optionalForImport: false,
    exportState: async () => ({ version: 1, revision: 0, updatedAt: null, projects: [], columns: [] }),
    validateImport: async (value) => structuredClone(value),
    replaceState: async () => {},
    async stageImport() {
      return {
        async commit() { throw new Error("synthetic later provider commit failure"); },
        async rollback() {},
        async cleanup() {},
      };
    },
  };
  const backup = createWorkspaceBackup({ providers: [provider, failingProjects], secret: Buffer.alloc(32, 7) });
  const bundle = await backup.exportBundle();
  await assert.rejects(
    backup.confirmImport((await backup.previewImport(bundle)).token),
    { code: "WORKSPACE_RESTORE_COMMIT_FAILED" },
  );
  // Live state (including the post-snapshot draft) survived the failed restore.
  assert.deepEqual((await learning.list()).workspaces.map((w) => w.repositoryId).sort((a, b) => a - b), [101, 102]);
  assert.deepEqual(await learning.ingestion.getSelection(workspace.workspaceId), beforeSelection);
  assert.deepEqual(await learning.ingestion.listRecords(workspace.workspaceId), beforeRecords);
  assert.equal((await learning.content.getContent({ workspaceId: workspace.workspaceId })).content.notes.markdownText, "既有学习笔记");
  // Internal rollback restores the original store bytes, so the original preview token still authorizes.
  assert.ok(await learning.ingestion.ownerOf({ token }));
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
  const state = (await first.list()).workspaces;
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
  const finalState = (await first.list()).workspaces;
  assert.equal(finalState.filter((w) => w.state === "active").length, 3);
  assert.equal(finalState.map((w) => w.repositoryId).includes(204), true);
});

// -------------------- Step 12: S1 import invariants --------------------

function storePatch(workspaces, confirmations = [], revision = 0) {
  return { version: 1, revision, updatedAt: null, workspaces, confirmations };
}
function confirmRecord(workspace, token, expiresAt) {
  return {
    tokenDigest: createHash("sha256").update(token).digest("hex"),
    workspaceId: workspace.workspaceId,
    repositoryId: workspace.repositoryId,
    sourceCommitSha: workspace.sourceCommitSha,
    draftRevision: workspace.draftRevision,
    mission: workspace.mission,
    expiresAt,
    consumed: null,
  };
}
async function draftsFor(learning, ids) {
  const drafts = [];
  for (const id of ids) drafts.push(await learning.createDraft(draftInput(id)));
  return drafts.map(({ workspace }) => workspace);
}

test("P1a: rejects a store value with more than three active workspaces on validateImport, replaceState and stageImport", async (t) => {
  const { learning } = await fixture(t);
  const provider = learning.registerBackupProvider();
  const workspaces = await draftsFor(learning, [101, 102, 103, 104]);
  const fourActive = storePatch(workspaces.map((workspace) => ({ ...workspace, state: "active" })));
  await assert.rejects(provider.validateImport(fourActive), isCode("LEARNING_STORAGE_CORRUPT"));
  await assert.rejects(learning.replaceState(fourActive), isCode("LEARNING_STORAGE_CORRUPT"));
  await assert.rejects(provider.stageImport(fourActive), isCode("LEARNING_STORAGE_CORRUPT"));
});

test("P1a: a three-active import is accepted and becomes the store state", async (t) => {
  const { learning } = await fixture(t);
  const workspaces = await draftsFor(learning, [101, 102, 103]);
  const threeActive = storePatch(workspaces.map((workspace) => ({ ...workspace, state: "active" })));
  await learning.replaceState(threeActive);
  const after = await learning.list();
  assert.equal(after.workspaces.length, 3);
  assert.equal(after.workspaces.every((w) => w.state === "active"), true);
});

test("P1a: a rejected import leaves the original workspaces intact through public queries", async (t) => {
  const { learning } = await fixture(t);
  const workspaces = [];
  for (const id of [101, 102, 103, 104]) workspaces.push((await learning.createDraft(draftInput(id))).workspace);
  const before = await learning.list();
  const fourActive = storePatch(workspaces.map((workspace) => ({ ...workspace, state: "active" })));
  await assert.rejects(learning.replaceState(fourActive), isCode("LEARNING_STORAGE_CORRUPT"));
  assert.deepEqual(await learning.list(), before);
});

test("P1b: importing non-empty confirmations (authorization material) is rejected on validateImport and replaceState", async (t) => {
  const { learning } = await fixture(t);
  const provider = learning.registerBackupProvider();
  const [workspace] = await draftsFor(learning, [101]);
  const page = await learning.preview({ workspaceId: workspace.workspaceId });
  const withTokens = storePatch([workspace], [confirmRecord(workspace, page.token, page.expiresAt)]);
  await assert.rejects(provider.validateImport(withTokens), isCode("LEARNING_IMPORT_CONFIRMATIONS_REJECTED"));
  await assert.rejects(learning.replaceState(withTokens), isCode("LEARNING_IMPORT_CONFIRMATIONS_REJECTED"));
  await assert.rejects(provider.stageImport(withTokens), isCode("LEARNING_IMPORT_CONFIRMATIONS_REJECTED"));
  // A clean backup (empty confirmations) still round-trips.
  const clean = storePatch([workspace]);
  await learning.replaceState(clean);
  assert.equal((await learning.list()).workspaces.length, 1);
});

test("P1b: after a legitimate import every previously issued token is invalidated", async (t) => {
  const { learning } = await fixture(t);
  const [workspace] = await draftsFor(learning, [101]);
  const page = await learning.preview({ workspaceId: workspace.workspaceId });
  await learning.confirm({ token: page.token }); // active + consumed receipt
  // A fresh draft holds an unconsumed pending token.
  const [pendingWorkspace] = await draftsFor(learning, [102]);
  const pending = await learning.preview({ workspaceId: pendingWorkspace.workspaceId });
  // A legitimate token-free backup replaces the store (and drops the pending draft).
  await learning.replaceState(storePatch([{ ...workspace, state: "active" }]));
  // The unconsumed pending token is invalidated.
  await assert.rejects(learning.confirm({ token: pending.token }), isCode("CONFIRM_TOKEN_INVALID"));
  // The consumed receipt is also gone after a legitimate import.
  await assert.rejects(learning.confirm({ token: page.token }), isCode("CONFIRM_TOKEN_INVALID"));
});

test("4.1: a confirmation near preview expiry still earns a full 24h receipt window", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = Date.parse(instant);
  const clock = () => new Date(tick);
  const learning = createLearningRepository({ directory: path.join(root, "learning"), now: clock });
  const { workspace } = await learning.createDraft(draftInput(101));
  const page = await learning.preview({ workspaceId: workspace.workspaceId }); // expiresAt = now + 24h
  // Confirm 23h59m after preview, one minute before the preview token would expire.
  tick += (23 * 60 + 59) * 60 * 1000;
  const confirmed = await learning.confirm({ token: page.token });
  assert.equal(confirmed.confirmed, "active");
  // Two minutes later (past the original preview expiry) the receipt is still valid.
  tick += 2 * 60 * 1000;
  assert.equal((await learning.confirm({ token: page.token })).confirmed, "active");
  // ~23h after confirmation the receipt is still valid.
  tick += 23 * 60 * 60 * 1000;
  assert.equal((await learning.confirm({ token: page.token })).confirmed, "active");
  // Past the full 24h receipt window from confirmation it expires.
  tick += 2 * 60 * 60 * 1000;
  await assert.rejects(learning.confirm({ token: page.token }), isCode("CONFIRM_TOKEN_INVALID"));
});

test("4.2: archiving an already-archived workspace leaves content and updatedAt unchanged", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = Date.parse(instant);
  const clock = () => new Date((tick += 1000));
  const learning = createLearningRepository({ directory: path.join(root, "learning"), now: clock });
  const { workspace } = await learning.createDraft(draftInput(101));
  const first = await learning.archive(workspace.workspaceId);
  const frozen = first.workspace;
  tick += 60 * 60 * 1000;
  const retry = await learning.archive(workspace.workspaceId);
  assert.equal(retry.workspace.updatedAt, frozen.updatedAt);
  assert.deepEqual(retry.workspace, frozen);
  assert.deepEqual(await learning.get(workspace.workspaceId), { workspace: frozen });
});

test("3.1: confirm race — exactly one of two processes wins the last active slot and all workspaces remain", async (t) => {
  const { directory } = await fixture(t);
  const main = createLearningRepository({ directory, now });
  // Baseline of two active workspaces.
  for (const id of [101, 102]) {
    const draft = await main.createDraft(draftInput(id));
    const page = await main.preview({ workspaceId: draft.workspace.workspaceId });
    await main.confirm({ token: page.token });
  }
  assert.equal((await main.list()).workspaces.filter((w) => w.state === "active").length, 2);

  const barrierDir = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-race-"));
  t.after(() => rm(barrierDir, { recursive: true, force: true }));
  const codes = await barrierConfirmRace({ directory, barrierDir, userIds: [201, 202] });
  assert.deepEqual(codes.sort((a, b) => a - b), [10, 20]); // one active, one queued
  const state = (await main.list()).workspaces;
  assert.equal(state.filter((w) => w.state === "active").length, 3);
  assert.equal(state.filter((w) => w.state === "queued").length, 1);
  assert.deepEqual(state.map((w) => w.repositoryId).sort((a, b) => a - b), [101, 102, 201, 202]);
});

test("3.1: activate race — exactly one of two processes promotes a queued workspace into the last slot", async (t) => {
  const { directory } = await fixture(t);
  const main = createLearningRepository({ directory, now });
  const active = [];
  const queued = [];
  for (const id of [101, 102, 103, 104, 105]) {
    const draft = await main.createDraft(draftInput(id));
    const page = await main.preview({ workspaceId: draft.workspace.workspaceId });
    const result = await main.confirm({ token: page.token });
    (result.confirmed === "active" ? active : queued).push(draft.workspace);
  }
  // Confirm five leaves three active and two queued; archive one active to free
  // the third slot so exactly two queued workspaces contest for it.
  assert.equal(active.length, 3);
  assert.equal(queued.length, 2);
  await main.archive(active[0].workspaceId);
  assert.equal((await main.list()).workspaces.filter((w) => w.state === "active").length, 2);

  const barrierDir = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-race-activate-"));
  t.after(() => rm(barrierDir, { recursive: true, force: true }));
  const codes = await barrierActivateRace({ directory, barrierDir, workspaceIds: queued.map((w) => w.workspaceId) });
  assert.deepEqual(codes.sort((a, b) => a - b), [10, 20]); // one promoted, one stays queued
  const state = (await main.list()).workspaces;
  assert.equal(state.filter((w) => w.state === "active").length, 3);
  assert.equal(state.filter((w) => w.state === "queued").length, 1);
});

test("3.2: learning commit then a later provider commit fails — learning workspace and task roll back to the original", async (t) => {
  const { directory, learning } = await fixture(t);
  const provider = learning.registerBackupProvider();
  const { workspace } = await learning.createDraft(draftInput(101));
  const page = await learning.preview({ workspaceId: workspace.workspaceId });
  await learning.confirm({ token: page.token }); // active + receipt persisted in the store
  const current = await learning.list();
  // A later workspace appears after the backup snapshot (mutate live state).
  const later = await learning.createDraft(draftInput(102));

  const failingProjects = {
    id: "projects",
    schemaVersion: 1,
    optionalForImport: false,
    exportState: async () => ({ version: 1, revision: 0, updatedAt: null, projects: [], columns: [] }),
    validateImport: async (value) => structuredClone(value),
    replaceState: async () => {},
    async stageImport() {
      return {
        async commit() { throw new Error("synthetic later provider commit failure"); },
        async rollback() {},
        async cleanup() {},
      };
    },
  };
  const backup = createWorkspaceBackup({ providers: [provider, failingProjects], secret: Buffer.alloc(32, 7) });
  const bundle = await backup.exportBundle();
  assert.deepEqual(Object.keys(bundle.providers).sort(), ["learning", "projects"]); // learning commits first
  await assert.rejects(
    backup.confirmImport((await backup.previewImport(bundle)).token),
    { code: "WORKSPACE_RESTORE_COMMIT_FAILED" },
  );
  // Learning restored: both workspaces and task content intact, original authorization restored.
  const after = await learning.list();
  assert.deepEqual(after.workspaces.map((w) => w.repositoryId).sort((a, b) => a - b), [101, 102]);
  assert.deepEqual((await learning.get(later.workspace.workspaceId)).workspace, later.workspace);
  // Internal rollback restores the original store bytes, so the original token still authorizes.
  assert.equal((await learning.confirm({ token: page.token })).confirmed, "active");
});

test("3.3: restoring a legacy backup without the learning provider preserves existing learning data", async (t) => {
  const { directory, learning } = await fixture(t);
  const provider = learning.registerBackupProvider();
  const { workspace } = await learning.createDraft(draftInput(101));
  const page = await learning.preview({ workspaceId: workspace.workspaceId });
  await learning.confirm({ token: page.token });
  const before = await learning.list();

  const projects = {
    id: "projects",
    schemaVersion: 1,
    exportState: async () => ({ version: 1, revision: 0, updatedAt: null, projects: [], columns: [] }),
    validateImport: async (value) => structuredClone(value),
    replaceState: async () => {},
  };
  const legacyBackup = createWorkspaceBackup({ providers: [projects], secret: Buffer.alloc(32, 7) });
  const bundle = await legacyBackup.exportBundle();
  assert.equal(Object.keys(bundle.providers).includes("learning"), false);

  const restoreBackup = createWorkspaceBackup({ providers: [projects, provider], secret: Buffer.alloc(32, 7) });
  const preview = await restoreBackup.previewImport(bundle);
  assert.match(preview.warnings.join(" "), /learning.*保留/);
  assert.deepEqual(preview.providers.map(({ id }) => id), ["projects"]);
  await restoreBackup.confirmImport(preview.token);
  assert.deepEqual(await learning.list(), before);
  assert.equal((await learning.get(workspace.workspaceId)).workspace.state, "active");
});

test("3.4a: a corrupted store file fails mutations and preserves the original bytes", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "learning");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "learning.json");
  const corrupt = "<not-json>%corrupt%";
  await writeFile(file, corrupt);
  const learning = createLearningRepository({ directory, now });
  await assert.rejects(learning.createDraft(draftInput(101)), isCode("LEARNING_STORAGE_CORRUPT"));
  assert.equal(await readFile(file, "utf8"), corrupt);
});

test("3.4b: an unsupported store version is rejected without overwriting", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "learning");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "learning.json");
  const unknown = JSON.stringify({ version: 99 });
  await writeFile(file, unknown);
  const learning = createLearningRepository({ directory, now });
  await assert.rejects(learning.createDraft(draftInput(101)), isCode("LEARNING_STORAGE_VERSION_UNSUPPORTED"));
  assert.equal(await readFile(file, "utf8"), unknown);
});

test("3.4c: a store file that links outside the storage directory is rejected", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "learning");
  await mkdir(directory, { recursive: true });
  const outside = path.join(root, "outside.json");
  await writeFile(outside, JSON.stringify({ version: 1 }));
  let linked = true;
  try {
    await symlink(outside, path.join(directory, "learning.json"));
  } catch {
    linked = false; // platform without symlink privileges: nothing to assert
  }
  if (!linked) return;
  const learning = createLearningRepository({ directory, now });
  await assert.rejects(learning.createDraft(draftInput(101)), isCode("LEARNING_STORAGE_CORRUPT"));
});

function barrierChildren(directory, barrierDir, entries, mode) {
  const source = new URL("../server/learning/learning-repository.mjs", import.meta.url).href;
  return entries.map((entry) => {
    const body = `
      import { createLearningRepository } from ${JSON.stringify(source)};
      import { readFile, writeFile } from "node:fs/promises";
      const directory = ${JSON.stringify(directory)};
      const barrierDir = ${JSON.stringify(barrierDir)};
      const repository = createLearningRepository({ directory, now: () => new Date("2026-09-02T06:00:00Z") });
      const ticketId = ${JSON.stringify(String(entry.ticketId))};
      await writeFile(barrierDir + "/ready-" + ticketId + ".ticket", ticketId);
      process.stdout.write("READY\\n");
      for (;;) { try { await readFile(barrierDir + "/go.ticket"); break; } catch { await new Promise((r) => setTimeout(r, 5)); } }
      const id = ${JSON.stringify(String(entry.id))};
      if (${mode === "activate" ? "true" : "false"}) {
        const result = await repository.activate({ workspaceId: id, expectedRevision: 1 });
        if (result.outcome === "active") process.exitCode = 10;
        else if (result.outcome === "ACTIVE_LIMIT_REACHED") process.exitCode = 20;
        else process.exitCode = 1;
      } else {
        const draft = await repository.createDraft({ repositoryId: Number(id), fullName: "synthetic/r-"+id, sourceUrl: "https://github.com/synthetic/r-"+id, sourceCommitSha: "a".repeat(40), mission: { goal: "learn-usage", notes: "race" } });
        const page = await repository.preview({ workspaceId: draft.workspace.workspaceId });
        const result = await repository.confirm({ token: page.token });
        if (result.confirmed === "active") process.exitCode = 10;
        else if (result.confirmed === "queued") process.exitCode = 20;
        else process.exitCode = 1;
      }
    `;
    return body;
  });
}

async function runBarrier({ barrierDir, scripts }) {
  const children = scripts.map((body) => spawn(process.execPath, ["--input-type=module", "-e", body], { stdio: ["ignore", "pipe", "inherit"] }));
  let readySeen = 0;
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const fire = () => { if (!settled) { settled = true; resolve(); } };
    for (const child of children) {
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        for (let i = 0; i < text.length; i += 1) {
          if (text.startsWith("READY", i)) readySeen += 1;
        }
        if (readySeen >= scripts.length) fire();
      });
      child.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
    }
  });
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("race barrier timeout")), 15000))]);
  await writeFile(path.join(barrierDir, "go.ticket"), "go");
  const codes = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", reject);
  })));
  return codes;
}

async function barrierConfirmRace({ directory, barrierDir, userIds }) {
  const scripts = barrierChildren(directory, barrierDir, userIds.map((id) => ({ ticketId: id, id })), "confirm");
  return runBarrier({ barrierDir, scripts });
}
async function barrierActivateRace({ directory, barrierDir, workspaceIds }) {
  const scripts = barrierChildren(directory, barrierDir, workspaceIds.map((id) => ({ ticketId: id, id })), "activate");
  return runBarrier({ barrierDir, scripts });
}
