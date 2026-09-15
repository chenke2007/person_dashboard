import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INGESTION_RECEIPT_TTL_MS,
  INGESTION_TOKEN_TTL_MS,
} from "../server/learning/learning-ingestion-schema.mjs";
import { createLearningIngestionRepository } from "../server/learning/learning-ingestion-repository.mjs";

const uuid = (char) => char.repeat(8) + "-2222-4333-8444-555555555555";
const sha = (char) => char.repeat(40);
const fingerprint = (char) => char.repeat(64);
const filePlanHashFor = (paths) => createHash("sha256").update(JSON.stringify(paths)).digest("hex");

async function fixture(t, { now = () => new Date("2026-09-02T06:00:00.000Z") } = {}) {
  const stableTempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(stableTempRoot, "workbench-ingest-store-"));
  const directory = path.join(root, "learning");
  await mkdir(directory, { recursive: true });
  const store = createLearningIngestionRepository({ directory, now });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory, store, now };
}

const binding = { fingerprint: fingerprint("f"), workspaceId: "workspace-abc123" };
const selection = (overrides = {}) => ({
  targetVaultId: fingerprint("a"),
  targetVaultDisplayName: "目标知识库",
  targetMaskedPath: "…/目标知识库",
  ...overrides,
});
const files = () => ([
  { relativePath: "Wiki/学习/synthetic-repo-1/学习计划.md", kind: "plan", artifactId: null, existed: false },
  { relativePath: "Wiki/学习/synthetic-repo-1/学习笔记.md", kind: "notes", artifactId: null, existed: true },
]);
const selectedTypes = () => ["plan", "notes"];
const previewInput = (overrides = {}) => ({
  workspaceId: uuid("a"),
  binding,
  sourceCommitSha: sha("b"),
  contentRevision: 3,
  selectedContentTypes: selectedTypes(),
  files: files(),
  filePlanHash: filePlanHashFor(["Wiki/学习/synthetic-repo-1/学习笔记.md", "Wiki/学习/synthetic-repo-1/学习计划.md"]),
  target: selection(),
  ...overrides,
});

test("setSelection persists a stable per-workspace target selection", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = uuid("a");

  let got = await store.setSelection({ workspaceId, ...selection() });
  assert.equal(got.selection.targetVaultId, fingerprint("a"));
  assert.equal(got.selection.workspaceId, workspaceId);

  got = await store.getSelection(workspaceId);
  assert.equal(got.selection.targetVaultId, fingerprint("a"));
  assert.equal(got.selection.targetVaultDisplayName, "目标知识库");

  assert.equal((await store.getSelection(uuid("b"))).selection, null);
});

test("issuePreview issues a short-lived token bound to workspace, binding, target, source and content revision", async (t) => {
  const { store, directory, now } = await fixture(t);
  const input = previewInput();
  await store.setSelection({ workspaceId: input.workspaceId, ...selection() });

  const preview = await store.issuePreview(input);
  assert.ok(typeof preview.token === "string" && preview.token.length >= 32);
  assert.equal(Date.parse(preview.expiresAt), Date.parse(now()) + INGESTION_TOKEN_TTL_MS);
  assert.equal(preview.previewRevision >= 1, true);
  assert.equal(preview.record.status, "previewed");
  assert.equal(preview.record.workspaceId, input.workspaceId);

  // The store file keeps only the digest, never the raw token.
  const raw = await (await import("node:fs/promises")).readFile(path.join(directory, "learning-ingestion.json"), "utf8");
  const stored = JSON.parse(raw);
  const digest = createHash("sha256").update(preview.token).digest("hex");
  assert.ok(stored.tokens.length >= 1);
  assert.ok(stored.tokens.some((token) => token.tokenDigest === digest));
  for (const token of stored.tokens) {
    assert.ok(!Object.hasOwn(token, "token"));
  }
});

test("beginConfirm verifies every binding before allowing the write", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = uuid("a");
  await store.setSelection({ workspaceId, ...selection() });
  const preview = await store.issuePreview(previewInput({ workspaceId }));

  const args = {
    token: preview.token,
    sourceCommitSha: sha("b"),
    contentRevision: 3,
    targetVaultId: fingerprint("a"),
    selectedContentTypes: selectedTypes(),
    filePlanHash: filePlanHashFor(["Wiki/学习/synthetic-repo-1/学习笔记.md", "Wiki/学习/synthetic-repo-1/学习计划.md"]),
    binding,
  };
  const started = await store.beginConfirm(args);
  assert.equal(started.tokenRecord.tokenDigest, createHash("sha256").update(preview.token).digest("hex"));

  // Content drift
  await assert.rejects(
    store.beginConfirm({ ...args, contentRevision: 4 }),
    (error) => error.code === "INGESTION_CONTENT_CHANGED" && error.status === 409,
  );
  // Source drift
  await assert.rejects(
    store.beginConfirm({ ...args, sourceCommitSha: sha("c") }),
    (error) => error.code === "INGESTION_SOURCE_CHANGED" && error.status === 409,
  );
  // Target drift
  await assert.rejects(
    store.beginConfirm({ ...args, targetVaultId: fingerprint("b") }),
    (error) => error.code === "INGESTION_TARGET_CHANGED" && error.status === 409,
  );
  // App-binding drift
  await assert.rejects(
    store.beginConfirm({ ...args, binding: { fingerprint: fingerprint("c"), workspaceId: "workspace-other" } }),
    (error) => error.code === "INGESTION_BINDING_CHANGED" && error.status === 409,
  );
  // Plan drift
  await assert.rejects(
    store.beginConfirm({ ...args, filePlanHash: filePlanHashFor(["changed"]) }),
    (error) => error.code === "INGESTION_PLAN_MISMATCH" && error.status === 409,
  );
});

test("confirm writes a receipt and the same token replays idempotently until the receipt expires", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = uuid("a");
  await store.setSelection({ workspaceId, ...selection() });
  const preview = await store.issuePreview(previewInput({ workspaceId }));
  const args = {
    token: preview.token,
    sourceCommitSha: sha("b"),
    contentRevision: 3,
    targetVaultId: fingerprint("a"),
    selectedContentTypes: selectedTypes(),
    filePlanHash: filePlanHashFor(["Wiki/学习/synthetic-repo-1/学习笔记.md", "Wiki/学习/synthetic-repo-1/学习计划.md"]),
    binding,
  };

  await store.beginConfirm(args);
  const done = await store.finishConfirm({
    token: preview.token,
    outcome: { status: "written", writtenFiles: files().map((file) => file.relativePath) },
  });
  assert.equal(done.record.status, "written");
  assert.equal(done.receipt.status, "written");

  // Idempotent replay: the same token returns the original receipt.
  const replayed = await store.beginConfirm(args);
  assert.equal(replayed.receipt.status, "written");
  assert.deepEqual(replayed.receipt.writtenFiles, files().map((file) => file.relativePath));
  assert.equal(replayed.record.writtenAt, done.record.writtenAt);
});

test("an unused token expires and a replayed receipt expires with clear codes", async (t) => {
  let clock = Date.parse("2026-09-02T06:00:00.000Z");
  const { store } = await fixture(t, { now: () => new Date(clock) });
  const workspaceId = uuid("a");
  await store.setSelection({ workspaceId, ...selection() });
  const preview = await store.issuePreview(previewInput({ workspaceId }));
  const args = {
    token: preview.token,
    sourceCommitSha: sha("b"),
    contentRevision: 3,
    targetVaultId: fingerprint("a"),
    selectedContentTypes: selectedTypes(),
    filePlanHash: filePlanHashFor(["Wiki/学习/synthetic-repo-1/学习笔记.md", "Wiki/学习/synthetic-repo-1/学习计划.md"]),
    binding,
  };

  clock += INGESTION_TOKEN_TTL_MS + 1;
  await assert.rejects(
    store.beginConfirm(args),
    (error) => error.code === "INGESTION_TOKEN_INVALID" && error.status === 410,
  );

  // A consumed receipt outlives the token window but dies with its own TTL.
  clock = Date.parse("2026-09-02T06:00:00.000Z");
  const again = await store.issuePreview(previewInput({ workspaceId }));
  await store.beginConfirm({ ...args, token: again.token });
  await store.finishConfirm({ token: again.token, outcome: { status: "written", writtenFiles: [] } });
  clock += INGESTION_RECEIPT_TTL_MS + 1;
  await assert.rejects(
    store.beginConfirm({ ...args, token: again.token }),
    (error) => error.code === "INGESTION_TOKEN_INVALID" && error.status === 410,
  );
});

test("failed confirms keep the token retryable and record a failed status with a safe error", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = uuid("a");
  await store.setSelection({ workspaceId, ...selection() });
  const preview = await store.issuePreview(previewInput({ workspaceId }));
  const args = {
    token: preview.token,
    sourceCommitSha: sha("b"),
    contentRevision: 3,
    targetVaultId: fingerprint("a"),
    selectedContentTypes: selectedTypes(),
    filePlanHash: filePlanHashFor(["Wiki/学习/synthetic-repo-1/学习笔记.md", "Wiki/学习/synthetic-repo-1/学习计划.md"]),
    binding,
  };

  await store.beginConfirm(args);
  await store.finishConfirm({ token: preview.token, outcome: { status: "failed", errorCode: "INGESTION_WRITE_FAILED", errorMessage: "写入 Obsidian 失败，已回滚本次尝试。" } });

  let listed = await store.listRecords(workspaceId);
  assert.equal(listed.records[0].status, "failed");
  assert.equal(listed.records[0].errorCode, "INGESTION_WRITE_FAILED");
  assert.equal(listed.records[0].targetVaultDisplayName, "目标知识库");

  // The same token can be tried again, and the previous failure stays visible.
  const retried = await store.beginConfirm(args);
  assert.equal(retried.tokenRecord.lastAttempt.errorCode, "INGESTION_WRITE_FAILED");
  listed = await store.listRecords(workspaceId);
  assert.equal(listed.records[0].status, "confirmed");
});

test("changing the target selection marks the latest record draft so the preview is stale", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = uuid("a");
  await store.setSelection({ workspaceId, ...selection() });
  await store.issuePreview(previewInput({ workspaceId }));

  await store.setSelection({ workspaceId, ...selection({ targetVaultId: fingerprint("b"), targetVaultDisplayName: "另一个知识库" }) });
  const { records } = await store.listRecords(workspaceId);
  assert.equal(records[0].status, "draft");

  // And the old preview cannot be confirmed against the new target.
  const preview = await store.issuePreview(previewInput({ workspaceId, target: selection({ targetVaultId: fingerprint("b"), targetVaultDisplayName: "另一个知识库" }) }));
  await assert.rejects(
    store.beginConfirm({
      token: preview.token,
      sourceCommitSha: sha("b"),
      contentRevision: 3,
      targetVaultId: fingerprint("a"),
      selectedContentTypes: selectedTypes(),
      filePlanHash: filePlanHashFor(["Wiki/学习/synthetic-repo-1/学习笔记.md", "Wiki/学习/synthetic-repo-1/学习计划.md"]),
      binding,
    }),
    (error) => error.code === "INGESTION_TARGET_CHANGED",
  );
});

test("exports never carry tokens, import rejects token material, and a token-free export round-trips records", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = uuid("a");
  await store.setSelection({ workspaceId, ...selection() });
  await store.issuePreview(previewInput({ workspaceId }));

  const exported = await store.exportState();
  assert.equal(exported.version, 1);
  assert.ok(!Object.hasOwn(exported, "tokens"), "tokens must never be exported");
  assert.ok(exported.records.length >= 1);
  assert.ok(exported.selections.length >= 1);

  await assert.rejects(
    store.validateImport({ ...exported, tokens: [{ tokenDigest: sha("0") }] }),
    (error) => error.status === 400,
  );

  const directory = await secondDirectory(t);
  const second = createLearningIngestionRepository({ directory });
  const checked = await second.validateImport(exported);
  await second.replaceState(checked);
  const restored = await second.listRecords(workspaceId);
  assert.deepEqual(restored.records.map((record) => record.status), ["previewed"]);
  const restoredSelection = await second.getSelection(workspaceId);
  assert.equal(restoredSelection.selection.targetVaultId, fingerprint("a"));
});

async function secondDirectory(t) {
  const stableTempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(stableTempRoot, "workbench-ingest-store-2-"));
  const directory = path.join(root, "learning");
  await mkdir(directory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return directory;
}

test("exports stay within the token-free schema after a full write flow", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = uuid("a");
  await store.setSelection({ workspaceId, ...selection() });
  const preview = await store.issuePreview(previewInput({ workspaceId }));
  const args = {
    token: preview.token,
    sourceCommitSha: sha("b"),
    contentRevision: 3,
    targetVaultId: fingerprint("a"),
    selectedContentTypes: selectedTypes(),
    filePlanHash: filePlanHashFor(["Wiki/学习/synthetic-repo-1/学习笔记.md", "Wiki/学习/synthetic-repo-1/学习计划.md"]),
    binding,
  };
  await store.beginConfirm(args);
  await store.finishConfirm({ token: preview.token, outcome: { status: "written", writtenFiles: ["Wiki/学习/synthetic-repo-1/学习计划.md"] } });

  const exported = await store.exportState();
  assert.ok(!Object.hasOwn(exported, "tokens"));
  const { records } = exported;
  assert.equal(records[0].status, "written");
  assert.deepEqual(records[0].writtenFiles, ["Wiki/学习/synthetic-repo-1/学习计划.md"]);
});