import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { lstat } from "node:fs/promises";

import {
  buildTargetFiles,
  planConflictResolution,
  writeVaultFiles,
} from "../server/learning/learning-ingestion-writer.mjs";

const uuid = (char) => char.repeat(8) + "-2222-4333-8444-555555555555";

async function vaultFixture(t) {
  const stableTempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(stableTempRoot, "workbench-ingest-writer-"));
  const targetRoot = path.join(root, "vault");
  await mkdir(targetRoot, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, targetRoot };
}

function contentFixture(overrides = {}) {
  return {
    learningPlan: {
      learningGoal: "理解架构",
      expectedOutcome: "能画出模块图",
      milestones: [{ milestoneId: "m1", title: "读完 README", done: false }],
      currentMilestone: null,
    },
    notes: { markdownText: "# 学习笔记\n\n关键取舍记录。\n" },
    artifacts: [
      { artifactId: uuid("a"), title: "实验报告", markdownText: "## 实验\n\n结果。\n" },
      { artifactId: uuid("b"), title: "对比分析", markdownText: "## 对比\n\nA 优于 B。\n" },
    ],
    ...overrides,
  };
}

async function exists(root, relativePath) {
  try {
    await lstat(path.join(root, ...relativePath.split("/")));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("buildTargetFiles generates the plan, notes and artifact relative paths under Wiki/学习/{sanitized-repo}", () => {
  const plan = buildTargetFiles({
    repoFullName: "synthetic/repo-101",
    selectedContentTypes: ["plan", "notes", `artifact:${uuid("a")}`],
    content: contentFixture(),
  });
  assert.deepEqual(plan.files.map((file) => file.relativePath), [
    "Wiki/学习/synthetic-repo-101/学习计划.md",
    "Wiki/学习/synthetic-repo-101/学习笔记.md",
    "Wiki/学习/synthetic-repo-101/学习产出-aaaaaaaa-2222-4333-8444-555555555555.md",
  ]);
  assert.deepEqual(plan.files.map((file) => file.kind), ["plan", "notes", "artifact"]);
  assert.equal(plan.files[2].artifactId, uuid("a"));
  assert.match(plan.files[0].markdown, /# 学习计划/);
  assert.match(plan.files[0].markdown, /理解架构/);
  assert.match(plan.files[1].markdown, /# 学习笔记/);
  assert.match(plan.files[2].markdown, /# 实验报告/);
});

test("repository names are sanitized down to safe file name characters", () => {
  const { files } = buildTargetFiles({
    repoFullName: "Owner/repo!name?/extra",
    selectedContentTypes: ["plan"],
    content: contentFixture(),
  });
  const [plan] = files;
  assert.equal(plan.relativePath, "Wiki/学习/Owner-repo-name-extra/学习计划.md");
  assert.ok(!/[\\:*?"<>|]/.test(plan.relativePath), "no unsafe file name characters may reach the vault path");
  assert.ok(!plan.relativePath.startsWith("/") && !/^[A-Za-z]:/.test(plan.relativePath), "target paths stay relative");
});

test("plan, notes and each artifact are selectable independently", () => {
  const notesOnly = buildTargetFiles({ repoFullName: "synthetic/repo-1", selectedContentTypes: ["notes"], content: contentFixture() });
  assert.deepEqual(notesOnly.files.map((file) => file.kind), ["notes"]);

  const artifactOnly = buildTargetFiles({
    repoFullName: "synthetic/repo-1",
    selectedContentTypes: [`artifact:${uuid("b")}`],
    content: contentFixture(),
  });
  assert.deepEqual(artifactOnly.files.map((file) => file.kind), ["artifact"]);
  assert.equal(artifactOnly.files[0].artifactId, uuid("b"));
});

test("selecting a content type that has no content is a structured empty-selection error", () => {
  assert.throws(
    () => buildTargetFiles({ repoFullName: "synthetic/repo-1", selectedContentTypes: ["notes"], content: contentFixture({ notes: null }) }),
    (error) => error.code === "INGESTION_EMPTY_SELECTION" && error.status === 400,
  );
  assert.throws(
    () => buildTargetFiles({ repoFullName: "synthetic/repo-1", selectedContentTypes: ["plan"], content: contentFixture({ learningPlan: null }) }),
    (error) => error.code === "INGESTION_EMPTY_SELECTION",
  );
  assert.throws(
    () => buildTargetFiles({
      repoFullName: "synthetic/repo-1",
      selectedContentTypes: ["plan", "notes"],
      content: contentFixture({ notes: null }),
    }),
    (error) => error.code === "INGESTION_EMPTY_SELECTION" && /笔记/.test(error.message),
  );
});

test("unknown selection keys are rejected before any file planning", () => {
  assert.throws(
    () => buildTargetFiles({ repoFullName: "synthetic/repo-1", selectedContentTypes: ["summary"], content: contentFixture() }),
    (error) => error.code === "INGESTION_INVALID_SELECTION",
  );
  assert.throws(
    () => buildTargetFiles({ repoFullName: "synthetic/repo-1", selectedContentTypes: ["plan", "bogus"], content: contentFixture() }),
    (error) => error.code === "INGESTION_INVALID_SELECTION",
  );
});

test("existing files are conflicts; skip leaves them untouched and new-version picks a free suffix", async (t) => {
  const { targetRoot } = await vaultFixture(t);
  const base = "Wiki/学习/synthetic-repo-1/学习计划.md";
  await mkdir(path.join(targetRoot, "Wiki", "学习", "synthetic-repo-1"), { recursive: true });
  await writeFile(path.join(targetRoot, ...base.split("/")), "ORIGINAL\n", "utf8");

  const files = buildTargetFiles({ repoFullName: "synthetic/repo-1", selectedContentTypes: ["plan"], content: contentFixture() });
  const previewExistence = files.files.map((file) => ({ relativePath: file.relativePath, existed: true }));

  const skipPlan = await planConflictResolution({ targetRoot, files: files.files, previewExistence, resolution: "skip" });
  assert.equal(skipPlan[0].mode, "skip");
  assert.equal(skipPlan[0].relativePath, base);

  const versionPlan = await planConflictResolution({ targetRoot, files: files.files, previewExistence, resolution: "new-version" });
  assert.equal(versionPlan[0].mode, "new-version");
  assert.equal(versionPlan[0].relativePath, "Wiki/学习/synthetic-repo-1/学习计划-2.md");

  const written = await writeVaultFiles({ targetRoot, plan: versionPlan });
  assert.deepEqual(written.written.map((item) => item.relativePath), [versionPlan[0].relativePath]);
  assert.equal(await readFile(path.join(targetRoot, ...base.split("/")), "utf8"), "ORIGINAL\n");
  assert.match(await readFile(path.join(targetRoot, ...versionPlan[0].relativePath.split("/")), "utf8"), /# 学习计划/);
});

test("a file whose existence changed since the preview is a conflict-changed error", async (t) => {
  const { targetRoot } = await vaultFixture(t);
  const files = buildTargetFiles({ repoFullName: "synthetic/repo-1", selectedContentTypes: ["plan"], content: contentFixture() });
  // Preview said the file was absent; it now exists - the preview is stale.
  await mkdir(path.join(targetRoot, "Wiki", "学习", "synthetic-repo-1"), { recursive: true });
  await writeFile(path.join(targetRoot, ...files.files[0].relativePath.split("/")), "NEW\n", "utf8");
  await assert.rejects(
    planConflictResolution({
      targetRoot,
      files: files.files,
      previewExistence: [{ relativePath: files.files[0].relativePath, existed: false }],
      resolution: "skip",
    }),
    (error) => error.code === "INGESTION_CONFLICT_CHANGED" && error.status === 409,
  );
  // Preview said it existed; it is now gone - the preview is stale in the
  // reverse direction too: only an all-consistent snapshot can be confirmed.
  await (await import("node:fs/promises")).unlink(path.join(targetRoot, ...files.files[0].relativePath.split("/")));
  await assert.rejects(
    planConflictResolution({
      targetRoot,
      files: files.files,
      previewExistence: [{ relativePath: files.files[0].relativePath, existed: true }],
      resolution: "skip",
    }),
    (error) => error.code === "INGESTION_CONFLICT_CHANGED" && error.status === 409,
  );
});

test("multi-file write writes every file exactly with its planned content", async (t) => {
  const { targetRoot } = await vaultFixture(t);
  const files = buildTargetFiles({
    repoFullName: "synthetic/repo-1",
    selectedContentTypes: ["plan", "notes", `artifact:${uuid("a")}`],
    content: contentFixture(),
  });
  const previewExistence = files.files.map((file) => ({ relativePath: file.relativePath, existed: false }));
  const plan = await planConflictResolution({ targetRoot, files: files.files, previewExistence, resolution: "skip" });
  const { written } = await writeVaultFiles({ targetRoot, plan });
  assert.deepEqual(written.map((item) => item.relativePath), files.files.map((file) => file.relativePath));
  for (const entry of plan) {
    const body = await readFile(path.join(targetRoot, ...entry.relativePath.split("/")), "utf8");
    assert.ok(body.length > 0);
  }
});

test("a mid-batch failure rolls back every already-written file in reverse order", async (t) => {
  const { targetRoot } = await vaultFixture(t);
  await mkdir(path.join(targetRoot, "Wiki", "学习"), { recursive: true });
  // The second file's parent directory is blocked by a regular FILE, so any
  // directory creation under it must fail after the first file was written.
  await writeFile(path.join(targetRoot, "Wiki", "学习", "repo-b"), "A FILE\n", "utf8");
  const plan = [
    { kind: "plan", artifactId: null, relativePath: "Wiki/学习/repo-a/学习计划.md", markdown: "# 1\n", mode: "create" },
    { kind: "notes", artifactId: null, relativePath: "Wiki/学习/repo-b/学习笔记.md", markdown: "# 2\n", mode: "create" },
  ];

  await assert.rejects(
    writeVaultFiles({ targetRoot, plan }),
    (error) => error.code === "INGESTION_UNSAFE_PATH" || error.code === "INGESTION_WRITE_FAILED",
  );
  // The first file must have been rolled back: no partial artifacts remain.
  assert.equal(await exists(targetRoot, "Wiki/学习/repo-a/学习计划.md"), false);
});

test("escaped or absolute target paths are rejected before any directory creation", async (t) => {
  const { targetRoot } = await vaultFixture(t);
  const evil = [
    { kind: "plan", artifactId: null, relativePath: "../outside.md", markdown: "# x" },
  ];
  await assert.rejects(
    planConflictResolution({ targetRoot, files: evil, previewExistence: [{ existed: false }], resolution: "skip" }),
    (error) => error.code === "INGESTION_UNSAFE_PATH",
  );
  await assert.rejects(
    writeVaultFiles({ targetRoot, plan: evil }),
    (error) => error.code === "INGESTION_UNSAFE_PATH",
  );
});

test("a symlinked directory that escapes the vault root is rejected during write", async (t) => {
  const { root, targetRoot } = await vaultFixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, path.join(targetRoot, "Wiki"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    return t.skip(`symlinks unavailable on this host: ${error?.code ?? error?.message}`);
  }
  const files = buildTargetFiles({ repoFullName: "synthetic/repo-1", selectedContentTypes: ["plan"], content: contentFixture() });
  const previewExistence = files.files.map((file) => ({ relativePath: file.relativePath, existed: false }));
  const plan = await planConflictResolution({ targetRoot, files: files.files, previewExistence, resolution: "skip" });
  // The realpath of the symlinked Wiki lands outside the target root.
  await assert.rejects(
    writeVaultFiles({ targetRoot, plan }),
    (error) => error.code === "INGESTION_UNSAFE_PATH",
  );
  assert.equal(await exists(targetRoot, ".link-parent/Wiki/学习/synthetic-repo-1/学习计划.md"), false);
});