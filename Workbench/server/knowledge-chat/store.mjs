import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { fail } from "./errors.mjs";

const MAX_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const queues = new Map();

function validId(id) {
  if (typeof id !== "string" || !UUID.test(id)) fail("INVALID_SESSION_ID", "会话标识无效。");
}

function validate(session, expectedId) {
  if (!session || typeof session !== "object" || Array.isArray(session) || session.id !== expectedId ||
      typeof session.title !== "string" || session.title.length > 240 ||
      !Array.isArray(session.messages) || !Array.isArray(session.drafts) ||
      session.messages.length > 2000 || session.drafts.length > 100 ||
      !Number.isFinite(Date.parse(session.createdAt)) || !Number.isFinite(Date.parse(session.updatedAt))) {
    fail("SESSION_CORRUPT", "会话记录格式损坏，未修改原记录。", 500);
  }
  return session;
}

async function safeDirectory(directory) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let entry;
    try { entry = await lstat(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (creation) { if (creation.code !== "EEXIST") throw creation; }
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail("SESSION_UNSAFE_PATH", "会话存储目录不安全。", 500);
  }
}

export function createChatStore({ directory }) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("SESSION_UNSAFE_PATH", "会话存储目录无效。", 500);
  const root = path.resolve(directory);
  const queueKey = process.platform === "win32" ? root.toLowerCase() : root;

  function serialized(operation) {
    const previous = queues.get(queueKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      try { await safeDirectory(root); return await operation(); }
      catch (error) {
        if (error?.status) throw error;
        fail("SESSION_STORAGE_ERROR", "会话存储暂时不可用，未确认保存。", 500);
      }
    });
    queues.set(queueKey, task);
    task.then(() => { if (queues.get(queueKey) === task) queues.delete(queueKey); }, () => { if (queues.get(queueKey) === task) queues.delete(queueKey); });
    return task;
  }

  async function read(id) {
    validId(id);
    const target = path.join(root, `${id}.json`);
    let details;
    try { details = await lstat(target); }
    catch (error) { if (error.code === "ENOENT") fail("SESSION_NOT_FOUND", "会话不存在。", 404); throw error; }
    if (details.isSymbolicLink() || !details.isFile()) fail("SESSION_UNSAFE_PATH", "会话记录路径不安全。", 500);
    if (details.size > MAX_BYTES) fail("SESSION_TOO_LARGE", "会话记录超出容量限制。", 413);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.size > MAX_BYTES) fail("SESSION_TOO_LARGE", "会话记录超出容量限制。", 413);
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    if (bytes.length > MAX_BYTES) fail("SESSION_TOO_LARGE", "会话记录超出容量限制。", 413);
    let record;
    try { record = JSON.parse(bytes.toString("utf8")); }
    catch { fail("SESSION_CORRUPT", "会话记录损坏，未修改原记录。", 500); }
    return validate(record, id);
  }

  async function write(session, { isNew = false } = {}) {
    validId(session?.id);
    validate(session, session.id);
    let body;
    try { body = JSON.stringify(session); }
    catch { fail("SESSION_CORRUPT", "会话记录格式无效。", 500); }
    if (Buffer.byteLength(body) > MAX_BYTES) fail("SESSION_TOO_LARGE", "会话容量已满，请新建会话。", 413);
    if (!isNew) await read(session.id); // Never replace a corrupt, missing, or linked record.
    const target = path.join(root, `${session.id}.json`);
    const temporary = path.join(root, `.${session.id}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close(); handle = null;
      await safeDirectory(root);
      if (!isNew) await read(session.id);
      else {
        try { await lstat(target); fail("SESSION_STORAGE_ERROR", "会话标识冲突，请重试。", 500); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await rename(temporary, target);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
    return structuredClone(session);
  }

  return {
    async create() {
      return serialized(async () => {
        const timestamp = new Date().toISOString();
        return write({ id: randomUUID(), title: "新会话", messages: [], drafts: [], createdAt: timestamp, updatedAt: timestamp }, { isNew: true });
      });
    },
    async get(id) { validId(id); return serialized(() => read(id)); },
    async list() {
      return serialized(async () => {
        const names = await readdir(root);
        const summaries = [];
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          const id = name.slice(0, -5);
          if (!UUID.test(id)) continue;
          const session = await read(id);
          summaries.push({ id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: session.messages.length, draftCount: session.drafts.length });
        }
        return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
    },
    async save(session) {
      validId(session?.id);
      const snapshot = structuredClone(session);
      return serialized(() => write({ ...snapshot, updatedAt: new Date().toISOString() }));
    },
    async update(id, mutator) {
      validId(id);
      if (typeof mutator !== "function") fail("INVALID_INPUT", "会话更新无效。");
      return serialized(async () => {
        const session = await read(id);
        const replacement = await mutator(session);
        const updated = replacement === undefined ? session : replacement;
        if (updated?.id !== id) fail("INVALID_SESSION_ID", "更新不能修改会话标识。");
        updated.updatedAt = new Date().toISOString();
        return write(updated);
      });
    },
  };
}
