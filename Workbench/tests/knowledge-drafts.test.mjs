import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { buildVaultIndex, searchIndex } from "../server/vault-index.mjs";
import { createChatStore } from "../server/knowledge-chat/store.mjs";
import { createDraftService } from "../server/knowledge-chat/drafts.mjs";

const rawText = "# Synthetic Oracle reference\nSynthetic RMAN rehearsal; no production commands.\n";
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-drafts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, "vault"), directory = path.join(root, "state");
  await mkdir(path.join(vaultRoot, ".raw"), { recursive: true });
  await writeFile(path.join(vaultRoot, ".raw/source.md"), rawText);
  await writeFile(path.join(vaultRoot, ".raw/secrets.json"), '{"synthetic":"excluded"}');
  let index = await buildVaultIndex(vaultRoot, { profile: "obsidian" });
  const document = searchIndex(index, "RMAN")[0];
  const source = { key: "S1", documentId: document.id, title: document.title, path: document.path, hash: createHash("sha256").update(rawText).digest("hex"), start: 0, end: rawText.length, excerpt: rawText };
  const store = createChatStore({ directory });
  const session = await store.create();
  let clock = new Date("2026-08-28T00:00:00Z");
  const notified = [];
  const serviceOptions = { store, vaultRoot, getIndex: async () => index, notifyPaths: async (paths) => { notified.push(...paths); }, enabled: true, now: () => clock, ...options };
  const drafts = createDraftService(serviceOptions);
  const create = (data = {}) => drafts.create(session.id, { title: "Synthetic rehearsal", body: "## Checks\nVerify the synthetic evidence. [S1]", sources: [source], ...data });
  return { root, vaultRoot, directory, store, session, source, drafts, create, notified, serviceOptions, setClock: (value) => { clock = value; }, refresh: async () => { index = await buildVaultIndex(vaultRoot, { profile: "obsidian" }); } };
}

test("preview creates no Vault file; confirmation creates only the approved Markdown with evidence", async (t) => {
  const f = await fixture(t);
  const draft = await f.create();
  assert.equal(draft.version, 1);
  assert.equal(draft.category, "concepts");
  assert.equal("confirmationToken" in draft, false);
  const preview = await f.drafts.preview(f.session.id, draft.id);
  assert.equal(preview.path, "wiki/concepts/Synthetic rehearsal.md");
  assert.match(preview.documentBody, /AI|生成/);
  assert.match(preview.documentBody, /\.raw\/source\.md/);
  assert.deepEqual(await readdir(f.vaultRoot), [".raw"]);
  const receipt = await f.drafts.commit(f.session.id, draft.id, { version: preview.version, confirmationToken: preview.confirmationToken });
  assert.equal(receipt.path, preview.path);
  assert.equal(typeof receipt.documentId, "string");
  assert.equal(receipt.indexPending, false);
  assert.equal(await readFile(path.join(f.vaultRoot, receipt.path), "utf8"), preview.documentBody);
  assert.equal(await readFile(path.join(f.vaultRoot, ".raw/source.md"), "utf8"), rawText);
  assert.deepEqual(f.notified, [receipt.path]);
  assert.deepEqual((await readdir(path.join(f.vaultRoot, "wiki"))).sort(), ["concepts"]);
});

test("unsafe titles, categories, oversized body and empty or fabricated evidence are rejected", async (t) => {
  const f = await fixture(t);
  for (const title of ["../escape", "x/y", "x\\y", "C:\\outside", "CON", "nul.txt", "AUX", "COM1", "a:stream", ".hidden", "ending.", "ending ", "a\nb", "a..b", "", "x".repeat(121)]) {
    await assert.rejects(f.create({ title }), { code: "INVALID_DRAFT" });
  }
  for (const category of ["../../raw", "raw", "concepts/nested"]) await assert.rejects(f.create({ category }), { code: "INVALID_DRAFT" });
  await assert.rejects(f.create({ body: "x".repeat(128 * 1024 + 1) }), { code: "INVALID_DRAFT" });
  await assert.rejects(f.create({ sources: [] }), { code: "SOURCE_REQUIRED" });
  for (const sources of [[{ ...f.source, hash: "0".repeat(64) }], [{ ...f.source, path: ".raw/secrets.json" }], [{ ...f.source, documentId: "missing" }]]) {
    await assert.rejects(f.create({ sources }), (error) => ["SOURCE_CHANGED", "SOURCE_UNAVAILABLE"].includes(error.code));
  }
  assert.deepEqual(await readdir(f.vaultRoot), [".raw"]);
});

test("revising invalidates prior confirmation and commits only the exact reviewed version", async (t) => {
  const f = await fixture(t);
  const draft = await f.create();
  const old = await f.drafts.preview(f.session.id, draft.id);
  const revised = await f.drafts.revise(f.session.id, draft.id, { title: "Revised synthetic", category: "questions", body: "Confirm this question. [S1]" });
  assert.equal(revised.version, 2);
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, { version: old.version, confirmationToken: old.confirmationToken }), { code: "DRAFT_CONFIRMATION_INVALID" });
  const current = await f.drafts.preview(f.session.id, draft.id);
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, { version: current.version, confirmationToken: "tampered" }), { code: "DRAFT_CONFIRMATION_INVALID" });
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, { version: current.version + 1, confirmationToken: current.confirmationToken }), { code: "DRAFT_CONFIRMATION_INVALID" });
  const saved = await f.drafts.commit(f.session.id, draft.id, { version: current.version, confirmationToken: current.confirmationToken });
  assert.equal(saved.path, "wiki/questions/Revised synthetic.md");
});

test("confirmation expires and source bytes are rechecked even with a stale index", async (t) => {
  const f = await fixture(t);
  const draft = await f.create();
  const preview = await f.drafts.preview(f.session.id, draft.id);
  f.setClock(new Date("2026-08-28T00:30:00Z"));
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, { version: preview.version, confirmationToken: preview.confirmationToken }), { code: "DRAFT_CONFIRMATION_EXPIRED" });
  const renewed = await f.drafts.preview(f.session.id, draft.id);
  await writeFile(path.join(f.vaultRoot, ".raw/source.md"), `${rawText}Changed`);
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, { version: renewed.version, confirmationToken: renewed.confirmationToken }), { code: "SOURCE_CHANGED" });
  assert.deepEqual(await readdir(f.vaultRoot), [".raw"]);
});

test("existing targets are never overwritten, including matching content", async (t) => {
  const f = await fixture(t);
  const draft = await f.create();
  const preview = await f.drafts.preview(f.session.id, draft.id);
  await mkdir(path.join(f.vaultRoot, "wiki/concepts"), { recursive: true });
  await writeFile(path.join(f.vaultRoot, preview.path), preview.documentBody);
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, { version: preview.version, confirmationToken: preview.confirmationToken }), { code: "DRAFT_PATH_EXISTS" });
  assert.equal(await readFile(path.join(f.vaultRoot, preview.path), "utf8"), preview.documentBody);
});

test("concurrent confirmations and service restarts return one durable receipt", async (t) => {
  const f = await fixture(t);
  const draft = await f.create();
  const preview = await f.drafts.preview(f.session.id, draft.id);
  const confirmation = { version: preview.version, confirmationToken: preview.confirmationToken };
  const receipts = await Promise.all(Array.from({ length: 8 }, () => f.drafts.commit(f.session.id, draft.id, confirmation)));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  const restored = createDraftService({ ...f.serviceOptions, store: createChatStore({ directory: f.directory }) });
  assert.deepEqual(await restored.commit(f.session.id, draft.id, confirmation), receipts[0]);
  assert.deepEqual(await readdir(path.join(f.vaultRoot, "wiki/concepts")), ["Synthetic rehearsal.md"]);
  assert.equal(f.notified.length, 1);
});

test("index failure reports saved/pending and never rewrites on retry", async (t) => {
  const f = await fixture(t, { notifyPaths: async () => { throw new Error("synthetic index unavailable"); } });
  const draft = await f.create(), preview = await f.drafts.preview(f.session.id, draft.id);
  const input = { version: preview.version, confirmationToken: preview.confirmationToken };
  const receipt = await f.drafts.commit(f.session.id, draft.id, input);
  assert.equal(receipt.indexPending, true);
  await writeFile(path.join(f.vaultRoot, receipt.path), "User edits after saved receipt");
  assert.deepEqual(await f.drafts.commit(f.session.id, draft.id, input), receipt);
  assert.equal(await readFile(path.join(f.vaultRoot, receipt.path), "utf8"), "User edits after saved receipt");
});

test("disabled write service, cross-session drafts and parent junction escapes cannot create", async (t) => {
  const f = await fixture(t);
  const draft = await f.create(), preview = await f.drafts.preview(f.session.id, draft.id);
  const confirmation = { version: preview.version, confirmationToken: preview.confirmationToken };
  const disabled = createDraftService({ ...f.serviceOptions, enabled: false });
  await assert.rejects(disabled.commit(f.session.id, draft.id, confirmation), { code: "DRAFT_WRITE_DISABLED" });
  const other = await f.store.create();
  await assert.rejects(f.drafts.commit(other.id, draft.id, confirmation), { code: "DRAFT_NOT_FOUND" });
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(f.vaultRoot, "wiki"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, confirmation), { code: "DRAFT_UNSAFE_PATH" });
  assert.deepEqual(await readdir(outside), []);
});

test("persisted body or path tampering invalidates confirmation before writing", async (t) => {
  const f = await fixture(t);
  const draft = await f.create(), preview = await f.drafts.preview(f.session.id, draft.id);
  await f.store.update(f.session.id, (session) => { session.drafts[0].body = "changed without revision"; });
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, { version: preview.version, confirmationToken: preview.confirmationToken }), { code: "DRAFT_CONFIRMATION_INVALID" });
  assert.deepEqual(await readdir(f.vaultRoot), [".raw"]);
});

test("Windows console device titles are rejected before draft creation", async (t) => {
  const f = await fixture(t);
  for (const title of ["CONIN$", "CONOUT$", "CLOCK$", "conout$.notes"]) {
    await assert.rejects(f.create({ title }), { code: "INVALID_DRAFT" });
  }
});

test("C1 control characters are not accepted in file titles", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.create({ title: "Synthetic\u0085title" }), { code: "INVALID_DRAFT" });
});

test("corrupt expiry state cannot silently disable token expiration", async (t) => {
  const f = await fixture(t);
  const draft = await f.create(), preview = await f.drafts.preview(f.session.id, draft.id);
  await f.store.update(f.session.id, (session) => { session.drafts[0]._confirmation.expiresAt = "invalid timestamp"; });
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, { version: preview.version, confirmationToken: preview.confirmationToken }), { code: "DRAFT_CONFIRMATION_INVALID" });
  assert.deepEqual(await readdir(f.vaultRoot), [".raw"]);
});

test("draft creation sanitizes operational failures into typed path-free errors", async (t) => {
  const f = await fixture(t);
  const unavailable = createDraftService({ ...f.serviceOptions, getIndex: async () => { throw new Error(`Unavailable synthetic directory ${f.root}`); } });
  await assert.rejects(unavailable.create(f.session.id, { title: "Test", body: "Synthetic body", sources: [f.source] }), (error) => error.code === "DRAFT_STORAGE_ERROR" && error.status === 500 && !error.message.includes(f.root));
});

test("completed write recovers after receipt persistence failure without rewriting", async (t) => {
  const f = await fixture(t);
  const draft = await f.create(), preview = await f.drafts.preview(f.session.id, draft.id);
  const input = { version: preview.version, confirmationToken: preview.confirmationToken };
  const interruptedStore = { ...f.store, update: (id, mutator) => f.store.update(id, async (session) => {
    await mutator(session);
    if (session.drafts.some((item) => item.receipt)) throw new Error("Synthetic receipt storage interruption");
  }) };
  const interrupted = createDraftService({ ...f.serviceOptions, store: interruptedStore });
  await assert.rejects(interrupted.commit(f.session.id, draft.id, input), { code: "SESSION_STORAGE_ERROR" });
  const target = path.join(f.vaultRoot, preview.path);
  const before = await lstat(target);
  assert.equal(await readFile(target, "utf8"), preview.documentBody);
  assert.equal((await f.store.get(f.session.id)).drafts[0].receipt, undefined);
  const recovered = createDraftService({ ...f.serviceOptions, store: createChatStore({ directory: f.directory }) });
  const receipt = await recovered.commit(f.session.id, draft.id, input);
  assert.equal(receipt.path, preview.path);
  assert.equal((await lstat(target)).mtimeMs, before.mtimeMs);
  assert.deepEqual(f.notified, [preview.path]);
});

test("interrupted or externally replaced partial files never become successful receipts", async (t) => {
  const f = await fixture(t);
  const draft = await f.create(), preview = await f.drafts.preview(f.session.id, draft.id);
  const input = { version: preview.version, confirmationToken: preview.confirmationToken };
  const interruptedStore = { ...f.store, update: (id, mutator) => f.store.update(id, async (session) => {
    await mutator(session);
    if (session.drafts.some((item) => item._commit?.phase === "writing")) throw new Error("Synthetic journal storage interruption");
  }) };
  await assert.rejects(createDraftService({ ...f.serviceOptions, store: interruptedStore }).commit(f.session.id, draft.id, input), { code: "SESSION_STORAGE_ERROR" });
  assert.equal(await readFile(path.join(f.vaultRoot, preview.path), "utf8"), "");
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, input), { code: "DRAFT_WRITE_INCOMPLETE" });
  assert.equal((await f.store.get(f.session.id)).drafts[0].receipt, undefined);
  assert.deepEqual(f.notified, []);
});

test("target junction and category junction cannot escape, and unavailable indexed sources are denied", async (t) => {
  const f = await fixture(t);
  const draft = await f.create(), preview = await f.drafts.preview(f.session.id, draft.id);
  const input = { version: preview.version, confirmationToken: preview.confirmationToken };
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await mkdir(path.join(f.vaultRoot, "wiki"));
  const category = path.join(f.vaultRoot, "wiki/concepts");
  await symlink(outside, category, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, input), { code: "DRAFT_UNSAFE_PATH" });
  await rm(category);
  await mkdir(category);
  await symlink(outside, path.join(f.vaultRoot, preview.path), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, input), { code: "DRAFT_UNSAFE_PATH" });
  assert.deepEqual(await readdir(outside), []);
  await rm(path.join(f.vaultRoot, ".raw/source.md"));
  await f.refresh();
  await assert.rejects(f.drafts.commit(f.session.id, draft.id, input), { code: "SOURCE_UNAVAILABLE" });
});

async function interruptedReceipt(t) {
  const f = await fixture(t);
  const draft = await f.create(), preview = await f.drafts.preview(f.session.id, draft.id);
  const interruptedStore = { ...f.store, update: (id, mutator) => f.store.update(id, async (session) => {
    await mutator(session);
    if (session.drafts.some((item) => item.receipt)) throw new Error("Synthetic receipt storage interruption");
  }) };
  await assert.rejects(createDraftService({ ...f.serviceOptions, store: interruptedStore }).commit(f.session.id, draft.id, { version: preview.version, confirmationToken: preview.confirmationToken }), { code: "SESSION_STORAGE_ERROR" });
  return { ...f, draft, preview, target: path.join(f.vaultRoot, preview.path) };
}

test("recovery preview after restart renews an expired token without exposing or resetting the ownership journal", async (t) => {
  const f = await interruptedReceipt(t);
  const before = await lstat(f.target);
  const journal = (await f.store.get(f.session.id)).drafts[0]._commit;
  f.setClock(new Date("2026-08-28T02:00:00Z"));
  const restoredStore = createChatStore({ directory: f.directory });
  const disabled = createDraftService({ ...f.serviceOptions, store: restoredStore, enabled: false });
  const preview = await disabled.preview(f.session.id, f.draft.id);
  assert.equal(preview.recoveryOnly, true);
  assert.equal(preview.recoveryPending, true);
  assert.equal(preview.documentBody, f.preview.documentBody);
  assert.equal(preview.path, f.preview.path);
  assert.equal(preview.version, f.preview.version);
  assert.notEqual(preview.confirmationToken, f.preview.confirmationToken);
  assert.equal(preview.expiresAt, "2026-08-28T02:30:00.000Z");
  assert.equal(Object.keys(preview).some((key) => key.startsWith("_")), false);
  assert.deepEqual((await restoredStore.get(f.session.id)).drafts[0]._commit, journal);
  assert.equal((await lstat(f.target)).mtimeMs, before.mtimeMs);
  assert.deepEqual(f.notified, []);
  const input = { version: preview.version, confirmationToken: preview.confirmationToken };
  await assert.rejects(disabled.commit(f.session.id, f.draft.id, input), { code: "DRAFT_WRITE_DISABLED" });
  const enabled = createDraftService({ ...f.serviceOptions, store: restoredStore });
  await assert.rejects(enabled.commit(f.session.id, f.draft.id, { version: f.preview.version, confirmationToken: f.preview.confirmationToken }), { code: "DRAFT_CONFIRMATION_INVALID" });
  const receipt = await enabled.commit(f.session.id, f.draft.id, input);
  assert.equal(receipt.path, preview.path);
  assert.equal(receipt.indexPending, false);
  assert.equal((await lstat(f.target)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await enabled.commit(f.session.id, f.draft.id, input), receipt);
  assert.deepEqual(f.notified, [preview.path]);
  assert.deepEqual((await restoredStore.get(f.session.id)).drafts[0].receipt, receipt);
});

test("recovery preview rejects partial, missing and identity-replaced files without renewing the token", async (t) => {
  for (const situation of ["partial", "missing", "replaced", "intent"]) await t.test(situation, async (subtest) => {
    const f = await interruptedReceipt(subtest);
    if (situation === "partial") await writeFile(f.target, "Incomplete synthetic fragment");
    if (situation === "missing") await rm(f.target);
    if (situation === "replaced") {
      const replacement = `${f.target}.replacement`;
      await writeFile(replacement, f.preview.documentBody);
      const { rename } = await import("node:fs/promises");
      await rm(f.target);
      await rename(replacement, f.target);
    }
    if (situation === "intent") await f.store.update(f.session.id, (session) => { session.drafts[0]._commit.phase = "intent"; });
    await assert.rejects(f.drafts.preview(f.session.id, f.draft.id), { code: "DRAFT_WRITE_INCOMPLETE" });
    const stored = (await f.store.get(f.session.id)).drafts[0];
    assert.equal(stored._confirmation.token, f.preview.confirmationToken);
    assert.equal(stored.receipt, undefined);
    assert.deepEqual(f.notified, []);
  });
});

test("recovery preview preserves the original snapshot and rechecks current source bytes", async (t) => {
  await t.test("changed source", async (subtest) => {
    const f = await interruptedReceipt(subtest);
    await writeFile(path.join(f.vaultRoot, ".raw/source.md"), `${rawText}Changed`);
    await assert.rejects(f.drafts.preview(f.session.id, f.draft.id), { code: "SOURCE_CHANGED" });
    assert.equal(await readFile(f.target, "utf8"), f.preview.documentBody);
  });
  await t.test("changed draft snapshot", async (subtest) => {
    const f = await interruptedReceipt(subtest);
    await f.store.update(f.session.id, (session) => { session.drafts[0].body = "Unreviewed change"; });
    await assert.rejects(f.drafts.preview(f.session.id, f.draft.id), { code: "DRAFT_CONFIRMATION_INVALID" });
    assert.equal(await readFile(f.target, "utf8"), f.preview.documentBody);
  });
});

test("recovery-only confirmation never recreates a missing target even when the journal was changed", async (t) => {
  const f = await interruptedReceipt(t);
  const preview = await f.drafts.preview(f.session.id, f.draft.id);
  await rm(f.target);
  await f.store.update(f.session.id, (session) => { session.drafts[0]._commit.phase = "intent"; });
  await assert.rejects(f.drafts.commit(f.session.id, f.draft.id, { version: preview.version, confirmationToken: preview.confirmationToken }), { code: "DRAFT_WRITE_INCOMPLETE" });
  assert.deepEqual(await readdir(path.join(f.vaultRoot, "wiki/concepts")), []);
  assert.equal((await f.store.get(f.session.id)).drafts[0].receipt, undefined);
  assert.deepEqual(f.notified, []);
});

test("recovery confirmation rechecks source and target after the refreshed preview", async (t) => {
  for (const situation of ["source", "target"]) await t.test(situation, async (subtest) => {
    const f = await interruptedReceipt(subtest);
    const preview = await f.drafts.preview(f.session.id, f.draft.id);
    if (situation === "source") await writeFile(path.join(f.vaultRoot, ".raw/source.md"), `${rawText}Changed`);
    else await writeFile(f.target, "User modification after recovery preview");
    await assert.rejects(f.drafts.commit(f.session.id, f.draft.id, { version: preview.version, confirmationToken: preview.confirmationToken }), { code: situation === "source" ? "SOURCE_CHANGED" : "DRAFT_WRITE_INCOMPLETE" });
    assert.equal((await f.store.get(f.session.id)).drafts[0].receipt, undefined);
    assert.deepEqual(f.notified, []);
  });
});

test("cancelled draft creation during source validation persists no draft", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const drafts = createDraftService({ ...f.serviceOptions, getIndex: async () => {
    const index = await f.serviceOptions.getIndex();
    controller.abort();
    return index;
  } });
  await assert.rejects(drafts.create(f.session.id, { title: "Cancelled synthetic", body: "Synthetic body", sources: [f.source] }, { signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual((await f.store.get(f.session.id)).drafts, []);
  assert.deepEqual(await readdir(f.vaultRoot), [".raw"]);
});

test("draft creation cancelled before validation never requests the index", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  let indexRequested = false;
  const drafts = createDraftService({ ...f.serviceOptions, getIndex: async () => {
    indexRequested = true;
    return f.serviceOptions.getIndex();
  } });
  await assert.rejects(drafts.create(f.session.id, { title: "Cancelled synthetic", body: "Synthetic body", sources: [f.source] }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(indexRequested, false);
  assert.deepEqual((await f.store.get(f.session.id)).drafts, []);
});

test("draft cancellation while waiting for storage is checked inside the update mutator", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const delayedStore = { ...f.store, update: async (id, mutator) => {
    controller.abort();
    return f.store.update(id, mutator);
  } };
  const drafts = createDraftService({ ...f.serviceOptions, store: delayedStore });
  await assert.rejects(drafts.create(f.session.id, { title: "Cancelled synthetic", body: "Synthetic body", sources: [f.source] }, { signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual((await f.store.get(f.session.id)).drafts, []);
  assert.deepEqual(await readdir(f.vaultRoot), [".raw"]);
});
