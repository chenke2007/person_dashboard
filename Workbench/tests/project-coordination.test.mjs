import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createProjectRepository } from "../server/projects/project-repository.mjs";
import { emptyProjectStore } from "../server/projects/project-schema.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synthetic-project-coordination-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = createProjectRepository({ directory });
  const created = await repository.createProject({ key: "SYN", name: "Synthetic original" });
  const task = await repository.createTask({ projectId: created.project.id, title: "Synthetic task" });
  return { directory, repository, created, task, target: path.join(directory, "projects.json") };
}

async function worker(t, args) {
  const child = fork(new URL("./fixtures/project-store-worker.mjs", import.meta.url), [], { silent: true });
  const messages = [];
  child.on("message", (message) => messages.push(message));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill(); await exited;
    }
  });
  async function wait(phase) {
    const deadline = Date.now() + 10_000;
    while (!messages.some((message) => message.phase === phase)) {
      const error = messages.find((message) => message.phase === "error");
      if (error && phase !== "error") throw new Error(JSON.stringify(error));
      assert.ok(Date.now() < deadline && child.exitCode === null, `waiting for ${phase}: ${stderr}`);
      await delay(10);
    }
    return messages.find((message) => message.phase === phase);
  }
  await wait("ready");
  child.send({ type: "start", ...args });
  await wait("started");
  return { wait, messages, release: () => child.send({ type: "release" }) };
}

test("two processes cannot lose a successful writer or both accept the same revision", async (t) => {
  const { directory, repository, created, task } = await fixture(t);
  const before = await repository.exportState();
  const first = await worker(t, { directory, action: "link", taskId: task.task.id });
  await first.wait("reading");
  const second = await worker(t, { directory, action: "move", input: { taskId: task.task.id, columnId: created.columns[0].id, index: 0, revision: before.revision } });
  await delay(200);
  const completedEarly = second.messages.some((message) => ["done", "error"].includes(message.phase));
  first.release();
  await first.wait("done");
  assert.equal(completedEarly, false, "second writer must wait for first read/check/write");
  const result = await second.wait("error");
  assert.equal(result.code, "PROJECT_REVISION_CONFLICT");
  assert.equal((await repository.exportState()).taskLinks.length, 1);
  const third = await worker(t, { directory, action: "rename", projectId: created.project.id });
  await third.wait("done");
  const final = await repository.exportState();
  assert.equal(final.projects[0].name, "Synthetic concurrent writer");
  assert.equal(final.taskLinks.length, 1);
  assert.equal(final.revision, before.revision + 2);
});

test("independent repository instances retain both successful concurrent mutations", async (t) => {
  const { directory, repository, created, task } = await fixture(t);
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const peer = createProjectRepository({ directory, resolveDocument: async (id) => { entered(); await barrier; return { id, path: id, kind: "wiki" }; } });
  const link = peer.addTaskLink({ taskId: task.task.id, documentId: "wiki/synthetic.md" });
  await ready;
  const rename = repository.updateProject(created.project.id, { name: "Synthetic concurrent rename" });
  await delay(100); release();
  await Promise.all([link, rename]);
  const state = await repository.exportState();
  assert.equal(state.projects[0].name, "Synthetic concurrent rename");
  assert.equal(state.taskLinks.length, 1);
  assert.equal(state.revision, 4);
});

for (const rollback of [false, true]) {
  test(`cross-process restore owns staging through cleanup (rollback=${rollback})`, async (t) => {
    const { directory, repository, created } = await fixture(t);
    const state = await repository.exportState();
    state.projects[0].name = "Synthetic restored";
    const restore = await worker(t, { directory, action: "restore", state, rollback });
    await restore.wait("staged");
    const writer = await worker(t, { directory, action: "rename", projectId: created.project.id });
    await delay(200);
    const beforeCommit = writer.messages.some((message) => message.phase === "done");
    restore.release();
    await restore.wait("committed");
    await delay(150);
    const beforeCleanup = writer.messages.some((message) => message.phase === "done");
    restore.release();
    await restore.wait("done");
    await writer.wait("done");
    assert.equal(beforeCommit, false);
    assert.equal(beforeCleanup, false);
    assert.equal((await repository.exportState()).projects[0].name, "Synthetic concurrent writer");
  });
}

test("valid restore repairs malformed JSON and later provider failure rolls back exact raw bytes in a child process", async (t) => {
  const { directory, repository, target } = await fixture(t);
  const state = await repository.exportState();
  const raw = Buffer.from([0xff, 0xfe, 0x7b, 0x22, 0x00, 0x0d, 0x0a]);
  await writeFile(target, raw);
  const failed = await worker(t, { directory, action: "backup-failure", state });
  assert.equal((await failed.wait("error")).code, "WORKSPACE_RESTORE_COMMIT_FAILED");
  assert.deepEqual(await readFile(target), raw);
  const restore = await worker(t, { directory, action: "restore", state });
  await restore.wait("staged"); restore.release();
  await restore.wait("committed"); restore.release();
  await restore.wait("done");
  assert.deepEqual(await repository.exportState(), state);
});

test("restore refuses unsupported destination versions, oversized bytes, invalid import and junction destinations", async (t) => {
  const { directory, repository, target } = await fixture(t);
  for (const body of [JSON.stringify({ version: 99, sentinel: "synthetic" }), JSON.stringify({ version: "future" }), Buffer.alloc(32 * 1024 * 1024 + 1, 0x20)]) {
    await writeFile(target, body);
    await assert.rejects(repository.stageImport(emptyProjectStore()));
    assert.deepEqual(await readFile(target), Buffer.from(body));
  }
  await writeFile(target, "{malformed");
  await assert.rejects(repository.stageImport({ ...emptyProjectStore(), tasks: [{}] }));
  assert.equal(await readFile(target, "utf8"), "{malformed");
  const outside = path.join(directory, "outside");
  const linked = path.join(directory, "linked");
  await mkdir(outside);
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createProjectRepository({ directory: linked }).stageImport(emptyProjectStore()));
  await assert.rejects(access(path.join(outside, "projects.json")));
});

test("read-only access to an absent project store creates no files or lock directories", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synthetic-lazy-projects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const absent = path.join(directory, "absent");
  const repository = createProjectRepository({ directory: absent });
  assert.deepEqual(await repository.exportState(), emptyProjectStore());
  await assert.rejects(access(absent));
});
