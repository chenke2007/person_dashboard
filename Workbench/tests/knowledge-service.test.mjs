import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildVaultIndex } from "../server/vault-index.mjs";
import { createChatStore } from "../server/knowledge-chat/store.mjs";
import { createKnowledgeService } from "../server/knowledge-chat/service.mjs";

async function setup(t, model) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "knowledge-service-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const vaultRoot = path.join(tmp, "vault");
  await mkdir(path.join(vaultRoot, ".raw"), { recursive: true });
  await writeFile(path.join(vaultRoot, ".raw/backup.sql"), "-- backup\nselect synthetic_probe;");
  const index = await buildVaultIndex(vaultRoot, { profile: "obsidian" });
  const store = createChatStore({ directory: path.join(tmp, "state") });
  const session = await store.create();
  const service = createKnowledgeService({ getIndex: async () => index, vaultRoot, store, model });
  return { service, store, session, index, vaultRoot };
}
test("agent searches and reads evidence then persists cited answer without Vault writes", async (t) => {
  let call = 0, id;
  const model = { async complete({ messages, onText }) {
    call++;
    if (call === 1) return { content: [{ type: "tool_use", id: "t1", name: "read_document", input: { documentId: id } }], stopReason: "tool_use" };
    assert.ok(JSON.stringify(messages.at(-1)).includes("synthetic_probe"));
    onText("备份资料 [S1]");
    return { content: [{ type: "text", text: "备份资料 [S1]" }], stopReason: "end_turn" };
  } };
  const ctx = await setup(t, model); id = ctx.index.documents[0].id;
  const before = await readdir(ctx.vaultRoot, { recursive: true });
  const events = [];
  const result = await ctx.service.run(ctx.session.id, { question: "backup", mode: "ask", documentIds: [] }, { emit: (event) => events.push(event) });
  assert.equal(result.messages.at(-1).status, "complete");
  assert.equal(result.messages.at(-1).sources[0].documentId, id);
  assert.match(result.messages.at(-1).content, /#source-S1/);
  assert.ok(events.some((event) => event.type === "tool"));
  assert.deepEqual(await readdir(ctx.vaultRoot, { recursive: true }), before);
  assert.equal((await ctx.store.get(ctx.session.id)).messages.length, 2);
});
test("unknown execution tools fail and never run commands", async (t) => {
  const ctx = await setup(t, { async complete() { return { content: [{ type: "tool_use", id: "bad", name: "bash", input: { command: "echo unsafe" } }], stopReason: "tool_use" }; } });
  await assert.rejects(ctx.service.run(ctx.session.id, { question: "help" }), { code: "TOOL_DENIED" });
  assert.equal((await ctx.store.get(ctx.session.id)).messages.at(-1).status, "failed");
});
test("abort persists interrupted response, never creates an organize draft", async (t) => {
  const controller = new AbortController();
  const ctx = await setup(t, { async complete({ onText }) { onText("partial"); controller.abort(); throw new DOMException("Aborted", "AbortError"); } });
  await assert.rejects(ctx.service.run(ctx.session.id, { question: "backup", mode: "organize" }, { signal: controller.signal }));
  const result = await ctx.store.get(ctx.session.id);
  assert.equal(result.messages.at(-1).status, "cancelled");
  assert.equal(result.drafts.length, 0);
});

test("organizing without evidence fails instead of inventing a source-backed draft", async (t) => {
  const ctx = await setup(t, { async complete() { return { content: [{ type: "text", text: "# General advice\nNo matching fixture." }], stopReason: "end_turn" }; } });
  await assert.rejects(ctx.service.run(ctx.session.id, { question: "unmatched_unique_probe", mode: "organize" }), { code: "NO_DRAFT_SOURCES" });
  assert.equal((await ctx.store.get(ctx.session.id)).drafts.length, 0);
});

test("endless model tool requests stop at the round budget", async (t) => {
  let calls = 0;
  const ctx = await setup(t, { async complete() { calls++; return { content: [{ type: "tool_use", id: `t${calls}`, name: "search_documents", input: { query: "backup" } }], stopReason: "tool_use" }; } });
  await assert.rejects(ctx.service.run(ctx.session.id, { question: "backup" }), { code: "ROUND_LIMIT" });
  assert.equal(calls, 8);
  assert.equal((await ctx.store.get(ctx.session.id)).messages.at(-1).status, "failed");
});

test("concurrent turns in one session are rejected before adding duplicate messages", async (t) => {
  let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const ctx = await setup(t, { async complete() { entered(); await new Promise((resolve) => { release = resolve; }); return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" }; } });
  const first = ctx.service.run(ctx.session.id, { question: "backup" });
  await ready;
  await assert.rejects(ctx.service.run(ctx.session.id, { question: "duplicate" }), { code: "CHAT_BUSY" });
  release(); await first;
  assert.equal((await ctx.store.get(ctx.session.id)).messages.length, 2);
});

test("restoring a session marks orphaned generation interrupted and retains its checkpoint", async (t) => {
  const ctx = await setup(t, {});
  await ctx.store.update(ctx.session.id, (record) => { record.messages.push({ id: "interrupted", role: "assistant", runId: "old-process", status: "running", content: "已接收的部分回答", sources: [] }); });
  const restored = await ctx.service.getSession(ctx.session.id);
  assert.equal(restored.messages[0].status, "interrupted");
  assert.equal(restored.messages[0].content, "已接收的部分回答");
  assert.equal(restored.messages[0].error.code, "INTERRUPTED");
  assert.equal((await ctx.store.get(ctx.session.id)).messages[0].status, "interrupted");
});

test("stream checkpoints survive a service replacement without marking an active turn interrupted", async (t) => {
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const ctx = await setup(t, { async complete({ onText }) {
    onText("部分回答 [S1]");
    await new Promise((resolve) => { release = resolve; entered(); });
    return { content: [{ type: "text", text: "完整回答 [S1]" }], stopReason: "end_turn" };
  } });
  const task = ctx.service.run(ctx.session.id, { question: "backup" });
  try {
    await ready;
    const live = await ctx.service.getSession(ctx.session.id);
    assert.equal(live.messages.at(-1).status, "running");
    assert.equal(live.messages.at(-1).content, "部分回答 [S1]");
    assert.equal(live.messages.at(-1).sources.length, 1);
    const restarted = createKnowledgeService({ getIndex: async () => ctx.index, vaultRoot: ctx.vaultRoot, store: ctx.store, model: {} });
    const restored = await restarted.getSession(ctx.session.id);
    assert.equal(restored.messages.at(-1).status, "interrupted");
    assert.equal(restored.messages.at(-1).content, "部分回答 [S1]");
  } finally { release(); await task; }
});

test("cancelling after draft creation removes only this turn's draft and never emits completion", async (t) => {
  const controller = new AbortController();
  const ctx = await setup(t, { async complete() { return { content: [{ type: "text", text: "# Backup\nTest [S1]" }], stopReason: "end_turn" }; } });
  await ctx.store.update(ctx.session.id, (record) => { record.drafts.push({ id: "older-draft", body: "keep" }); });
  const service = createKnowledgeService({ ...ctx, getIndex: async () => ctx.index, model: { async complete() { return { content: [{ type: "text", text: "# Backup\nTest [S1]" }], stopReason: "end_turn" }; } }, drafts: { async create(id) {
    const draft = { id: "new-draft", body: "cancelled" };
    await ctx.store.update(id, (record) => { record.drafts.push(draft); });
    controller.abort();
    return draft;
  } } });
  const events = [];
  await assert.rejects(service.run(ctx.session.id, { question: "backup", mode: "organize" }, { signal: controller.signal, emit: (event) => events.push(event) }));
  const result = await ctx.store.get(ctx.session.id);
  assert.deepEqual(result.drafts.map((draft) => draft.id), ["older-draft"]);
  assert.equal(result.messages.at(-1).status, "cancelled");
  assert.equal(events.some((event) => ["draft", "done"].includes(event.type)), false);
});
