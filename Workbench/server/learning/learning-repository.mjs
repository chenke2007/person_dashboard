import { constants, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createTicketLock } from "../workspace-state/ticket-lock.mjs";
import { createLearningContentRepository } from "./learning-content-repository.mjs";
import { createLearningIngestionRepository } from "./learning-ingestion-repository.mjs";
import {
  CONFIRM_RECEIPT_TTL_MS,
  CONFIRM_TOKEN_TTL_MS,
  LEARNING_ACTIVE_LIMIT,
  MAX_LEARNING_BYTES,
  emptyLearningStore,
  learningDraftInputSchema,
  learningMissionSchema,
  learningStoreSchema,
} from "./learning-schema.mjs";

const FILE_NAME = "learning.json";
const MAX_BYTES = MAX_LEARNING_BYTES;

export class LearningWorkspaceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "LearningWorkspaceError";
    this.code = code;
    this.status = status;
  }
}
function fail(code, message, status = 400) {
  throw new LearningWorkspaceError(code, message, status);
}
function checked(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) fail("LEARNING_INVALID_INPUT", "学习工作区输入格式无效。");
  return result.data;
}
export function safeLearningError(error, fallback = "LEARNING_FAILED") {
  const messages = {
    LEARNING_FAILED: "学习工作区操作失败。",
    LEARNING_PERSISTENCE_FAILED: "学习工作区状态未能保存。",
    LEARNING_IMPORT_CONFIRMATIONS_REJECTED: "导入数据包含确认授权信息，已拒绝。",
  };
  let code;
  try { code = error?.code; } catch { /* Arbitrary thrown values are not trusted. */ }
  code = typeof code === "string" && Object.hasOwn(messages, code) ? code : fallback;
  return { code, message: messages[code] };
}

export function createLearningRepository({ directory, now = () => new Date() } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("LEARNING_STORAGE_PATH_INVALID", "学习工作区存储目录无效。", 500);
  const root = path.resolve(directory);
  const target = path.join(root, FILE_NAME);
  let queue = Promise.resolve();
  let canonicalRoot = null;

  const clock = () => {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      fail("LEARNING_INVALID_CLOCK", "学习工作区时钟必须返回有效日期。", 500);
    }
    return value.toISOString();
  };

  async function ensureDirectory({ create = true } = {}) {
    for (let candidate = root; ; candidate = path.dirname(candidate)) {
      try {
        const details = await lstat(candidate);
        if (details.isSymbolicLink() || !details.isDirectory()) fail("LEARNING_STORAGE_PATH_UNSAFE", "学习工作区存储目录不安全。", 500);
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
      fail("LEARNING_STORAGE_PATH_UNSAFE", "学习工作区存储目录不安全。", 500);
    }
    const actual = path.resolve(await realpath(root));
    const comparable = process.platform === "win32" ? actual.toLowerCase() : actual;
    if (canonicalRoot && canonicalRoot !== comparable) {
      fail("LEARNING_STORAGE_PATH_UNSAFE", "学习工作区存储目录不安全。", 500);
    }
    canonicalRoot = comparable;
    return comparable;
  }

  // A single authoritative JSON file holds every learning lifecycle record,
  // so a write either fully lands (atomic tmp -> fsync -> rename) or leaves the
  // prior file intact; there is no multi-file commit to prove atomic.
  const withWriteLock = createTicketLock({ directory: path.join(root, "learning.lock"), ensureDirectory, fail, codePrefix: "LEARNING_STORAGE" });
  // The authored content store (plan / notes / artifacts) lives beside the
  // lifecycle store in the same directory with its own file, lock and
  // revision. It is composed here because this module owns the directory
  // resolution; the content deep module itself shares no lifecycle state.
  const content = createLearningContentRepository({ directory: root, now });
  // The Obsidian ingestion store (target selections, preview token digests and
  // ingestion history) shares the same directory with its own file and lock.
  const ingestion = createLearningIngestionRepository({ directory: root, now });

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
      fail("LEARNING_STORAGE_CORRUPT", "学习数据文件无效或超过容量限制。", 500);
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      const current = await lstat(target);
      if (!opened.isFile() || current.isSymbolicLink() || !current.isFile() || opened.ino !== details.ino || current.ino !== opened.ino || opened.size > MAX_BYTES) {
        fail("LEARNING_STORAGE_CORRUPT", "学习数据文件无效或超过容量限制。", 500);
      }
      const bytes = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > opened.size) fail("LEARNING_STORAGE_CORRUPT", "学习数据文件在读取期间发生变化。", 500);
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }

  async function readStore() {
    const raw = await readRawStore();
    if (raw === null) return emptyLearningStore();
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      fail("LEARNING_STORAGE_CORRUPT", "学习数据文件无法解析。", 500);
    }
    if (parsed?.version !== 1) {
      fail("LEARNING_STORAGE_VERSION_UNSUPPORTED", "学习数据版本不受支持。", 500);
    }
    const result = learningStoreSchema.safeParse(parsed);
    if (!result.success) fail("LEARNING_STORAGE_CORRUPT", "学习数据文件格式无效。", 500);
    return result.data;
  }

  async function writeStore(store) {
    const valid = learningStoreSchema.safeParse(store);
    if (!valid.success) fail("LEARNING_STORAGE_CORRUPT", "学习数据未通过完整性检查。", 500);
    const body = `${JSON.stringify(valid.data, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("LEARNING_STORAGE_TOO_LARGE", "学习数据超过容量限制。", 413);
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

  function requireWorkspace(store, workspaceId) {
    const workspace = store.workspaces.find((item) => item.workspaceId === workspaceId);
    if (!workspace) fail("WORKSPACE_NOT_FOUND", "学习工作区不存在。", 404);
    return workspace;
  }
  function activeCount(store) {
    return store.workspaces.reduce((total, workspace) => total + (workspace.state === "active" ? 1 : 0), 0);
  }
  function pruneExpiredTokens(store) {
    const cutoff = Date.parse(clock());
    const live = store.confirmations.filter((token) => {
      const boundary = token.consumed ? Date.parse(token.consumed.receiptExpiresAt) : Date.parse(token.expiresAt);
      return boundary > cutoff;
    });
    store.confirmations = live.slice(-50_000);
  }

  function createDraft(input) {
    return mutate((store) => {
      const value = checked(learningDraftInputSchema, input);
      const existing = store.workspaces.find((item) => item.repositoryId === value.repositoryId);
      if (existing) return existing; // Idempotent: never overlay task, fixed commit, active state or archive history.
      const timestamp = clock();
      const workspace = {
        workspaceId: randomUUID(), repositoryId: value.repositoryId, fullName: value.fullName,
        sourceUrl: value.sourceUrl, sourceCommitSha: value.sourceCommitSha, mission: value.mission,
        state: "draft", draftRevision: 1, createdAt: timestamp, updatedAt: timestamp,
      };
      store.workspaces.push(workspace);
      return workspace;
    }).then((workspace) => ({ workspace }));
  }

  function editDraft({ workspaceId, expectedRevision, mission }) {
    return mutate((store) => {
      const workspace = requireWorkspace(store, workspaceId);
      if (workspace.state !== "draft") fail("LEARNING_INVALID_TRANSITION", "只有草稿状态可以编辑任务。", 409);
      if (expectedRevision !== workspace.draftRevision) fail("REVISION_CONFLICT", "任务已发生较新的编辑，请刷新后重试。", 409);
      const updated = checked(learningMissionSchema, mission);
      workspace.mission = updated;
      workspace.draftRevision += 1;
      workspace.updatedAt = clock();
      return workspace;
    }).then((workspace) => ({ workspace }));
  }

  function preview({ workspaceId }) {
    return mutate((store) => {
      const workspace = requireWorkspace(store, workspaceId);
      if (workspace.state !== "draft") fail("LEARNING_INVALID_TRANSITION", "只有草稿状态可以预览确认。", 409);
      pruneExpiredTokens(store);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.parse(clock()) + CONFIRM_TOKEN_TTL_MS).toISOString();
      store.confirmations.push({
        tokenDigest: createHash("sha256").update(token).digest("hex"),
        workspaceId: workspace.workspaceId, repositoryId: workspace.repositoryId,
        sourceCommitSha: workspace.sourceCommitSha, draftRevision: workspace.draftRevision,
        mission: workspace.mission, expiresAt, consumed: null,
      });
      return { token, expiresAt, draftRevision: workspace.draftRevision, sourceCommitSha: workspace.sourceCommitSha, mission: workspace.mission };
    });
  }

  function lookupToken(store, token) {
    const digest = typeof token === "string" ? createHash("sha256").update(token).digest("hex") : null;
    return store.confirmations.find((item) => item.tokenDigest === digest);
  }

  function confirm({ token }) {
    return mutate((store) => {
      pruneExpiredTokens(store);
      const record = lookupToken(store, token);
      if (!record) fail("CONFIRM_TOKEN_INVALID", "确认凭证无效或已失效。", 409);
      const nowMs = Date.parse(clock());
      if (record.consumed) {
        if (nowMs > Date.parse(record.consumed.receiptExpiresAt)) {
          fail("CONFIRM_TOKEN_INVALID", "确认凭证已过期，请重新预览。", 410);
        }
        const workspace = requireWorkspace(store, record.workspaceId);
        return { confirmed: record.consumed.confirmed, workspace };
      }
      if (nowMs > Date.parse(record.expiresAt)) {
        fail("CONFIRM_TOKEN_INVALID", "确认凭证已过期，请重新预览。", 410);
      }
      const workspace = requireWorkspace(store, record.workspaceId);
      if (workspace.state !== "draft") fail("CONFIRM_TOKEN_INVALID", "确认凭证不再适用于当前学习工作区。", 409);
      // The token is bound to the complete mission, revision and fixed source.
      if (
        workspace.repositoryId !== record.repositoryId ||
        workspace.sourceCommitSha !== record.sourceCommitSha ||
        workspace.draftRevision !== record.draftRevision ||
        workspace.mission.goal !== record.mission.goal ||
        workspace.mission.notes !== record.mission.notes
      ) {
        fail("CONFIRM_TOKEN_INVALID", "确认输入已漂移，请重新预览。", 409);
      }
      const confirmed = activeCount(store) >= LEARNING_ACTIVE_LIMIT ? "queued" : "active";
      workspace.state = confirmed;
      workspace.updatedAt = clock();
      // The receipt's TTL is measured from confirmation, not from the preview's
      // token expiry, so a confirmation made near preview expiry still earns a
      // full receipt window and does not expire immediately.
      record.consumed = { confirmed, confirmedAt: clock(), receiptExpiresAt: new Date(nowMs + CONFIRM_RECEIPT_TTL_MS).toISOString() };
      return { confirmed, workspace };
    });
  }

  function activate({ workspaceId, expectedRevision }) {
    return mutate((store) => {
      const workspace = requireWorkspace(store, workspaceId);
      if (workspace.state === "active") return { workspace, outcome: "already-active" };
      if (workspace.state !== "queued") fail("LEARNING_INVALID_TRANSITION", "只有排队的工作区可以激活。", 409);
      if (expectedRevision !== workspace.draftRevision) fail("REVISION_CONFLICT", "任务已发生较新的编辑，请刷新后重试。", 409);
      if (activeCount(store) >= LEARNING_ACTIVE_LIMIT) return { workspace, outcome: "ACTIVE_LIMIT_REACHED" };
      workspace.state = "active";
      workspace.updatedAt = clock();
      return { workspace, outcome: "active" };
    });
  }

  function archive(workspaceId) {
    return mutate((store) => {
      const workspace = requireWorkspace(store, workspaceId);
      if (workspace.state === "archived") return workspace; // Idempotent: keep content and updatedAt unchanged.
      workspace.state = "archived";
      workspace.updatedAt = clock();
      return workspace;
    }).then((workspace) => ({ workspace }));
  }

  function list({ includeArchived = false } = {}) {
    return serialized(async () => {
      const store = await readStore();
      const workspaces = store.workspaces.filter((workspace) => includeArchived || workspace.state !== "archived");
      return { workspaces: structuredClone(workspaces) };
    });
  }

  function get(workspaceId) {
    return serialized(async () => {
      const store = await readStore();
      return { workspace: structuredClone(requireWorkspace(store, workspaceId)) };
    });
  }

  // The unified backup provider bundles the lifecycle store (token-free) with
  // the authored content store under the "learning" provider id, so a single
  // backup round-trips both and an old learning-only backup imports cleanly
  // while preserving existing content. Authorization material is never
  // imported, and content is only touched when the bundle carries it.
  async function validatedImport(value) {
    const contentRecords = value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "contentRecords")
      ? value.contentRecords
      : undefined;
    const ingestionRecords = value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "ingestionRecords")
      ? value.ingestionRecords
      : undefined;
    const learningValue = value && typeof value === "object" && !Array.isArray(value)
      ? { ...value }
      : value;
    if (contentRecords !== undefined) delete learningValue.contentRecords;
    if (ingestionRecords !== undefined) delete learningValue.ingestionRecords;
    try {
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail("LEARNING_STORAGE_TOO_LARGE", "学习数据超过容量限制。", 413);
      const checkedLearning = await learningStoreSchema.parseAsync(learningValue);
      // Authorization material (confirmation records) is never imported from an
      // external source: a backup must be token-free. Legitimate exports always
      // carry an empty array, so this stays compatible with current backups.
      if (checkedLearning.confirmations.length > 0) {
        fail("LEARNING_IMPORT_CONFIRMATIONS_REJECTED", "导入数据包含确认授权信息，已拒绝。", 400);
      }
      let checkedContent = null;
      if (contentRecords !== undefined) {
        checkedContent = await content.validateImport(contentRecords);
      }
      let checkedIngestion = null;
      if (ingestionRecords !== undefined) {
        checkedIngestion = await ingestion.validateImport(ingestionRecords);
      }
      const merged = {
        ...structuredClone(checkedLearning),
        ...(checkedContent ? { contentRecords: checkedContent } : {}),
        ...(checkedIngestion ? { ingestionRecords: checkedIngestion } : {}),
      };
      if (Buffer.byteLength(`${JSON.stringify(merged, null, 2)}\n`) > MAX_BYTES) fail("LEARNING_STORAGE_TOO_LARGE", "学习数据超过容量限制。", 413);
      return structuredClone(merged);
    } catch (error) {
      if (error instanceof LearningWorkspaceError) throw error;
      if (error?.name === "LearningContentError") throw error;
      if (error?.name === "LearningIngestionError") throw error;
      if (value && typeof value === "object" && value.version !== undefined && value.version !== 1) {
        fail("LEARNING_STORAGE_VERSION_UNSUPPORTED", "学习数据版本不受支持。", 500);
      }
      fail("LEARNING_STORAGE_CORRUPT", "学习导入数据未通过完整性检查。", 400);
    }
  }

  function exportState() {
    return serialized(async () => {
      const store = await readStore();
      // Raw confirm tokens and their digests are authorization material and are
      // never exported; after restore a fresh preview is required. Content is
      // carried under `contentRecords` and ingestion under `ingestionRecords`,
      // field names the backup scanner does not treat as a Vault body. The
      // ingestion export strips its own token records, so a restore can never
      // resurrect a stale preview token.
      const clean = { ...store, confirmations: [] };
      const contentRecords = await content.exportState();
      const ingestionRecords = await ingestion.exportState();
      return structuredClone({ ...clean, contentRecords, ingestionRecords });
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
    const merged = await validatedImport(value);
    const learningChecked = { ...merged };
    const contentRecords = Object.hasOwn(learningChecked, "contentRecords") ? learningChecked.contentRecords : undefined;
    if (contentRecords !== undefined) delete learningChecked.contentRecords;
    const ingestionRecords = Object.hasOwn(learningChecked, "ingestionRecords") ? learningChecked.ingestionRecords : undefined;
    if (ingestionRecords !== undefined) delete learningChecked.ingestionRecords;
    const body = `${JSON.stringify(learningChecked, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("LEARNING_STORAGE_TOO_LARGE", "学习数据超过容量限制。", 413);
    // Lock order is fixed: the learning exclusive transaction first, then the
    // content store's own exclusive transaction, then the ingestion store's.
    // Nothing ever acquires a content or ingestion lock before the learning
    // lock, so there is no cycle. Commit runs forward (learning, content,
    // ingestion); rollback runs in reverse so a mid-chain failure restores all
    // three stores to their pre-import bytes, never a half-migrated mix.
    const release = await acquireExclusiveTransaction();
    let stagedPath = null;
    let rollbackPath = null;
    let hadOriginal = false;
    let committed = false;
    let preserveRollback = false;
    let closed = false;
    let contentTransaction = null;
    let ingestionTransaction = null;
    try {
      const previous = await readRawStore();
      hadOriginal = previous !== null;
      if (hadOriginal) {
        let parsed;
        try { parsed = JSON.parse(previous.toString("utf8")); } catch { /* Preserve corrupt bytes verbatim. */ }
        if (parsed && Object.hasOwn(parsed, "version") && parsed.version !== 1) {
          fail("LEARNING_STORAGE_VERSION_UNSUPPORTED", "学习数据版本不受支持。", 500);
        }
        rollbackPath = await writeTemporary(previous, "rollback");
      }
      stagedPath = await writeTemporary(body, "stage");
      if (contentRecords !== undefined) {
        contentTransaction = await content.stageImport(contentRecords);
      }
      if (ingestionRecords !== undefined) {
        ingestionTransaction = await ingestion.stageImport(ingestionRecords);
      }
    } catch (error) {
      if (stagedPath) await unlink(stagedPath).catch(() => {});
      if (rollbackPath) await unlink(rollbackPath).catch(() => {});
      if (contentTransaction) await contentTransaction.cleanup().catch(() => {});
      if (ingestionTransaction) await ingestionTransaction.cleanup().catch(() => {});
      await release();
      throw error;
    }

    async function commit() {
      if (closed || committed) return;
      await ensureDirectory();
      await rename(stagedPath, target);
      stagedPath = null;
      committed = true;
      if (contentTransaction) await contentTransaction.commit();
      if (ingestionTransaction) await ingestionTransaction.commit();
    }
    async function rollback() {
      if (closed || !committed) return;
      try {
        if (ingestionTransaction) await ingestionTransaction.rollback();
        if (contentTransaction) await contentTransaction.rollback();
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
      if (contentTransaction) await contentTransaction.cleanup();
      if (ingestionTransaction) await ingestionTransaction.cleanup();
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
      id: "learning",
      schemaVersion: 1,
      optionalForImport: true,
      exportState,
      validateImport: validatedImport,
      replaceState,
      stageImport,
    });
  }

  return Object.freeze({
    createDraft, editDraft, preview, confirm, activate, list, get, archive,
    content, ingestion,
    registerBackupProvider, exportState, validateImport: validatedImport, replaceState,
  });
}
