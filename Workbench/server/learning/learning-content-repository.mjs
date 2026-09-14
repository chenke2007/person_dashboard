import { constants, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createTicketLock } from "../workspace-state/ticket-lock.mjs";
import {
  MAX_CONTENT_BYTES,
  artifactInputSchema,
  contentBindingSchema,
  contentStoreSchema,
  emptyContentStore,
  learningPlanInputSchema,
  notesInputSchema,
} from "./learning-content-schema.mjs";

const FILE_NAME = "learning-content.json";
const MAX_BYTES = MAX_CONTENT_BYTES;

export class LearningContentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "LearningContentError";
    this.code = code;
    this.status = status;
  }
}
function fail(code, message, status = 400) {
  throw new LearningContentError(code, message, status);
}
function checked(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) fail("LEARNING_CONTENT_INVALID_INPUT", "学习内容格式无效。");
  return result.data;
}

// Authoritative store for the authored content of each learning workspace
// (plan, notes, artifacts). Lives beside `learning.json` under the bound
// workspace's `learning/` directory, shares none of the lifecycle state machine,
// and keeps its own file, lock, revision and updatedAt. Every invariant of the
// sibling stores applies: ticket-lock serialized writes, atomic
// tmp -> fsync -> rename commits, reads that never create the directory,
// corruption detection and version/schema validation. The content of a
// workspace is bound to the fixed source captured at workspace creation
// (repositoryId + sourceCommitSha + sourceUrl); a write whose binding drifted
// is rejected instead of being silently migrated.
export function createLearningContentRepository({ directory, now = () => new Date(), makeId = () => randomUUID() } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("LEARNING_CONTENT_STORAGE_PATH_INVALID", "学习内容存储目录无效。", 500);
  if (typeof makeId !== "function" || typeof now !== "function") fail("LEARNING_CONTENT_STORAGE_PATH_INVALID", "学习内容存储依赖无效。", 500);
  const root = path.resolve(directory);
  const target = path.join(root, FILE_NAME);
  let queue = Promise.resolve();
  let canonicalRoot = null;

  const clock = () => {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      fail("LEARNING_CONTENT_INVALID_CLOCK", "学习内容时钟必须返回有效日期。", 500);
    }
    return value.toISOString();
  };

  async function ensureDirectory({ create = true } = {}) {
    for (let candidate = root; ; candidate = path.dirname(candidate)) {
      try {
        const details = await lstat(candidate);
        if (details.isSymbolicLink() || !details.isDirectory()) fail("LEARNING_CONTENT_STORAGE_PATH_UNSAFE", "学习内容存储目录不安全。", 500);
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
      fail("LEARNING_CONTENT_STORAGE_PATH_UNSAFE", "学习内容存储目录不安全。", 500);
    }
    const actual = path.resolve(await realpath(root));
    const comparable = process.platform === "win32" ? actual.toLowerCase() : actual;
    if (canonicalRoot && canonicalRoot !== comparable) {
      fail("LEARNING_CONTENT_STORAGE_PATH_UNSAFE", "学习内容存储目录不安全。", 500);
    }
    canonicalRoot = comparable;
    return comparable;
  }

  const withWriteLock = createTicketLock({ directory: path.join(root, "learning-content.lock"), ensureDirectory, fail, codePrefix: "LEARNING_CONTENT_STORAGE" });

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
      fail("LEARNING_CONTENT_STORAGE_CORRUPT", "学习内容数据文件无效或超过容量限制。", 500);
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      const current = await lstat(target);
      if (!opened.isFile() || current.isSymbolicLink() || !current.isFile() || opened.ino !== details.ino || current.ino !== opened.ino || opened.size > MAX_BYTES) {
        fail("LEARNING_CONTENT_STORAGE_CORRUPT", "学习内容数据文件无效或超过容量限制。", 500);
      }
      const bytes = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > opened.size) fail("LEARNING_CONTENT_STORAGE_CORRUPT", "学习内容数据文件在读取期间发生变化。", 500);
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }

  async function readStore() {
    const raw = await readRawStore();
    if (raw === null) return emptyContentStore();
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      fail("LEARNING_CONTENT_STORAGE_CORRUPT", "学习内容数据文件无法解析。", 500);
    }
    if (parsed?.version !== 1) {
      fail("LEARNING_CONTENT_STORAGE_VERSION_UNSUPPORTED", "学习内容数据版本不受支持。", 500);
    }
    const result = contentStoreSchema.safeParse(parsed);
    if (!result.success) fail("LEARNING_CONTENT_STORAGE_CORRUPT", "学习内容数据文件格式无效。", 500);
    return result.data;
  }

  async function writeStore(store) {
    const valid = contentStoreSchema.safeParse(store);
    if (!valid.success) fail("LEARNING_CONTENT_STORAGE_CORRUPT", "学习内容数据未通过完整性检查。", 500);
    const body = `${JSON.stringify(valid.data, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("LEARNING_CONTENT_STORAGE_TOO_LARGE", "学习内容超过容量限制。", 413);
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

  function findRecord(store, workspaceId) {
    return store.records.find((record) => record.workspaceId === workspaceId);
  }

  // Binding equality is the anti-migration guard: content created for one fixed
  // source can never be silently retargeted to a newer commit or another repo.
  function requireBindingMatch(record, binding) {
    if (
      record.repositoryId !== binding.repositoryId ||
      record.sourceCommitSha !== binding.sourceCommitSha ||
      record.sourceUrl.toLowerCase() !== binding.sourceUrl.toLowerCase()
    ) {
      fail("LEARNING_CONTENT_SOURCE_MISMATCH", "学习内容的来源与学习工作区不一致，已拒绝写入。", 409);
    }
  }

  // One content revision covers the whole record; any save/append bumps it, so
  // a stale request can never overwrite a newer plan, note or artifact.
  function saveContent(workspaceId, expectedRevision, binding, apply) {
    return mutate((store) => {
      const bound = checked(contentBindingSchema, binding);
      let record = findRecord(store, workspaceId);
      if (!record) {
        const timestamp = clock();
        record = {
          workspaceId,
          repositoryId: bound.repositoryId,
          sourceCommitSha: bound.sourceCommitSha,
          sourceUrl: bound.sourceUrl,
          revision: 1,
          learningPlan: Object.freeze({ learningGoal: "", expectedOutcome: "", milestones: [], currentMilestone: null }),
          notes: null,
          artifacts: [],
          updatedAt: timestamp,
        };
        store.records.push(record);
      } else {
        if (expectedRevision !== record.revision) fail("REVISION_CONFLICT", "学习内容已更新，请刷新后重试。", 409);
        requireBindingMatch(record, bound);
        record.revision += 1;
      }
      apply(record);
      record.updatedAt = clock();
      return record;
    }).then((record) => ({ content: record }));
  }

  function savePlan({ workspaceId, expectedRevision, plan, binding }) {
    return saveContent(workspaceId, expectedRevision, binding, (record) => {
      record.learningPlan = checked(learningPlanInputSchema, plan);
    });
  }

  function saveNotes({ workspaceId, expectedRevision, notes, binding }) {
    return saveContent(workspaceId, expectedRevision, binding, (record) => {
      const value = checked(notesInputSchema, notes);
      record.notes = { markdownText: value.markdownText, updatedAt: clock() };
    });
  }

  function addArtifact({ workspaceId, expectedRevision, artifact, binding }) {
    return saveContent(workspaceId, expectedRevision, binding, (record) => {
      const value = checked(artifactInputSchema, artifact);
      const timestamp = clock();
      record.artifacts.push({
        artifactId: makeId(),
        type: value.type,
        title: value.title,
        markdownText: value.markdownText,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    });
  }

  function getContent({ workspaceId }) {
    return serialized(async () => {
      const store = await readStore();
      const record = findRecord(store, workspaceId);
      return { content: record ? structuredClone(record) : null };
    });
  }

  function exportContent({ workspaceId }) {
    return getContent({ workspaceId });
  }

  function listArtifacts({ workspaceId }) {
    return serialized(async () => {
      const store = await readStore();
      const record = findRecord(store, workspaceId);
      return { artifacts: record ? structuredClone(record.artifacts) : [] };
    });
  }

  async function validatedImport(value) {
    try {
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail("LEARNING_CONTENT_STORAGE_TOO_LARGE", "学习内容超过容量限制。", 413);
      const checkedValue = await contentStoreSchema.parseAsync(value);
      if (Buffer.byteLength(`${JSON.stringify(checkedValue, null, 2)}\n`) > MAX_BYTES) fail("LEARNING_CONTENT_STORAGE_TOO_LARGE", "学习内容超过容量限制。", 413);
      return structuredClone(checkedValue);
    } catch (error) {
      if (error instanceof LearningContentError) throw error;
      if (value && typeof value === "object" && value.version !== undefined && value.version !== 1) {
        fail("LEARNING_CONTENT_STORAGE_VERSION_UNSUPPORTED", "学习内容数据版本不受支持。", 500);
      }
      fail("LEARNING_CONTENT_STORAGE_CORRUPT", "学习内容导入数据未通过完整性检查。", 400);
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
    if (Buffer.byteLength(body) > MAX_BYTES) fail("LEARNING_CONTENT_STORAGE_TOO_LARGE", "学习内容超过容量限制。", 413);
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
          fail("LEARNING_CONTENT_STORAGE_VERSION_UNSUPPORTED", "学习内容数据版本不受支持。", 500);
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

  return Object.freeze({
    getContent, savePlan, saveNotes, addArtifact, listArtifacts, exportContent,
    exportState, validateImport: validatedImport, replaceState, stageImport,
  });
}