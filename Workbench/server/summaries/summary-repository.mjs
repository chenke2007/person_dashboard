import { constants, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createTicketLock } from "../workspace-state/ticket-lock.mjs";
import {
  MAX_SUMMARY_BYTES,
  emptySummaryStore,
  summaryGenerationKey,
  summaryRecordInputSchema,
  summaryRecordSchema,
  summaryStoreSchema,
} from "./summary-schema.mjs";

const FILE_NAME = "summaries.json";
const MAX_BYTES = MAX_SUMMARY_BYTES;

export class SummaryRepositoryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "SummaryRepositoryError";
    this.code = code;
    this.status = status;
  }
}
function fail(code, message, status = 400) {
  throw new SummaryRepositoryError(code, message, status);
}
function checked(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
  return result.data;
}

// A single authoritative JSON file holds every summary record, so a write
// either fully lands (atomic tmp -> fsync -> rename) or leaves the prior file
// intact. Mirrors the learning workspace store invariants: ticket-lock
// serialization, read-only queries never create the directory, and generation
// keys make regeneration idempotent while different commits append history.
export function createSummaryRepository({ directory, now = () => new Date(), makeId = () => randomUUID() } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("SUMMARY_STORAGE_PATH_INVALID", "仓库摘要存储目录无效。", 500);
  if (typeof makeId !== "function" || typeof now !== "function") fail("SUMMARY_STORAGE_PATH_INVALID", "仓库摘要存储依赖无效。", 500);
  const root = path.resolve(directory);
  const target = path.join(root, FILE_NAME);
  let queue = Promise.resolve();
  let canonicalRoot = null;

  const clock = () => {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      fail("SUMMARY_INVALID_CLOCK", "仓库摘要时钟必须返回有效日期。", 500);
    }
    return value.toISOString();
  };

  async function ensureDirectory({ create = true } = {}) {
    for (let candidate = root; ; candidate = path.dirname(candidate)) {
      try {
        const details = await lstat(candidate);
        if (details.isSymbolicLink() || !details.isDirectory()) fail("SUMMARY_STORAGE_PATH_UNSAFE", "仓库摘要存储目录不安全。", 500);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (path.dirname(candidate) === candidate) break;
    }
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    let details;
    try { details = await lstat(root); } catch (error) {
      if (!create && error?.code === "ENOENT") return null;
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      fail("SUMMARY_STORAGE_PATH_UNSAFE", "仓库摘要存储目录不安全。", 500);
    }
    const actual = path.resolve(await realpath(root));
    const comparable = process.platform === "win32" ? actual.toLowerCase() : actual;
    if (canonicalRoot && canonicalRoot !== comparable) {
      fail("SUMMARY_STORAGE_PATH_UNSAFE", "仓库摘要存储目录不安全。", 500);
    }
    canonicalRoot = comparable;
    return comparable;
  }

  const withWriteLock = createTicketLock({ directory: path.join(root, "summaries.lock"), ensureDirectory, fail, codePrefix: "SUMMARY_STORAGE" });

  async function readRawStore() {
    if (!await ensureDirectory({ create: false })) return null;
    let details;
    try {
      details = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_BYTES) {
      fail("SUMMARY_STORAGE_CORRUPT", "仓库摘要数据文件无效或超过容量限制。", 500);
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      const current = await lstat(target);
      if (!opened.isFile() || current.isSymbolicLink() || !current.isFile() || opened.ino !== details.ino || current.ino !== opened.ino || opened.size > MAX_BYTES) {
        fail("SUMMARY_STORAGE_CORRUPT", "仓库摘要数据文件无效或超过容量限制。", 500);
      }
      const bytes = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > opened.size) fail("SUMMARY_STORAGE_CORRUPT", "仓库摘要数据文件在读取期间发生变化。", 500);
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }

  async function readStore() {
    const raw = await readRawStore();
    if (raw === null) return emptySummaryStore();
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      fail("SUMMARY_STORAGE_CORRUPT", "仓库摘要数据文件无法解析。", 500);
    }
    if (parsed?.version !== 1) {
      fail("SUMMARY_STORAGE_VERSION_UNSUPPORTED", "仓库摘要数据版本不受支持。", 500);
    }
    const result = summaryStoreSchema.safeParse(parsed);
    if (!result.success) fail("SUMMARY_STORAGE_CORRUPT", "仓库摘要数据文件格式无效。", 500);
    return result.data;
  }

  async function writeStore(store) {
    const valid = summaryStoreSchema.safeParse(store);
    if (!valid.success) fail("SUMMARY_STORAGE_CORRUPT", "仓库摘要数据未通过完整性检查。", 500);
    const body = `${JSON.stringify(valid.data, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("SUMMARY_STORAGE_TOO_LARGE", "仓库摘要数据超过容量限制。", 413);
    const temporary = await writeTemporary(body, "tmp");
    try {
      await ensureDirectory();
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return valid.data;
  }

  async function writeTemporary(body, suffix) {
    const temporary = path.join(root, `.${FILE_NAME}.${randomUUID()}.${suffix}`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      return temporary;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function serialized(operation, { write = false } = {}) {
    const execute = () => write ? withWriteLock(operation) : operation();
    const result = queue.then(execute, execute);
    queue = result.catch(() => {});
    return result;
  }

  function mutate(operation) {
    return serialized(async () => {
      const store = await readStore();
      const result = operation(store);
      store.revision += 1;
      store.updatedAt = clock();
      await writeStore(store);
      return structuredClone(result);
    }, { write: true });
  }

  // Newest-first ordering by generatedAt with ties broken by insertion order
  // (the later-appended record wins), so "latest" stays deterministic even when
  // timestamps collide — fixed clocks in tooling or same-millisecond writes.
  function newestFirst(records) {
    return [...records]
      .map((item, index) => ({ item, index }))
      .sort((left, right) => right.item.generatedAt.localeCompare(left.item.generatedAt) || right.index - left.index)
      .map(({ item }) => item);
  }

  function persistSummary(input) {
    return mutate((store) => {
      const value = checked(summaryRecordInputSchema, input);
      const key = summaryGenerationKey(value);
      const existing = store.summaries.find((item) => summaryGenerationKey(item) === key);
      // Idempotent by generation key: a regenerated same-key summary returns the
      // stored record without a duplicate write, and never clobbers a previous
      // valid summary. Different keys (new commit / new readme version) append
      // history.
      if (existing) return { summary: existing, duplicate: true };
      const summary = checked(summaryRecordSchema, {
        ...value,
        summaryId: makeId(),
        generatedAt: clock(),
      });
      store.summaries.push(summary);
      return { summary, duplicate: false };
    });
  }

  function getSummary({ repositoryId } = {}) {
    if (!Number.isInteger(repositoryId) || repositoryId <= 0) fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
    return serialized(async () => {
      const store = await readStore();
      const latest = newestFirst(store.summaries.filter((item) => item.repositoryId === repositoryId))[0] ?? null;
      return { summary: latest ? structuredClone(latest) : null };
    });
  }

  function getSummaryByCommit({ repositoryId, sourceCommitSha } = {}) {
    if (!Number.isInteger(repositoryId) || repositoryId <= 0 || typeof sourceCommitSha !== "string" || !/^[a-f0-9]{40}$/.test(sourceCommitSha)) {
      fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
    }
    return serialized(async () => {
      const store = await readStore();
      const match = newestFirst(store.summaries.filter((item) => item.repositoryId === repositoryId && item.sourceCommitSha === sourceCommitSha))[0] ?? null;
      return { summary: match ? structuredClone(match) : null };
    });
  }

  function listSummaries({ repositoryId } = {}) {
    if (!Number.isInteger(repositoryId) || repositoryId <= 0) fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
    return serialized(async () => {
      const store = await readStore();
      const summaries = newestFirst(store.summaries.filter((item) => item.repositoryId === repositoryId)).map((item) => structuredClone(item));
      return { summaries };
    });
  }

  function listLatest() {
    return serialized(async () => {
      const store = await readStore();
      // One record per repository: its newest generated summary, used by the
      // radar dashboard overlay. Pure read; never creates the store.
      const latestPerRepository = new Map();
      store.summaries.forEach((item, index) => {
        const current = latestPerRepository.get(item.repositoryId);
        if (!current || item.generatedAt >= current.item.generatedAt) latestPerRepository.set(item.repositoryId, { item, index });
      });
      const summaries = [...latestPerRepository.values()]
        .sort((left, right) => right.item.generatedAt.localeCompare(left.item.generatedAt) || right.index - left.index)
        .map(({ item }) => structuredClone(item));
      return { summaries };
    });
  }

  async function validatedImport(value) {
    try {
      let checkedValue;
      try {
        checkedValue = await summaryStoreSchema.parseAsync(value);
      } catch (error) {
        // Distinguish schema failures on raw values from version errors so
        // unknown future versions get the dedicated error.
        if (value && typeof value === "object" && value.version !== undefined && value.version !== 1) {
          fail("SUMMARY_STORAGE_VERSION_UNSUPPORTED", "仓库摘要数据版本不受支持。", 500);
        }
        fail("SUMMARY_STORAGE_CORRUPT", "仓库摘要导入数据未通过完整性检查。", 400);
      }
      if (Buffer.byteLength(`${JSON.stringify(checkedValue, null, 2)}\n`) > MAX_BYTES) fail("SUMMARY_STORAGE_TOO_LARGE", "仓库摘要数据超过容量限制。", 413);
      return structuredClone(checkedValue);
    } catch (error) {
      if (error instanceof SummaryRepositoryError) throw error;
      fail("SUMMARY_STORAGE_CORRUPT", "仓库摘要导入数据未通过完整性检查。", 400);
    }
  }

  function exportState() {
    return serialized(async () => {
      const store = await readStore();
      return structuredClone(store);
    });
  }

  async function acquireExclusiveTransaction() {
    let acquired, rejected, release;
    const ready = new Promise((resolve, reject) => { acquired = resolve; rejected = reject; });
    const barrier = new Promise((resolve) => { release = resolve; });
    const complete = serialized(async () => { acquired(); await barrier; }, { write: true });
    complete.catch(rejected);
    await ready;
    return async () => { release(); await complete; };
  }

  async function stageImport(value) {
    const checkedValue = await validatedImport(value);
    const body = `${JSON.stringify(checkedValue, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("SUMMARY_STORAGE_TOO_LARGE", "仓库摘要数据超过容量限制。", 413);
    const release = await acquireExclusiveTransaction();
    let stagedPath = null;
    let rollbackPath = null;
    let hadOriginal = false;
    let committed = false;
    let preserveRollback = false;
    let closed = false;
    try {
      const previous = await readRawStore();
      hadOriginal = previous !== null;
      if (hadOriginal) {
        let parsed;
        try { parsed = JSON.parse(previous.toString("utf8")); } catch { /* Preserve corrupt bytes verbatim. */ }
        if (parsed && Object.hasOwn(parsed, "version") && parsed.version !== 1) {
          fail("SUMMARY_STORAGE_VERSION_UNSUPPORTED", "仓库摘要数据版本不受支持。", 500);
        }
        rollbackPath = await writeTemporary(previous, "rollback");
      }
      stagedPath = await writeTemporary(body, "stage");
    } catch (error) {
      if (stagedPath) await unlink(stagedPath).catch(() => {});
      if (rollbackPath) await unlink(rollbackPath).catch(() => {});
      await release();
      throw error;
    }

    async function commit() {
      if (closed || committed) return;
      await ensureDirectory();
      await rename(stagedPath, target);
      stagedPath = null;
      committed = true;
    }
    async function rollback() {
      if (closed || !committed) return;
      try {
        await ensureDirectory();
        if (hadOriginal) {
          await rename(rollbackPath, target);
          rollbackPath = null;
        } else {
          await unlink(target).catch((error) => { if (error?.code !== "ENOENT") throw error; });
        }
        committed = false;
      } catch (error) {
        preserveRollback = true;
        throw error;
      }
    }
    async function cleanup() {
      if (closed) return;
      closed = true;
      if (stagedPath) await unlink(stagedPath).catch(() => {});
      if (rollbackPath && !preserveRollback) await unlink(rollbackPath).catch(() => {});
      await release();
    }

    return Object.freeze({ commit, rollback, cleanup });
  }

  async function replaceState(value) {
    const transaction = await stageImport(value);
    try { await transaction.commit(); } finally { await transaction.cleanup(); }
  }

  function registerBackupProvider() {
    return Object.freeze({
      id: "summaries",
      schemaVersion: 1,
      optionalForImport: true,
      exportState,
      validateImport: validatedImport,
      replaceState,
      stageImport,
    });
  }

  return Object.freeze({
    persistSummary, getSummary, getSummaryByCommit, listSummaries, listLatest,
    registerBackupProvider, exportState, validateImport: validatedImport, replaceState,
  });
}