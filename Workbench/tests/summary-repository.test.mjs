import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSummaryRepository } from "../server/summaries/summary-repository.mjs";

const commitSha = (char) => char.repeat(40);
const blobSha = (marker) => `${marker}${"a".repeat(39)}`;

function contentPatch(patch = {}) {
  return {
    problemSolved: "Solves synthesis of local AI dashboards",
    coreCapabilities: "Radar, learning workspaces, repositories",
    techStack: "Node, React, Vite",
    keyModules: "server/ai-radar, server/learning",
    suitableUseCases: "Single-user local knowledge work",
    unsuitableUseCases: "Multi-tenant production hosting",
    learningGoalCandidates: "Understand architecture; adopt the loop",
    risksAndBoundaries: "Loopback-only; no cloud persistence",
    ...patch,
  };
}

function recordPatch({ repositoryId = 101, sourceCommitSha = commitSha("a"), readmeSha = blobSha("1"), readmeRef = commitSha("a"), patch = {} } = {}) {
  return {
    repositoryId,
    fullName: "synthetic/repository-101",
    sourceUrl: "https://github.com/synthetic/repository-101",
    sourceCommitSha,
    readmeSha,
    readmeRef,
    readmePath: "README.md",
    sections: contentPatch(patch),
    model: { providerId: "fake-provider", modelId: "fake-model-v1" },
    workflowVersion: 1,
  };
}

async function realStore(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "summary-repo-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const directory = path.join(root, "summaries");
  return { root, directory, store: createSummaryRepository({ directory, now: () => new Date("2026-09-02T06:00:00.000Z") }) };
}

function isCode(code) {
  return (error) => Boolean(error?.code === code);
}

test("persistSummary writes a bound record and returns it", async (t) => {
  const { store } = await realStore(t);
  const { summary, duplicate } = await store.persistSummary(recordPatch());
  assert.equal(duplicate, false);
  assert.ok(/^[0-9a-f-]{36}$/.test(summary.summaryId), "summary id is a uuid");
  assert.equal(summary.sourceCommitSha, commitSha("a"));
  assert.equal(summary.readmeSha, blobSha("1"));
  assert.equal(summary.generatedAt, "2026-09-02T06:00:00.000Z");
  assert.equal(summary.repositoryId, 101);
  assert.equal(summary.sourceUrl, "https://github.com/synthetic/repository-101");
  assert.equal(summary.model.providerId, "fake-provider");
  assert.equal(summary.sections.problemSolved, contentPatch().problemSolved);
  assert.equal(JSON.stringify(summary).includes("token"), false, "record carries no credentials");
});

test("persistSummary is idempotent per generation key and never duplicates identical summaries", async (t) => {
  const { store } = await realStore(t);
  const first = await store.persistSummary(recordPatch());
  const second = await store.persistSummary(recordPatch());
  assert.equal(second.duplicate, true);
  assert.equal(second.summary.summaryId, first.summary.summaryId);
  // Only one file write happened: the idempotent path returns without a mutation.
  const listed = await store.listSummaries({ repositoryId: 101 });
  assert.equal(listed.summaries.length, 1);
});

test("a new commit appends a new summary and preserves the old one as history", async (t) => {
  const { store } = await realStore(t);
  const old = await store.persistSummary(recordPatch({ sourceCommitSha: commitSha("a") }));
  const mid = await store.persistSummary(recordPatch({ sourceCommitSha: commitSha("b") }));
  const newer = await store.persistSummary(recordPatch({ sourceCommitSha: commitSha("c") }));
  assert.equal(newer.duplicate, false);

  const latest = await store.getSummary({ repositoryId: 101 });
  assert.equal(latest.summary.summaryId, newer.summary.summaryId);
  assert.equal(latest.summary.sourceCommitSha, commitSha("c"));

  // Exact-commit lookup never lets an old summary pretend to be a new commit.
  const byOld = await store.getSummaryByCommit({ repositoryId: 101, sourceCommitSha: commitSha("a") });
  assert.equal(byOld.summary.summaryId, old.summary.summaryId);
  assert.equal(byOld.summary.sourceCommitSha, commitSha("a"));
  const byMid = await store.getSummaryByCommit({ repositoryId: 101, sourceCommitSha: commitSha("b") });
  assert.equal(byMid.summary.summaryId, mid.summary.summaryId);

  // History lists newest first and only for the requested repository.
  const history = await store.listSummaries({ repositoryId: 101 });
  assert.deepEqual(history.summaries.map((item) => item.sourceCommitSha), [commitSha("c"), commitSha("b"), commitSha("a")]);
  const other = await store.listSummaries({ repositoryId: 999 });
  assert.deepEqual(other.summaries, []);
  assert.equal((await store.getSummary({ repositoryId: 999 })).summary, null);
  assert.equal((await store.getSummaryByCommit({ repositoryId: 999, sourceCommitSha: commitSha("a") })).summary, null);
});

test("the same commit with a different readme version is a different input version", async (t) => {
  const { store } = await realStore(t);
  const v1 = await store.persistSummary(recordPatch({ readmeSha: blobSha("1") }));
  const v2 = await store.persistSummary(recordPatch({ readmeSha: blobSha("2") }));
  assert.equal(v2.duplicate, false);
  assert.notEqual(v2.summary.summaryId, v1.summary.summaryId);
  assert.equal((await store.listSummaries({ repositoryId: 101 })).summaries.length, 2);
});

test("read-only queries never create the store directory and missing stores read as empty", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "summary-repo-ro-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const directory = path.join(root, "summaries");
  const store = createSummaryRepository({ directory, now: () => new Date() });
  assert.deepEqual((await store.listSummaries({ repositoryId: 101 })).summaries, []);
  assert.equal((await store.getSummary({ repositoryId: 101 })).summary, null);
  assert.equal((await store.exportState()).summaries.length, 0);
  await assert.rejects(access(directory), { code: "ENOENT" }, "read path must not create the directory");
});

test("persisted summaries survive a fresh repository instance on the same directory", async (t) => {
  const { directory } = await realStore(t);
  const first = createSummaryRepository({ directory, now: () => new Date("2026-09-02T06:00:00.000Z") });
  await first.persistSummary(recordPatch({ sourceCommitSha: commitSha("a") }));
  await first.persistSummary(recordPatch({ sourceCommitSha: commitSha("b") }));

  const restarted = createSummaryRepository({ directory, now: () => new Date("2026-09-02T07:00:00.000Z") });
  const latest = await restarted.getSummary({ repositoryId: 101 });
  assert.equal(latest.summary.sourceCommitSha, commitSha("b"));
  assert.equal((await restarted.listSummaries({ repositoryId: 101 })).summaries.length, 2);
  const byOld = await restarted.getSummaryByCommit({ repositoryId: 101, sourceCommitSha: commitSha("a") });
  assert.equal(byOld.summary.sourceCommitSha, commitSha("a"));
});

test("persistSummary rejects invalid records: bad commits, unknown fields, duplicate keys and unsafe content", async (t) => {
  const { store } = await realStore(t);
  await assert.rejects(store.persistSummary(recordPatch({ sourceCommitSha: "not-a-sha" })), isCode("SUMMARY_INVALID_INPUT"));
  await assert.rejects(store.persistSummary({ ...recordPatch(), extra: "sneaky" }), isCode("SUMMARY_INVALID_INPUT"));
  // A repository without a README writes a record with a null readme identity.
  const withoutReadme = await store.persistSummary(recordPatch({ readmeSha: null, readmeRef: null, readmePath: null }));
  assert.equal(withoutReadme.duplicate, false);
  assert.equal(withoutReadme.summary.readmeSha, null);
  assert.equal(withoutReadme.summary.readmeRef, null);
  const dupe = await store.persistSummary(recordPatch({ readmeSha: null, readmeRef: null, readmePath: null }));
  assert.equal(dupe.duplicate, true);
  await assert.rejects(store.persistSummary(recordPatch({ patch: { problemSolved: "token C:\\Users\\owner\\AppData leaked" } })), isCode("SUMMARY_INVALID_INPUT"), "absolute paths are rejected");
  await assert.rejects(store.persistSummary(recordPatch({ patch: { problemSolved: "credential api_key=abc123 raw" } })), isCode("SUMMARY_INVALID_INPUT"), "credential-like assignments are rejected");
});

test("a corrupt store file surfaces SUMMARY_STORAGE_CORRUPT and a fresh store does not claim data", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "summary-repo-corrupt-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const directory = path.join(root, "summaries");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "summaries.json"), "<not-json>%corrupt%", "utf8");
  const store = createSummaryRepository({ directory, now: () => new Date() });
  await assert.rejects(store.getSummary({ repositoryId: 101 }), isCode("SUMMARY_STORAGE_CORRUPT"));
  await assert.rejects(store.exportState(), isCode("SUMMARY_STORAGE_CORRUPT"));
  await assert.rejects(store.listSummaries({ repositoryId: 101 }), isCode("SUMMARY_STORAGE_CORRUPT"));
});

test("backup provider contract round-trips, rejects unknown versions and rejects unsafe imports", async (t) => {
  const { store } = await realStore(t);
  await store.persistSummary(recordPatch({ sourceCommitSha: commitSha("a") }));
  const provider = store.registerBackupProvider();
  assert.equal(provider.id, "summaries");
  assert.equal(provider.schemaVersion, 1);
  assert.equal(provider.optionalForImport, true);

  // round-trip through replaceState
  const exported = await provider.exportState();
  assert.equal(exported.summaries.length, 1);
  assert.equal(JSON.stringify(exported).includes("ghp_"), false);
  const other = await realStore(t);
  await other.store.replaceState(exported);
  assert.equal((await other.store.listSummaries({ repositoryId: 101 })).summaries.length, 1);

  await assert.rejects(provider.validateImport({ version: 2 }), isCode("SUMMARY_STORAGE_VERSION_UNSUPPORTED"));
  await assert.rejects(provider.validateImport({ ...exported, summaries: exported.summaries.map((item) => ({ ...item, sourceCommitSha: "not-a-sha" })) }), isCode("SUMMARY_STORAGE_CORRUPT"));
  // A duplicate generation key in an import is invalid.
  await assert.rejects(provider.validateImport({ ...exported, summaries: [exported.summaries[0], exported.summaries[0]] }), isCode("SUMMARY_STORAGE_CORRUPT"));
  // Unsafe content (credential-like text) cannot be imported.
  const tainted = { ...exported, summaries: exported.summaries.map((item) => ({ ...item, sections: { ...item.sections, problemSolved: "leak ghp_abcdefghijklmnopqrstuvwxyz" } })) };
  await assert.rejects(provider.validateImport(tainted), isCode("SUMMARY_STORAGE_CORRUPT"));
});

test("stageImport commits atomically and rollback restores the previous valid store", async (t) => {
  const { store } = await realStore(t);
  await store.persistSummary(recordPatch({ sourceCommitSha: commitSha("a") }));
  const provider = store.registerBackupProvider();

  // The exclusive import transaction owns the serialized queue until cleanup,
  // so reads settle only after the transaction is closed — mirroring the
  // learning store contract that restoration orchestration relies on. The same
  // transaction first commits the empty bundle, then rolls its own commit
  // back to the 1-record file that existed before it.
  const staged = await provider.stageImport({ ...(await provider.exportState()), summaries: [] });
  await staged.commit();
  await staged.rollback();
  await staged.cleanup();
  assert.equal((await store.listSummaries({ repositoryId: 101 })).summaries.length, 1);
  assert.equal((await store.getSummary({ repositoryId: 101 })).summary.sourceCommitSha, commitSha("a"));

  // A separate transaction commits atomically without rollback.
  const second = await provider.stageImport({ ...(await provider.exportState()), summaries: [] });
  await second.commit();
  await second.cleanup();
  assert.deepEqual((await store.listSummaries({ repositoryId: 101 })).summaries, []);
});

test("unknown keys in an input are rejected with a stable error", async (t) => {
  const { store } = await realStore(t);
  await assert.rejects(store.persistSummary({ ...recordPatch(), summaryId: randomUUID() }), isCode("SUMMARY_INVALID_INPUT"));
});