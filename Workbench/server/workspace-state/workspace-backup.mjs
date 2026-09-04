import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

import {
  MAX_WORKSPACE_BACKUP_BYTES,
  WORKSPACE_RESTORE_PREVIEW_TTL_MS,
  workspaceBackupSchema,
  workspaceBackupUnsignedSchema,
} from "./backup-schema.mjs";

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CREDENTIAL_KEY = /(?:^|_)(?:api_?key|access_?key|private_?key|refresh_?token|token|secret|password|passwd|credential|authorization|cookie)s?(?:$|_)/;
const CACHE_KEY = /(?:^|_)(?:cache|cached|cache_dir|cache_path)s?(?:$|_)/;
const VAULT_BODY_KEY = /(?:^|_)(?:vault_?body|document_?body|readme_?body|raw_?body|raw_?content|markdown_?body)(?:$|_)/;
const VAULT_BODY_EXACT_KEYS = new Set(["body", "content", "markdown", "readme"]);
const MAX_PENDING_RESTORE_PREVIEWS = 4;
const MAX_PENDING_RESTORE_BYTES = 64 * 1024 * 1024;

export class WorkspaceBackupError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "WorkspaceBackupError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 400) {
  throw new WorkspaceBackupError(code, message, status);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("WORKSPACE_BACKUP_CORRUPT", "备份包含无法序列化的数值。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("WORKSPACE_BACKUP_CORRUPT", "备份只能包含标准 JSON 数据。");
}

function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    fail("WORKSPACE_BACKUP_CORRUPT", "备份无法序列化。");
  }
}

function checksumFor(unsigned) {
  return createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}

function normalizedKey(key) {
  return key
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

function isAbsolutePath(value) {
  const candidate = value.trim();
  return path.win32.isAbsolute(candidate) ||
    path.posix.isAbsolute(candidate) ||
    /^file:\/\//i.test(candidate);
}

function assertSafePayload(value, seen = new Set()) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("WORKSPACE_BACKUP_CORRUPT", "备份包含无法序列化的数值。");
    return;
  }
  if (typeof value === "string") {
    if (isAbsolutePath(value)) {
      fail("WORKSPACE_BACKUP_ABSOLUTE_PATH", "备份不能包含绝对路径。");
    }
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    fail("WORKSPACE_BACKUP_CORRUPT", "备份只能包含无循环引用的标准 JSON 数据。");
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    fail("WORKSPACE_BACKUP_CORRUPT", "备份只能包含标准 JSON 数据。");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertSafePayload(item, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      if (CREDENTIAL_KEY.test(normalized) || CACHE_KEY.test(normalized)) {
        fail("WORKSPACE_BACKUP_SENSITIVE_DATA", "备份不能包含凭据或缓存。");
      }
      if (VAULT_BODY_EXACT_KEYS.has(normalized) || VAULT_BODY_KEY.test(normalized)) {
        fail("WORKSPACE_BACKUP_VAULT_BODY", "备份不能包含 Vault 正文。");
      }
      assertSafePayload(item, seen);
    }
  }
  seen.delete(value);
}

function safeClone(value) {
  assertSafePayload(value);
  return JSON.parse(canonicalJson(value));
}

function currentTime(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("workspace backup clock must return a valid Date");
  }
  return value;
}

function providerVersions(providers) {
  return providers.map((provider) => [provider.id, provider.schemaVersion]);
}

function countRecords(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.values(value).reduce((total, item) => total + (Array.isArray(item) ? item.length : 0), 0);
}

function encodeToken(payload, secret) {
  const encoded = Buffer.from(canonicalJson(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function decodeToken(token, secret) {
  if (typeof token !== "string" || token.length < 40 || token.length > 4096) {
    fail("WORKSPACE_RESTORE_PREVIEW_INVALID", "恢复确认无效或已不存在。");
  }
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) fail("WORKSPACE_RESTORE_PREVIEW_INVALID", "恢复确认无效或已不存在。");
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    fail("WORKSPACE_RESTORE_PREVIEW_INVALID", "恢复确认无效或已不存在。");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    fail("WORKSPACE_RESTORE_PREVIEW_INVALID", "恢复确认无效或已不存在。");
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      payload?.version !== 1 ||
      typeof payload.nonce !== "string" ||
      !/^[a-f0-9]{32}$/.test(payload.nonce) ||
      typeof payload.checksum !== "string" ||
      !/^[a-f0-9]{64}$/.test(payload.checksum) ||
      !WORKSPACE_ID.test(payload.workspaceId || "") ||
      typeof payload.expiresAt !== "string" ||
      !Array.isArray(payload.providers)
    ) {
      fail("WORKSPACE_RESTORE_PREVIEW_INVALID", "恢复确认无效或已不存在。");
    }
    return payload;
  } catch (error) {
    if (error instanceof WorkspaceBackupError) throw error;
    fail("WORKSPACE_RESTORE_PREVIEW_INVALID", "恢复确认无效或已不存在。");
  }
}

function assertTransaction(transaction) {
  if (
    !transaction ||
    typeof transaction.commit !== "function" ||
    typeof transaction.rollback !== "function" ||
    typeof transaction.cleanup !== "function"
  ) {
    fail("WORKSPACE_RESTORE_STAGE_FAILED", "状态提供方未返回有效的恢复事务。", 500);
  }
  return transaction;
}

async function compatibilityStage(provider, value) {
  const previous = safeClone(await provider.exportState());
  let committed = false;
  return {
    async commit() {
      await provider.replaceState(safeClone(value));
      committed = true;
    },
    async rollback() {
      if (committed) await provider.replaceState(previous);
    },
    async cleanup() {},
  };
}

export function createWorkspaceBackup({ providers, now = () => new Date(), secret, workspaceId = "local-workspace" } = {}) {
  if (!Array.isArray(providers) || providers.length < 1 || providers.length > 64) {
    throw new TypeError("workspace backup providers are required");
  }
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new TypeError("workspace backup secret must contain at least 32 bytes");
  }
  if (!WORKSPACE_ID.test(workspaceId || "")) {
    throw new TypeError("workspace backup requires a stable workspace id");
  }
  const orderedProviders = [...providers].sort((left, right) => left.id.localeCompare(right.id));
  const providerMap = new Map();
  for (const provider of orderedProviders) {
    if (
      !provider ||
      !PROVIDER_ID.test(provider.id || "") ||
      !Number.isInteger(provider.schemaVersion) ||
      provider.schemaVersion < 1 ||
      typeof provider.exportState !== "function" ||
      typeof provider.validateImport !== "function" ||
      typeof provider.replaceState !== "function" ||
      (provider.optionalForImport !== undefined && typeof provider.optionalForImport !== "boolean") ||
      (provider.stageImport !== undefined && typeof provider.stageImport !== "function")
    ) {
      throw new TypeError("workspace backup provider contract is invalid");
    }
    if (providerMap.has(provider.id)) throw new TypeError(`duplicate workspace backup provider: ${provider.id}`);
    providerMap.set(provider.id, provider);
  }

  const signingSecret = Buffer.from(secret);
  const pending = new Map();
  let pendingBytes = 0;
  let confirmationQueue = Promise.resolve();

  function deletePending(nonce) {
    const preview = pending.get(nonce);
    if (!preview) return false;
    pending.delete(nonce);
    clearTimeout(preview.expiryTimer);
    pendingBytes -= preview.retainedBytes;
    return true;
  }

  function retainPending(nonce, preview, requestedAt) {
    const requestedAtMs = requestedAt.getTime();
    for (const [pendingNonce, candidate] of pending) {
      if (requestedAtMs > Date.parse(candidate.expiresAt)) deletePending(pendingNonce);
    }
    if (preview.retainedBytes > MAX_PENDING_RESTORE_BYTES) {
      fail("WORKSPACE_BACKUP_TOO_LARGE", "备份超过容量限制。", 413);
    }
    while (
      pending.size >= MAX_PENDING_RESTORE_PREVIEWS ||
      pendingBytes + preview.retainedBytes > MAX_PENDING_RESTORE_BYTES
    ) {
      const oldestNonce = pending.keys().next().value;
      if (!oldestNonce) break;
      deletePending(oldestNonce);
    }
    const expiryDelay = Math.max(1, Date.parse(preview.expiresAt) - requestedAtMs + 1);
    preview.expiryTimer = setTimeout(() => deletePending(nonce), expiryDelay);
    preview.expiryTimer.unref?.();
    pending.set(nonce, preview);
    pendingBytes += preview.retainedBytes;
  }

  async function exportBundle() {
    const exportedProviders = {};
    for (const provider of orderedProviders) {
      let exported;
      try {
        exported = await provider.exportState();
      } catch {
        fail("WORKSPACE_BACKUP_EXPORT_FAILED", "工作区状态导出失败。", 500);
      }
      const data = safeClone(exported);
      exportedProviders[provider.id] = { version: provider.schemaVersion, data };
    }
    const unsigned = workspaceBackupUnsignedSchema.parse({
      format: "personal-ai-workbench-backup",
      version: 1,
      workspaceId,
      createdAt: currentTime(now).toISOString(),
      providers: exportedProviders,
    });
    const bundle = { ...unsigned, checksum: checksumFor(unsigned) };
    if (serializedBytes(bundle) > MAX_WORKSPACE_BACKUP_BYTES) {
      fail("WORKSPACE_BACKUP_TOO_LARGE", "备份超过容量限制。", 413);
    }
    return bundle;
  }

  async function previewImport(input) {
    if (serializedBytes(input) > MAX_WORKSPACE_BACKUP_BYTES) {
      fail("WORKSPACE_BACKUP_TOO_LARGE", "备份超过容量限制。", 413);
    }
    const parsed = workspaceBackupSchema.safeParse(input);
    if (!parsed.success) fail("WORKSPACE_BACKUP_CORRUPT", "备份格式或版本无效。");
    const bundle = parsed.data;
    const { checksum, ...unsigned } = bundle;
    if (checksumFor(unsigned) !== checksum) {
      fail("WORKSPACE_BACKUP_CHECKSUM_INVALID", "备份校验值不匹配，内容可能已经改变。");
    }

    const validated = new Map();
    const summary = [];
    for (const [id, entry] of Object.entries(bundle.providers).sort(([left], [right]) => left.localeCompare(right))) {
      const provider = providerMap.get(id);
      if (!provider) fail("WORKSPACE_BACKUP_PROVIDER_UNKNOWN", "备份包含当前版本无法识别的状态提供方。");
      if (entry.version !== provider.schemaVersion) {
        fail("WORKSPACE_BACKUP_PROVIDER_VERSION_UNSUPPORTED", "备份中的状态提供方版本不受支持。");
      }
      const raw = safeClone(entry.data);
      let checked;
      try {
        checked = safeClone(await provider.validateImport(raw));
      } catch (error) {
        if (error instanceof WorkspaceBackupError) throw error;
        fail("WORKSPACE_BACKUP_PROVIDER_INVALID", "备份中的状态数据未通过完整性检查。");
      }
      validated.set(id, checked);
      summary.push({ id, version: entry.version, count: countRecords(checked) });
    }
    const omittedProviders = orderedProviders.filter((provider) => !validated.has(provider.id));
    if (omittedProviders.some((provider) => !provider.optionalForImport)) {
      fail("WORKSPACE_BACKUP_PROVIDER_MISSING", "备份缺少当前工作区所需的状态提供方。");
    }

    const requestedAt = currentTime(now);
    const expiresAt = new Date(requestedAt.getTime() + WORKSPACE_RESTORE_PREVIEW_TTL_MS).toISOString();
    const nonce = randomBytes(16).toString("hex");
    const versions = summary.map(({ id, version }) => [id, version]);
    const payload = { version: 1, nonce, checksum, workspaceId, providers: versions, expiresAt };
    retainPending(nonce, {
      checksum,
      workspaceId,
      providers: versions,
      expiresAt,
      validated,
      retainedBytes: serializedBytes(Object.fromEntries(validated)),
    }, requestedAt);
    return {
      token: encodeToken(payload, signingSecret),
      workspaceId,
      expiresAt,
      requiresConfirmation: true,
      providers: summary,
      warnings: [
        "凭据、缓存、绝对路径和 Vault 正文不会进入恢复内容。",
        ...omittedProviders.map((provider) => `备份未包含可选状态提供方 ${provider.id}，当前数据将保留。`),
      ],
    };
  }

  async function confirmOnce(token) {
    const payload = decodeToken(token, signingSecret);
    const preview = pending.get(payload.nonce);
    if (!preview) fail("WORKSPACE_RESTORE_PREVIEW_INVALID", "恢复确认无效或已不存在。");
    deletePending(payload.nonce);
    if (currentTime(now).getTime() > Date.parse(preview.expiresAt)) {
      fail("WORKSPACE_RESTORE_PREVIEW_EXPIRED", "恢复确认已经过期。", 410);
    }
    const currentVersions = providerVersions(orderedProviders).filter(([id]) => preview.validated.has(id));
    if (
      payload.checksum !== preview.checksum ||
      payload.workspaceId !== workspaceId ||
      preview.workspaceId !== workspaceId ||
      canonicalJson(payload.providers) !== canonicalJson(preview.providers) ||
      canonicalJson(currentVersions) !== canonicalJson(preview.providers) ||
      payload.expiresAt !== preview.expiresAt
    ) {
      fail("WORKSPACE_RESTORE_PREVIEW_INVALID", "恢复确认所绑定的工作区或状态版本已经改变。", 409);
    }

    const staged = [];
    try {
      for (const [id, value] of preview.validated) {
        const provider = providerMap.get(id);
        // Transactional providers stage durable payload and rollback material
        // here. commit must atomically replace only that provider's store,
        // rollback must restore it after a successful commit, and cleanup must
        // release locks and remove staging artifacts in every outcome.
        const candidate = provider.stageImport
          ? await provider.stageImport(safeClone(value))
          : await compatibilityStage(provider, value);
        let transaction;
        try {
          transaction = assertTransaction(candidate);
        } catch (error) {
          try {
            await candidate?.cleanup?.();
          } catch {
            // The original contract error remains the actionable failure.
          }
          throw error;
        }
        staged.push({ id, version: provider.schemaVersion, transaction });
      }
    } catch (error) {
      await Promise.allSettled(staged.map(({ transaction }) => transaction.cleanup()));
      if (error instanceof WorkspaceBackupError) throw error;
      fail("WORKSPACE_RESTORE_STAGE_FAILED", "恢复状态暂存失败，当前数据未改变。", 500);
    }

    const committed = [];
    try {
      for (const item of staged) {
        await item.transaction.commit();
        committed.push(item);
      }
    } catch {
      const rollbackFailures = [];
      for (const { transaction } of [...committed].reverse()) {
        try {
          await transaction.rollback();
        } catch (error) {
          rollbackFailures.push(error);
        }
      }
      await Promise.allSettled(staged.map(({ transaction }) => transaction.cleanup()));
      if (rollbackFailures.length > 0) {
        fail("WORKSPACE_RESTORE_ROLLBACK_FAILED", "恢复提交失败，且回滚未能完整完成。", 500);
      }
      fail("WORKSPACE_RESTORE_COMMIT_FAILED", "恢复提交失败，已回滚当前工作区状态。", 500);
    }

    await Promise.allSettled(staged.map(({ transaction }) => transaction.cleanup()));
    return {
      restored: true,
      workspaceId,
      providers: staged.map(({ id, version }) => ({ id, version })),
    };
  }

  function confirmImport(token) {
    const result = confirmationQueue.then(() => confirmOnce(token), () => confirmOnce(token));
    confirmationQueue = result.catch(() => {});
    return result;
  }

  return Object.freeze({ exportBundle, previewImport, confirmImport });
}
