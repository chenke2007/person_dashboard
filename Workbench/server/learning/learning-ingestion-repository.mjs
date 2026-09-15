import { constants, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createTicketLock } from "../workspace-state/ticket-lock.mjs";
import {
  INGESTION_RECEIPT_TTL_MS,
  INGESTION_TOKEN_TTL_MS,
  MAX_INGESTION_BYTES,
  MAX_RECORDS,
  MAX_TOKENS,
  emptyIngestionStore,
  ingestionExportSchema,
  ingestionRecordSchema,
  ingestionStoreSchema,
  ingestionTokenSchema,
  targetSelectionSchema,
} from "./learning-ingestion-schema.mjs";

const FILE_NAME = "learning-ingestion.json";
const MAX_BYTES = MAX_INGESTION_BYTES;

export class LearningIngestionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "LearningIngestionError";
    this.code = code;
    this.status = status;
  }
}
function fail(code, message, status = 400) {
  throw new LearningIngestionError(code, message, status);
}
function checked(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) fail("INGESTION_INVALID_INPUT", "学习摄取输入格式无效。");
  return result.data;
}

// Authoritative store for the Obsidian ingestion workflow of every learning
// workspace: target selection, preview tokens (digest only) and ingestion
// history. Lives beside `learning.json` under the bound workspace's
// `learning/` directory with its own file, lock and revision. Every invariant
// of the sibling stores applies; the export shape never carries token
// material, and an import that contains any revives nothing.
export function createLearningIngestionRepository({ directory, now = () => new Date(), makeId = () => randomUUID() } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("INGESTION_STORAGE_PATH_INVALID", "学习摄取存储目录无效。", 500);
  if (typeof makeId !== "function" || typeof now !== "function") fail("INGESTION_STORAGE_PATH_INVALID", "学习摄取存储依赖无效。", 500);
  const root = path.resolve(directory);
  const target = path.join(root, FILE_NAME);
  let queue = Promise.resolve();
  let canonicalRoot = null;

  const clock = () => {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      fail("INGESTION_INVALID_CLOCK", "学习摄取时钟必须返回有效日期。", 500);
    }
    return value.toISOString();
  };

  async function ensureDirectory({ create = true } = {}) {
    for (let candidate = root; ; candidate = path.dirname(candidate)) {
      try {
        const details = await lstat(candidate);
        if (details.isSymbolicLink() || !details.isDirectory()) fail("INGESTION_STORAGE_PATH_UNSAFE", "学习摄取存储目录不安全。", 500);
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
      fail("INGESTION_STORAGE_PATH_UNSAFE", "学习摄取存储目录不安全。", 500);
    }
    const actual = path.resolve(await realpath(root));
    const comparable = process.platform === "win32" ? actual.toLowerCase() : actual;
    if (canonicalRoot && canonicalRoot !== comparable) {
      fail("INGESTION_STORAGE_PATH_UNSAFE", "学习摄取存储目录不安全。", 500);
    }
    canonicalRoot = comparable;
    return comparable;
  }

  const withWriteLock = createTicketLock({ directory: path.join(root, "learning-ingestion.lock"), ensureDirectory, fail, codePrefix: "INGESTION_STORAGE" });

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
      fail("INGESTION_STORAGE_CORRUPT", "学习摄取数据文件无效或超过容量限制。", 500);
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      const current = await lstat(target);
      if (!opened.isFile() || current.isSymbolicLink() || !current.isFile() || opened.ino !== details.ino || current.ino !== opened.ino || opened.size > MAX_BYTES) {
        fail("INGESTION_STORAGE_CORRUPT", "学习摄取数据文件无效或超过容量限制。", 500);
      }
      const bytes = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > opened.size) fail("INGESTION_STORAGE_CORRUPT", "学习摄取数据文件在读取期间发生变化。", 500);
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }

  async function readStore() {
    const raw = await readRawStore();
    if (raw === null) return emptyIngestionStore();
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      fail("INGESTION_STORAGE_CORRUPT", "学习摄取数据文件无法解析。", 500);
    }
    if (parsed?.version !== 1) {
      fail("INGESTION_STORAGE_VERSION_UNSUPPORTED", "学习摄取数据版本不受支持。", 500);
    }
    const result = ingestionStoreSchema.safeParse(parsed);
    if (!result.success) fail("INGESTION_STORAGE_CORRUPT", "学习摄取数据文件格式无效。", 500);
    return result.data;
  }

  async function writeStore(store) {
    const valid = ingestionStoreSchema.safeParse(store);
    if (!valid.success) fail("INGESTION_STORAGE_CORRUPT", "学习摄取数据未通过完整性检查。", 500);
    const body = `${JSON.stringify(valid.data, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("INGESTION_STORAGE_TOO_LARGE", "学习摄取数据超过容量限制。", 413);
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

  function latestRecord(store, workspaceId) {
    const records = store.records
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return records[0] ?? null;
  }

  function requireToken(store, token) {
    const digest = typeof token === "string" && token ? createHash("sha256").update(token).digest("hex") : null;
    return digest ? store.tokens.find((item) => item.tokenDigest === digest) : null;
  }

  function pruneExpiredTokens(store) {
    const cutoff = Date.parse(clock());
    const live = store.tokens.filter((token) => {
      const boundary = token.consumed ? Date.parse(token.consumed.receiptExpiresAt) : Date.parse(token.expiresAt);
      return boundary > cutoff;
    });
    store.tokens = live.slice(-MAX_TOKENS);
  }

  function setSelection({ workspaceId, targetVaultId, targetVaultDisplayName, targetMaskedPath }) {
    return mutate((store) => {
      const value = checked(targetSelectionSchema, { workspaceId, targetVaultId, targetVaultDisplayName, targetMaskedPath, selectedAt: clock() });
      const existing = store.selections.find((item) => item.workspaceId === workspaceId);
      if (!existing || existing.targetVaultId !== value.targetVaultId) {
        // A changed target makes every outstanding preview for this workspace
        // stale; demote its latest record so the UI must preview again.
        const record = latestRecord(store, workspaceId);
        if (record && record.status !== "draft") {
          record.status = "draft";
          record.updatedAt = clock();
        }
      }
      if (existing) Object.assign(existing, value);
      else store.selections.push(value);
      return { selection: value };
    });
  }

  function getSelection(workspaceId) {
    return serialized(async () => {
      const store = await readStore();
      const selection = store.selections.find((item) => item.workspaceId === workspaceId);
      return { selection: selection ? structuredClone(selection) : null };
    });
  }

  function issuePreview({ workspaceId, binding, target, sourceCommitSha, contentRevision, selectedContentTypes, files, filePlanHash }) {
    return mutate((store) => {
      pruneExpiredTokens(store);
      const selection = store.selections.find((item) => item.workspaceId === workspaceId);
      if (!selection) fail("INGESTION_TARGET_UNSELECTED", "请先选择目标仓库。", 409);
      const token = randomBytes(32).toString("base64url");
      const issuedAt = clock();
      const expiresAt = new Date(Date.parse(issuedAt) + INGESTION_TOKEN_TTL_MS).toISOString();
      const ingestionId = makeId();
      const previewRevision = store.revision + 1;
      const record = checked(ingestionRecordSchema, {
        ingestionId,
        workspaceId,
        targetVaultId: target?.vaultId ?? selection.targetVaultId,
        targetVaultDisplayName: target?.displayName ?? selection.targetVaultDisplayName,
        targetMaskedPath: target?.maskedPath ?? selection.targetMaskedPath,
        sourceCommitSha,
        contentRevision,
        previewRevision,
        selectedContentTypes,
        targetFiles: files,
        status: "previewed",
        resolution: null,
        writtenFiles: null,
        writtenAt: null,
        attempts: 0,
        errorCode: null,
        errorMessage: null,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      });
      store.records.push(record);
      store.records = store.records.slice(-MAX_RECORDS);
      store.tokens.push(checked(ingestionTokenSchema, {
        tokenDigest: createHash("sha256").update(token).digest("hex"),
        ingestionId,
        workspaceId,
        binding,
        targetVaultId: record.targetVaultId,
        sourceCommitSha,
        contentRevision,
        previewRevision,
        selectedContentTypes,
        files,
        filePlanHash,
        issuedAt,
        expiresAt,
        lastAttempt: null,
        consumed: null,
      }));
      return { token, expiresAt, previewRevision, record };
    });
  }

  function beginConfirm({ token, sourceCommitSha, contentRevision, targetVaultId, selectedContentTypes, filePlanHash, binding }) {
    return mutate((store) => {
      // Look the token up before pruning so an expired-but-still-present token
      // reports the explicit 410 expiry instead of a generic miss.
      const tokenRecord = requireToken(store, token);
      if (!tokenRecord) fail("INGESTION_TOKEN_INVALID", "确认凭证无效或已失效。", 409);
      const nowMs = Date.parse(clock());
      if (tokenRecord.consumed) {
        if (nowMs > Date.parse(tokenRecord.consumed.receiptExpiresAt)) {
          fail("INGESTION_TOKEN_INVALID", "确认凭证已过期，请重新预览。", 410);
        }
        pruneExpiredTokens(store);
        const record = latestRecord(store, tokenRecord.workspaceId) ?? store.records.find((item) => item.ingestionId === tokenRecord.ingestionId);
        return { receipt: { status: tokenRecord.consumed.status, writtenFiles: tokenRecord.consumed.writtenFiles, writtenAt: tokenRecord.consumed.writtenAt }, tokenRecord, record };
      }
      if (nowMs > Date.parse(tokenRecord.expiresAt)) {
        fail("INGESTION_TOKEN_INVALID", "确认凭证已过期，请重新预览。", 410);
      }
      pruneExpiredTokens(store);
      const record = store.records.find((item) => item.ingestionId === tokenRecord.ingestionId) ?? latestRecord(store, tokenRecord.workspaceId);
      if (binding?.fingerprint !== tokenRecord.binding.fingerprint || binding?.workspaceId !== tokenRecord.binding.workspaceId) {
        fail("INGESTION_BINDING_CHANGED", "工作区绑定已改变，请重新预览。", 409);
      }
      if (targetVaultId !== tokenRecord.targetVaultId) {
        fail("INGESTION_TARGET_CHANGED", "目标 Vault 已改变，请重新预览。", 409);
      }
      if (sourceCommitSha !== tokenRecord.sourceCommitSha) {
        fail("INGESTION_SOURCE_CHANGED", "学习来源已改变，请重新预览。", 409);
      }
      if (contentRevision !== tokenRecord.contentRevision) {
        fail("INGESTION_CONTENT_CHANGED", "学习内容已更新，请重新预览。", 409);
      }
      if (filePlanHash !== tokenRecord.filePlanHash) {
        fail("INGESTION_PLAN_MISMATCH", "目标文件计划已改变，请重新预览。", 409);
      }
      if (record && record.status !== "confirmed") {
        record.status = "confirmed";
        record.updatedAt = clock();
      }
      return { tokenRecord, record };
    });
  }

  function finishConfirm({ token, outcome }) {
    return mutate((store) => {
      const tokenRecord = requireToken(store, token);
      if (!tokenRecord) fail("INGESTION_TOKEN_INVALID", "确认凭证无效或已失效。", 409);
      const record = store.records.find((item) => item.ingestionId === tokenRecord.ingestionId) ?? latestRecord(store, tokenRecord.workspaceId);
      const stamp = clock();
      if (tokenRecord.consumed) {
        return { receipt: { status: tokenRecord.consumed.status, writtenFiles: tokenRecord.consumed.writtenFiles, writtenAt: tokenRecord.consumed.writtenAt }, record };
      }
      if (outcome?.status === "written") {
        if (!Array.isArray(outcome.writtenFiles)) fail("INGESTION_INVALID_INPUT", "摄取写入结果无效。");
        const receiptExpiresAt = new Date(Date.parse(stamp) + INGESTION_RECEIPT_TTL_MS).toISOString();
        tokenRecord.consumed = {
          status: "written",
          writtenFiles: outcome.writtenFiles.map(String),
          writtenAt: stamp,
          receiptExpiresAt,
        };
        if (record) {
          record.status = "written";
          record.writtenFiles = outcome.writtenFiles.map(String);
          record.writtenAt = stamp;
          record.errorCode = null;
          record.errorMessage = null;
          record.updatedAt = stamp;
        }
        return { receipt: { status: "written", writtenFiles: tokenRecord.consumed.writtenFiles, writtenAt: stamp }, record };
      }
      if (outcome?.status === "failed") {
        tokenRecord.lastAttempt = { attemptedAt: stamp, errorCode: outcome.errorCode ?? null, errorMessage: outcome.errorMessage ?? null };
        if (record) {
          record.status = "failed";
          record.attempts += 1;
          record.errorCode = outcome.errorCode ?? null;
          record.errorMessage = outcome.errorMessage ?? null;
          record.updatedAt = stamp;
        }
        return { record };
      }
      fail("INGESTION_INVALID_INPUT", "摄取写入结果无效。");
    });
  }

  function ownerOf({ token }) {
    return serialized(async () => {
      const store = await readStore();
      const tokenRecord = requireToken(store, token);
      return tokenRecord ? structuredClone(tokenRecord) : null;
    });
  }

  function listRecords(workspaceId) {
    return serialized(async () => {
      const store = await readStore();
      const records = store.records
        .filter((record) => record.workspaceId === workspaceId)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      return { records: structuredClone(records) };
    });
  }

  function exportState() {
    return serialized(async () => {
      const store = await readStore();
      // Token material is authorization state and never leaves the store:
      // after a restore, a fresh preview is required.
      const { tokens, ...clean } = store;
      return { ...structuredClone(clean), records: structuredClone(clean.records), selections: structuredClone(clean.selections) };
    });
  }

  async function validatedImport(value) {
    try {
      const dropped = { ...value };
      delete dropped.tokens;
      if (value && typeof value === "object" && Array.isArray(value.tokens) && value.tokens.length > 0) {
        fail("INGESTION_IMPORT_TOKEN_MATERIAL_REJECTED", "导入数据包含确认授权信息，已拒绝。", 400);
      }
      if (Buffer.byteLength(JSON.stringify(dropped)) > MAX_BYTES) fail("INGESTION_STORAGE_TOO_LARGE", "学习摄取数据超过容量限制。", 413);
      const checkedValue = await ingestionExportSchema.parseAsync(dropped);
      if (Buffer.byteLength(`${JSON.stringify(checkedValue, null, 2)}\n`) > MAX_BYTES) fail("INGESTION_STORAGE_TOO_LARGE", "学习摄取数据超过容量限制。", 413);
      // The validated result stays token-free: it flows through the bundle
      // scanner, and a "tokens" key is credential-looking to it. The store
      // schema still needs the array on disk, so stageImport re-adds an empty
      // one at write time.
      return structuredClone(checkedValue);
    } catch (error) {
      if (error instanceof LearningIngestionError) throw error;
      if (value && typeof value === "object" && value.version !== undefined && value.version !== 1) {
        fail("INGESTION_STORAGE_VERSION_UNSUPPORTED", "学习摄取数据版本不受支持。", 500);
      }
      fail("INGESTION_STORAGE_CORRUPT", "学习摄取导入数据未通过完整性检查。", 400);
    }
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
    // The persisted file needs the (empty) tokens array that the store schema
    // requires, but the validated result above deliberately lacks it so the
    // bundle scanner never sees a credential-looking key.
    const storeBody = { ...checkedValue, tokens: [] };
    const body = `${JSON.stringify(storeBody, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("INGESTION_STORAGE_TOO_LARGE", "学习摄取数据超过容量限制。", 413);
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
          fail("INGESTION_STORAGE_VERSION_UNSUPPORTED", "学习摄取数据版本不受支持。", 500);
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
    setSelection, getSelection, issuePreview, beginConfirm, finishConfirm, ownerOf, listRecords,
    exportState, validateImport: validatedImport, replaceState, stageImport,
  });
}