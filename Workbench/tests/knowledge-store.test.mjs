import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createChatStore } from "../server/knowledge-chat/store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "state");
  return { root, directory, store: createChatStore({ directory }) };
}

test("sessions persist and list summaries without messages or draft tokens", async (t) => {
  const { directory, store } = await fixture(t);
  const session = await store.create();
  assert.match(session.id, /^[a-f0-9-]{36}$/);
  session.title = "Synthetic conversation";
  session.messages.push({ role: "user", text: "Synthetic question" });
  session.drafts.push({ id: "demo", confirmationToken: "never-in-list" });
  await store.save(session);
  const restored = await createChatStore({ directory }).get(session.id);
  assert.equal(restored.messages[0].text, "Synthetic question");
  const summary = (await store.list())[0];
  assert.equal(summary.title, "Synthetic conversation");
  assert.equal(summary.messageCount, 1);
  assert.equal("messages" in summary, false);
  assert.equal("drafts" in summary, false);
  assert.equal(JSON.stringify(summary).includes("never-in-list"), false);
});

test("async updates use latest stored session without lost concurrent changes", async (t) => {
  const { store } = await fixture(t);
  const session = await store.create();
  await Promise.all(Array.from({ length: 15 }, (_, index) => store.update(session.id, async (current) => {
    await Promise.resolve();
    current.messages.push({ role: "user", text: String(index) });
  })));
  assert.equal((await store.get(session.id)).messages.length, 15);
});

test("corrupt session fails closed and save cannot overwrite its original bytes", async (t) => {
  const { store, directory } = await fixture(t);
  const session = await store.create();
  const target = path.join(directory, `${session.id}.json`);
  await writeFile(target, "{corrupt synthetic record");
  for (const operation of [() => store.get(session.id), () => store.save(session), () => store.update(session.id, () => {}), () => store.list()]) {
    await assert.rejects(operation(), { code: "SESSION_CORRUPT", status: 500 });
  }
  assert.equal(await readFile(target, "utf8"), "{corrupt synthetic record");
});

test("path IDs, oversized records and uncreated records fail without creating files", async (t) => {
  const { store, directory } = await fixture(t);
  for (const id of ["../escape", "C:\\outside", "x/y", ".", "a:stream"]) {
    await assert.rejects(store.get(id), { code: "INVALID_SESSION_ID" });
    await assert.rejects(store.update(id, () => {}), { code: "INVALID_SESSION_ID" });
  }
  const session = await store.create();
  session.messages.push({ text: "x".repeat(9 * 1024 * 1024) });
  await assert.rejects(store.save(session), { code: "SESSION_TOO_LARGE" });
  assert.equal((await store.get(session.id)).messages.length, 0);
  await assert.rejects(store.get("00000000-0000-4000-8000-000000000000"), { code: "SESSION_NOT_FOUND" });
  assert.equal((await readdir(directory)).length, 1);
});

test("session directory junctions and session file links are denied without path leakage", async (t) => {
  const { root, directory, store } = await fixture(t);
  const external = path.join(root, "external");
  await mkdir(external);
  await symlink(external, directory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.create(), (error) => error.code === "SESSION_UNSAFE_PATH" && !error.message.includes(root));
  assert.deepEqual(await readdir(external), []);
  await rm(directory);
  const session = await store.create();
  const target = path.join(directory, `${session.id}.json`);
  await rm(target);
  await symlink(external, target, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.get(session.id), { code: "SESSION_UNSAFE_PATH" });
});
