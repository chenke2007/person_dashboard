import assert from "node:assert/strict";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LearningContentError, createLearningContentRepository } from "../server/learning/learning-content-repository.mjs";
import { createLearningRepository, LearningWorkspaceError } from "../server/learning/learning-repository.mjs";
import { createWorkspaceBackup } from "../server/workspace-state/workspace-backup.mjs";

const instant = "2026-09-02T06:00:00.000Z";
const now = () => new Date(instant);
const commitSha = (char) => char.repeat(40);
const uuid = (char) => char.repeat(8) + "-2222-4333-8444-555555555555";

function binding(sha = "a", patch = {}) {
  return {
    repositoryId: 101,
    sourceCommitSha: commitSha(sha),
    sourceUrl: "https://github.com/synthetic/repository-101",
    ...patch,
  };
}

function plan(patch = {}) {
  return {
    learningGoal: "理解该仓库的核心架构",
    expectedOutcome: "能够说明关键取舍并完成小实验",
    milestones: [
      { milestoneId: uuid("1"), title: "阅读架构文档", done: false },
      { milestoneId: uuid("2"), title: "复现核心流程", done: false },
    ],
    currentMilestone: uuid("1"),
    ...patch,
  };
}

function notes(text = "这里是合成学习笔记正文") {
  return { markdownText: text };
}

function artifact(patch = {}) {
  return {
    type: "总结",
    title: "架构分析",
    markdownText: "合成产出正文，无真实内容。",
    ...patch,
  };
}

async function contentFixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-content-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "learning");
  return { root, directory, content: createLearningContentRepository({ directory, now }) };
}

const isContent = (code) => (error) => error instanceof LearningContentError && error.code === code;
const isLearning = (code) => (error) => error instanceof LearningWorkspaceError && error.code === code;

test("savePlan creates an independent content record and getContent reads it back", async (t) => {
  const { content } = await contentFixture(t);
  assert.equal((await content.getContent({ workspaceId: uuid("1") })).content, null);

  const saved = await content.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan(), binding: binding() });
  assert.equal(saved.content.revision, 1);
  assert.equal(saved.content.repositoryId, 101);
  assert.equal(saved.content.sourceCommitSha, commitSha("a"));
  assert.equal(saved.content.sourceUrl, "https://github.com/synthetic/repository-101");
  assert.deepEqual(saved.content.learningPlan, plan());

  const read = await content.getContent({ workspaceId: uuid("1") });
  assert.equal(read.content.revision, 1);
  assert.deepEqual(read.content.learningPlan, plan());
});

test("content records are isolated per workspaceId; unknown workspace reads null", async (t) => {
  const { content } = await contentFixture(t);
  await content.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan(), binding: binding("a", { repositoryId: 101 }) });
  await content.savePlan({ workspaceId: uuid("2"), expectedRevision: null, plan: plan({ learningGoal: "另一个工作区" }), binding: binding("b", { repositoryId: 102 }) });

  const first = await content.getContent({ workspaceId: uuid("1") });
  const second = await content.getContent({ workspaceId: uuid("2") });
  assert.equal(first.content.repositoryId, 101);
  assert.equal(second.content.repositoryId, 102);
  assert.notEqual(first.content.sourceCommitSha, second.content.sourceCommitSha);
  assert.equal((await content.getContent({ workspaceId: uuid("3") })).content, null);
  assert.equal((await content.listArtifacts({ workspaceId: uuid("3") })).artifacts.length, 0);
});

test("restart persistence: re-creating the repository on the same directory keeps content", async (t) => {
  const { directory } = await contentFixture(t);
  const first = createLearningContentRepository({ directory, now });
  await first.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan(), binding: binding() });
  await first.saveNotes({ workspaceId: uuid("1"), expectedRevision: 1, notes: notes(), binding: binding() });
  await first.addArtifact({ workspaceId: uuid("1"), expectedRevision: 2, artifact: artifact(), binding: binding() });

  const second = createLearningContentRepository({ directory, now });
  const content = await second.getContent({ workspaceId: uuid("1") });
  assert.equal(content.content.revision, 3);
  assert.deepEqual(content.content.learningPlan, plan());
  assert.deepEqual(content.content.notes, { markdownText: "这里是合成学习笔记正文", updatedAt: instant });
  assert.equal(content.content.artifacts.length, 1);
  const artifacts = await second.listArtifacts({ workspaceId: uuid("1") });
  assert.equal(artifacts.artifacts[0].title, "架构分析");
});

test("stale expectedRevision is rejected as REVISION_CONFLICT and never overwrites newer content", async (t) => {
  const { content } = await contentFixture(t);
  const saved = await content.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan(), binding: binding() });
  assert.equal(saved.content.revision, 1);
  await content.saveNotes({ workspaceId: uuid("1"), expectedRevision: 1, notes: notes("v2"), binding: binding() });

  await assert.rejects(
    content.savePlan({ workspaceId: uuid("1"), expectedRevision: 1, plan: plan({ learningGoal: "旧请求想覆盖" }), binding: binding() }),
    isContent("REVISION_CONFLICT"),
  );

  const after = await content.getContent({ workspaceId: uuid("1") });
  assert.equal(after.content.revision, 2);
  assert.deepEqual(after.content.notes, { markdownText: "v2", updatedAt: instant });
  assert.deepEqual(after.content.learningPlan, plan());

  const updated = await content.savePlan({ workspaceId: uuid("1"), expectedRevision: 2, plan: plan({ learningGoal: "新版本" }), binding: binding() });
  assert.equal(updated.content.revision, 3);
  assert.equal(updated.content.learningPlan.learningGoal, "新版本");
});

test("workspace source mismatch (repositoryId / sourceCommitSha / sourceUrl) rejects the write", async (t) => {
  const { content } = await contentFixture(t);
  await content.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan(), binding: binding("a") });

  await assert.rejects(
    content.saveNotes({ workspaceId: uuid("1"), expectedRevision: 1, notes: notes(), binding: binding("c") }),
    isContent("LEARNING_CONTENT_SOURCE_MISMATCH"),
  );
  await assert.rejects(
    content.saveNotes({ workspaceId: uuid("1"), expectedRevision: 1, notes: notes(), binding: binding("a", { repositoryId: 999 }) }),
    isContent("LEARNING_CONTENT_SOURCE_MISMATCH"),
  );
  await assert.rejects(
    content.saveNotes({ workspaceId: uuid("1"), expectedRevision: 1, notes: notes(), binding: binding("a", { sourceUrl: "https://github.com/other/repository" }) }),
    isContent("LEARNING_CONTENT_SOURCE_MISMATCH"),
  );

  const after = await content.getContent({ workspaceId: uuid("1") });
  assert.equal(after.content.revision, 1);
  assert.equal(after.content.notes, null);

  const ok = await content.saveNotes({ workspaceId: uuid("1"), expectedRevision: 1, notes: notes(), binding: binding("a") });
  assert.equal(ok.content.revision, 2);
});

test("saveNotes and addArtifact append content, bump the revision and keep timestamps", async (t) => {
  const { content } = await contentFixture(t);
  const saved = await content.saveNotes({ workspaceId: uuid("1"), expectedRevision: null, notes: notes(), binding: binding() });
  assert.equal(saved.content.revision, 1);
  assert.equal(saved.content.learningPlan.learningGoal, "");
  assert.deepEqual(saved.content.notes, { markdownText: "这里是合成学习笔记正文", updatedAt: instant });

  const withArtifact = await content.addArtifact({ workspaceId: uuid("1"), expectedRevision: 1, artifact: artifact(), binding: binding() });
  assert.equal(withArtifact.content.revision, 2);
  assert.equal(withArtifact.content.artifacts.length, 1);
  assert.match(withArtifact.content.artifacts[0].artifactId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(withArtifact.content.artifacts[0].createdAt, instant);

  const artifacts = await content.listArtifacts({ workspaceId: uuid("1") });
  assert.equal(artifacts.artifacts.length, 1);
  assert.deepEqual(artifacts.artifacts[0].type, "总结");
});

test("content containing absolute paths or credential-like text is rejected on every field", async (t) => {
  const { content } = await contentFixture(t);
  const forbidden = [
    () => content.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan({ learningGoal: "C:\\Users\\someone\\notes" }), binding: binding() }),
    () => content.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan({ expectedOutcome: "token=ghp_abcdefghijklmnopqrstuvwxyz012345" }), binding: binding() }),
    () => content.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan({ milestones: [{ milestoneId: uuid("1"), title: "/etc/passwd", done: false }], currentMilestone: null }), binding: binding() }),
    () => content.saveNotes({ workspaceId: uuid("1"), expectedRevision: null, notes: notes("api_key=sk-0123456789abcdef0123456789abcdef"), binding: binding() }),
    () => content.saveNotes({ workspaceId: uuid("1"), expectedRevision: null, notes: notes("凭据样式：authorization: Bearer abcdef"), binding: binding() }),
    () => content.addArtifact({ workspaceId: uuid("1"), expectedRevision: null, artifact: artifact({ markdownText: "本地路径引用 file://C:\\Users\\someone\\notes.md" }), binding: binding() }),
    () => content.addArtifact({ workspaceId: uuid("1"), expectedRevision: null, artifact: artifact({ title: "password=secret" }), binding: binding() }),
  ];
  for (const attempt of forbidden) {
    await assert.rejects(attempt(), isContent("LEARNING_CONTENT_INVALID_INPUT"));
  }
  await assert.rejects(
    content.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan({ currentMilestone: uuid("9"), milestones: [{ milestoneId: uuid("1"), title: "有效", done: false }] }), binding: binding() }),
    isContent("LEARNING_CONTENT_INVALID_INPUT"),
  );
  assert.equal((await content.getContent({ workspaceId: uuid("1") })).content, null);
});

test("read paths never create the store directory", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-content-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "learning");
  const content = createLearningContentRepository({ directory, now });
  assert.equal((await content.getContent({ workspaceId: uuid("1") })).content, null);
  assert.equal((await content.listArtifacts({ workspaceId: uuid("1") })).artifacts.length, 0);
  assert.equal((await content.exportContent({ workspaceId: uuid("1") })).content, null);
  await assert.rejects(lstat(directory), (error) => error.code === "ENOENT");
});

test("exportContent returns the complete record for portability without writing", async (t) => {
  const { directory, content } = await contentFixture(t);
  await content.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan(), binding: binding() });
  const exported = await content.exportContent({ workspaceId: uuid("1") });
  assert.equal(exported.content.workspaceId, uuid("1"));
  assert.deepEqual(exported.content.learningPlan, plan());
  const neverCreated = createLearningContentRepository({ directory: path.join(directory, "absent"), now });
  assert.equal((await neverCreated.exportContent({ workspaceId: uuid("1") })).content, null);
});

test("backup provider export -> validate -> replace round-trips the full content store", async (t) => {
  const { directory } = await contentFixture(t);
  const first = createLearningContentRepository({ directory, now });
  await first.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan(), binding: binding() });
  await first.saveNotes({ workspaceId: uuid("1"), expectedRevision: 1, notes: notes(), binding: binding() });

  const exported = await first.exportState();
  assert.ok(exported.records.length === 1);
  const checked = await first.validateImport(exported);
  assert.equal(checked.records.length, 1);

  const second = createLearningContentRepository({ directory, now });
  await second.savePlan({ workspaceId: uuid("2"), expectedRevision: null, plan: plan({ learningGoal: "将被恢复覆盖" }), binding: binding("b", { repositoryId: 102 }) });
  await second.replaceState(checked);

  const restored = await second.getContent({ workspaceId: uuid("1") });
  assert.equal(restored.content.revision, 2);
  assert.equal(restored.content.repositoryId, 101);
  assert.equal((await second.getContent({ workspaceId: uuid("2") })).content, null);
  await assert.rejects(
    second.validateImport({ version: 1, revision: 0, updatedAt: null, records: [{ workspaceId: uuid("1"), repositoryId: 101, sourceCommitSha: commitSha("a"), sourceUrl: "https://github.com/synthetic/repository-101", revision: 1, learningPlan: plan({ learningGoal: "C:\\Users\\bad" }), notes: null, artifacts: [], updatedAt: instant }] }),
    isContent("LEARNING_CONTENT_STORAGE_CORRUPT"),
  );
});

test("unified learning backup provider round-trips workspaces AND content, keeping confirmations out", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-content-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "learning");
  const learning = createLearningRepository({ directory, now });
  const draft = await learning.createDraft({
    repositoryId: 101,
    fullName: "synthetic/repository-101",
    sourceUrl: "https://github.com/synthetic/repository-101",
    sourceCommitSha: commitSha("a"),
    mission: { goal: "learn-usage", notes: "合成任务" },
  });
  const page = await learning.preview({ workspaceId: draft.workspace.workspaceId });
  await learning.confirm({ token: page.token });
  const workspace = (await learning.get(draft.workspace.workspaceId)).workspace;
  await learning.content.savePlan({
    workspaceId: workspace.workspaceId,
    expectedRevision: null,
    plan: plan(),
    binding: { repositoryId: workspace.repositoryId, sourceCommitSha: workspace.sourceCommitSha, sourceUrl: workspace.sourceUrl },
  });

  const provider = learning.registerBackupProvider();
  const backup = createWorkspaceBackup({ secret: Buffer.from("a".repeat(64)), providers: [provider], now });
  const bundle = await backup.exportBundle();
  assert.ok(Object.hasOwn(bundle.providers.learning.data, "contentRecords"));
  assert.ok(bundle.providers.learning.data.confirmations.length === 0);

  const preview = await backup.previewImport(bundle);
  const confirmed = await backup.confirmImport(preview.token);
  assert.equal(confirmed.restored, true);

  const restored = createLearningRepository({ directory, now });
  const restoredWorkspace = (await restored.list({ includeArchived: true })).workspaces[0];
  assert.equal(restoredWorkspace.state, "active");
  const content = await restored.content.getContent({ workspaceId: restoredWorkspace.workspaceId });
  assert.equal(content.content.learningPlan.learningGoal, "理解该仓库的核心架构");
});

test("legacy learning export without contentRecords imports cleanly and preserves existing content", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-content-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "learning");
  const learning = createLearningRepository({ directory, now });
  await learning.content.savePlan({ workspaceId: uuid("1"), expectedRevision: null, plan: plan(), binding: binding() });

  const provider = learning.registerBackupProvider();
  const exported = await provider.exportState();
  assert.ok(Object.hasOwn(exported, "contentRecords"));
  const legacy = { ...exported };
  delete legacy.contentRecords;

  const checked = await provider.validateImport(legacy);
  assert.ok(!Object.hasOwn(checked, "contentRecords"));
  const transaction = await provider.stageImport(checked);
  try {
    await transaction.commit();
  } finally {
    await transaction.cleanup();
  }

  const after = await learning.content.getContent({ workspaceId: uuid("1") });
  assert.equal(after.content.learningPlan.learningGoal, "理解该仓库的核心架构");
});