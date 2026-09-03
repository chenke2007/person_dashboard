import { constants } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createTicketLock } from "./ticket-lock.mjs";

import { emptyWorkspaceRegistry, workspaceRegistrySchema } from "./workspace-schema.mjs";

const FILE_NAME = "workspace-registry.json";
const LOCK_DIRECTORY_NAME = "workspace-registry.lock";
const MAX_BYTES = 2 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 5_000;
const REBIND_TTL_MS = 15 * 60 * 1000;
const LEGACY_ID = /^[a-f0-9]{24}$/;

export class WorkspaceRegistryError extends Error {
  constructor(code, message, status = 500, details = undefined) {
    super(message);
    this.name = "WorkspaceRegistryError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, status = 500, details) {
  throw new WorkspaceRegistryError(code, message, status, details);
}

function normalizeFingerprint(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    fail("WORKSPACE_FINGERPRINT_INVALID", "Vault 指纹格式无效。", 400);
  }
  return value.toLowerCase();
}

function normalizeLabel(value) {
  if (typeof value !== "string") fail("WORKSPACE_LABEL_INVALID", "工作区名称格式无效。", 400);
  const label = value.normalize("NFC").trim();
  if (!label || label.length > 120 || /[\u0000-\u001f/\\]/.test(label) || label === "." || label === "..") {
    fail("WORKSPACE_LABEL_INVALID", "工作区名称为空、过长或包含非法字符。", 400);
  }
  return label;
}

function normalizeWorkspaceId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    fail("WORKSPACE_ID_INVALID", "工作区 ID 格式无效。", 400);
  }
  return value;
}

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail("WORKSPACE_CLOCK_INVALID", "工作区时钟无效。");
  }
  return value;
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function confirmationHash(token, pending) {
  return createHash("sha256")
    .update(JSON.stringify([
      token,
      pending.workspaceId,
      pending.fingerprint,
      pending.sourceFingerprint,
      pending.replacedWorkspaceId,
      pending.requestedAt,
      pending.expiresAt,
    ]))
    .digest("hex");
}

export function createWorkspaceRegistry({
  directory,
  now = () => new Date(),
  makeId = randomUUID,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  removeLock = unlink,
  lockLifecycle = {},
} = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    fail("WORKSPACE_REGISTRY_PATH_INVALID", "工作区注册表目录无效。");
  }
  if (
    !Number.isFinite(lockTimeoutMs) ||
    lockTimeoutMs < 10 ||
    typeof removeLock !== "function" ||
    typeof lockLifecycle !== "object" ||
    (lockLifecycle.ticketPublished != null && typeof lockLifecycle.ticketPublished !== "function") ||
    (lockLifecycle.ticketsInspected != null && typeof lockLifecycle.ticketsInspected !== "function") ||
    (lockLifecycle.acquired != null && typeof lockLifecycle.acquired !== "function") ||
    (lockLifecycle.released != null && typeof lockLifecycle.released !== "function")
  ) {
    fail("WORKSPACE_REGISTRY_LOCK_OPTIONS_INVALID", "工作区注册表锁配置无效。");
  }
  const root = path.resolve(directory);
  const target = path.join(root, FILE_NAME);
  const lockDirectory = path.join(root, LOCK_DIRECTORY_NAME);
  let canonicalRoot = null;
  let queue = Promise.resolve();

  async function ensureDirectory({ create = true } = {}) {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    let details;
    try {
      details = await lstat(root);
    } catch (error) {
      if (!create && error?.code === "ENOENT") return null;
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      fail("WORKSPACE_REGISTRY_PATH_UNSAFE", "工作区注册表目录不能是符号链接或联接点。");
    }
    const actual = comparable(await realpath(root));
    if (canonicalRoot && canonicalRoot !== actual) {
      fail("WORKSPACE_REGISTRY_PATH_UNSAFE", "工作区注册表目录在使用期间发生了变化。");
    }
    canonicalRoot = actual;
    return actual;
  }

  async function readStore({ createDirectory = true } = {}) {
    const actualRoot = await ensureDirectory({ create: createDirectory });
    if (!actualRoot) return emptyWorkspaceRegistry(timestamp(now).toISOString());
    let details;
    try {
      details = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") return emptyWorkspaceRegistry(timestamp(now).toISOString());
      throw error;
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_BYTES) {
      fail("WORKSPACE_REGISTRY_CORRUPT", "工作区注册表文件无效或超过容量限制。");
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(target, "utf8"));
    } catch {
      fail("WORKSPACE_REGISTRY_CORRUPT", "工作区注册表无法解析。");
    }
    if (parsed?.version !== 1) {
      fail("WORKSPACE_REGISTRY_VERSION_UNSUPPORTED", "工作区注册表版本不受支持。", 500, {
        version: parsed?.version ?? null,
      });
    }
    const checked = workspaceRegistrySchema.safeParse(parsed);
    if (!checked.success) fail("WORKSPACE_REGISTRY_CORRUPT", "工作区注册表格式无效。");
    return checked.data;
  }

  async function writeStore(store) {
    const checked = workspaceRegistrySchema.safeParse(store);
    if (!checked.success) fail("WORKSPACE_REGISTRY_CORRUPT", "工作区注册表未通过完整性检查。");
    const body = `${JSON.stringify(checked.data, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("WORKSPACE_REGISTRY_TOO_LARGE", "工作区注册表超过容量限制。", 413);
    await ensureDirectory();
    const temporary = path.join(root, `.${FILE_NAME}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await ensureDirectory();
      await rename(temporary, target);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
    return checked.data;
  }

  const withRegistryLock = createTicketLock({ directory: lockDirectory, ensureDirectory, fail, lockTimeoutMs, removeLock, lockLifecycle });

  function serialized(operation, { lock = false } = {}) {
    const execute = () => lock ? withRegistryLock(operation) : operation();
    const result = queue.then(execute, execute);
    queue = result.catch(() => {});
    return result;
  }

  async function legacyStorageLayout(workspaceId, { createDirectory = true } = {}) {
    if (!LEGACY_ID.test(workspaceId)) return "versioned";
    const actualRoot = await ensureDirectory({ create: createDirectory });
    if (!actualRoot) return "versioned";
    const candidate = path.join(root, workspaceId);
    let details;
    try {
      details = await lstat(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") return "versioned";
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      fail("WORKSPACE_LEGACY_PATH_UNSAFE", "旧版工作区目录不安全。");
    }
    const actual = comparable(await realpath(candidate));
    if (!isPathInside(actualRoot, actual)) fail("WORKSPACE_LEGACY_PATH_UNSAFE", "旧版工作区目录越出了应用数据目录。");
    return "legacy";
  }

  async function ensureVersionedWorkspaceRoot(workspaceId, { create = true } = {}) {
    const actualRoot = await ensureDirectory({ create });
    if (!actualRoot) return null;
    const workspacesRoot = path.join(root, "workspaces");
    if (create) {
      try {
        await mkdir(workspacesRoot, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    let workspacesDetails;
    try {
      workspacesDetails = await lstat(workspacesRoot);
    } catch (error) {
      if (!create && error?.code === "ENOENT") return null;
      throw error;
    }
    if (!workspacesDetails.isDirectory() || workspacesDetails.isSymbolicLink()) {
      fail("WORKSPACE_STATE_PATH_UNSAFE", "版本化工作区目录不能是符号链接或联接点。");
    }
    const actualWorkspacesRoot = comparable(await realpath(workspacesRoot));
    if (!isPathInside(actualRoot, actualWorkspacesRoot)) {
      fail("WORKSPACE_STATE_PATH_UNSAFE", "版本化工作区目录越出了应用数据目录。");
    }

    const workspaceRoot = path.join(workspacesRoot, workspaceId);
    if (create) {
      try {
        await mkdir(workspaceRoot, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    let workspaceDetails;
    try {
      workspaceDetails = await lstat(workspaceRoot);
    } catch (error) {
      if (!create && error?.code === "ENOENT") return null;
      throw error;
    }
    if (!workspaceDetails.isDirectory() || workspaceDetails.isSymbolicLink()) {
      fail("WORKSPACE_STATE_PATH_UNSAFE", "工作区状态目录不能是符号链接或联接点。");
    }
    const actualWorkspaceRoot = comparable(await realpath(workspaceRoot));
    if (!isPathInside(actualWorkspacesRoot, actualWorkspaceRoot)) {
      fail("WORKSPACE_STATE_PATH_UNSAFE", "工作区状态目录越出了版本化工作区目录。");
    }
    return actualWorkspaceRoot;
  }

  async function storageLayoutFor(workspaceId, { prepare = false, createDirectory = true } = {}) {
    const storageLayout = await legacyStorageLayout(workspaceId, { createDirectory });
    if (storageLayout === "versioned" && prepare) await ensureVersionedWorkspaceRoot(workspaceId);
    if (storageLayout === "versioned" && !prepare) {
      await ensureVersionedWorkspaceRoot(workspaceId, { create: false });
    }
    return storageLayout;
  }

  async function directoryContainsState(directoryPath) {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return true;
      if (await directoryContainsState(path.join(directoryPath, entry.name))) return true;
    }
    return false;
  }

  async function workspaceContainsState(workspaceId) {
    const storageLayout = await storageLayoutFor(workspaceId, { prepare: true });
    const workspaceRoot = storageLayout === "legacy"
      ? path.join(root, workspaceId)
      : path.join(root, "workspaces", workspaceId);
    return directoryContainsState(workspaceRoot);
  }

  async function publicWorkspace(workspace, { prepare = false, createDirectory = true } = {}) {
    return {
      ...structuredClone(workspace),
      storageLayout: await storageLayoutFor(workspace.workspaceId, { prepare, createDirectory }),
    };
  }

  function nextWorkspaceId(store, preferred) {
    if (preferred && !store.workspaces.some((item) => item.workspaceId === preferred)) return preferred;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = normalizeWorkspaceId(makeId());
      if (!store.workspaces.some((item) => item.workspaceId === candidate)) return candidate;
    }
    fail("WORKSPACE_ID_EXHAUSTED", "无法生成唯一的工作区 ID。");
  }

  async function resolveVault({ fingerprint: rawFingerprint, label: rawLabel } = {}) {
    const fingerprint = normalizeFingerprint(rawFingerprint);
    const label = normalizeLabel(rawLabel);
    return serialized(async () => {
      const store = structuredClone(await readStore());
      const existing = store.workspaces.find((item) => item.fingerprint === fingerprint);
      if (existing) {
        const storageLayout = await storageLayoutFor(existing.workspaceId, { prepare: true });
        if (existing.label !== label) {
          const changedAt = timestamp(now).toISOString();
          existing.label = label;
          existing.updatedAt = changedAt;
          store.revision += 1;
          store.updatedAt = changedAt;
          await writeStore(store);
        }
        return { ...structuredClone(existing), storageLayout };
      }

      const legacyId = fingerprint.slice(0, 24);
      const storageLayout = await legacyStorageLayout(legacyId);
      const workspaceId = nextWorkspaceId(store, storageLayout === "legacy" ? legacyId : null);
      if (storageLayout === "versioned") await ensureVersionedWorkspaceRoot(workspaceId);
      const createdAt = timestamp(now).toISOString();
      const workspace = { workspaceId, label, fingerprint, createdAt, updatedAt: createdAt };
      store.workspaces.push(workspace);
      store.revision += 1;
      store.updatedAt = createdAt;
      await writeStore(store);
      return { ...structuredClone(workspace), storageLayout };
    }, { lock: true });
  }

  async function listWorkspaces() {
    return serialized(async () => {
      const store = await readStore({ createDirectory: false });
      return Promise.all(store.workspaces.map((workspace) => publicWorkspace(workspace, { createDirectory: false })));
    });
  }

  async function lookupVault({ fingerprint: rawFingerprint } = {}) {
    const fingerprint = normalizeFingerprint(rawFingerprint);
    return serialized(async () => {
      const store = await readStore({ createDirectory: false });
      const workspace = store.workspaces.find((item) => item.fingerprint === fingerprint);
      return workspace
        ? publicWorkspace(workspace, { createDirectory: false })
        : null;
    });
  }

  async function previewRebind({ currentFingerprint: rawFingerprint, workspaceId: rawWorkspaceId } = {}) {
    const fingerprint = normalizeFingerprint(rawFingerprint);
    const workspaceId = normalizeWorkspaceId(rawWorkspaceId);
    return serialized(async () => {
      const store = structuredClone(await readStore());
      const workspace = store.workspaces.find((item) => item.workspaceId === workspaceId);
      if (!workspace) fail("WORKSPACE_NOT_FOUND", "工作区不存在。", 404);
      if (workspace.fingerprint === fingerprint) fail("WORKSPACE_ALREADY_BOUND", "Vault 已绑定到该工作区。", 409);
      const owner = store.workspaces.find((item) => item.fingerprint === fingerprint);
      if (owner && owner.workspaceId !== workspaceId && await workspaceContainsState(owner.workspaceId)) {
        fail("WORKSPACE_FINGERPRINT_IN_USE", "该 Vault 已绑定到另一个工作区。", 409);
      }

      const requested = timestamp(now);
      const pending = {
        workspaceId,
        fingerprint,
        sourceFingerprint: workspace.fingerprint,
        replacedWorkspaceId: owner?.workspaceId ?? null,
        requestedAt: requested.toISOString(),
        expiresAt: new Date(requested.getTime() + REBIND_TTL_MS).toISOString(),
        confirmationHash: "0".repeat(64),
      };
      const token = randomBytes(32).toString("hex");
      pending.confirmationHash = confirmationHash(token, pending);
      store.pendingRebinds = store.pendingRebinds.filter((item) => item.workspaceId !== workspaceId);
      store.pendingRebinds.push(pending);
      store.revision += 1;
      store.updatedAt = pending.requestedAt;
      await writeStore(store);
      return {
        token,
        workspaceId,
        currentFingerprint: fingerprint,
        expiresAt: pending.expiresAt,
        requiresConfirmation: true,
      };
    }, { lock: true });
  }

  async function confirmRebind({ token } = {}) {
    if (typeof token !== "string" || token.length < 32 || token.length > 256) {
      fail("WORKSPACE_REBIND_PREVIEW_INVALID", "工作区重新绑定确认无效。", 400);
    }
    return serialized(async () => {
      const store = structuredClone(await readStore());
      const pendingIndex = store.pendingRebinds.findIndex(
        (item) => confirmationHash(token, item) === item.confirmationHash,
      );
      if (pendingIndex < 0) fail("WORKSPACE_REBIND_PREVIEW_INVALID", "工作区重新绑定确认已改变或不存在。", 400);
      const pending = store.pendingRebinds[pendingIndex];
      const confirmedAt = timestamp(now);
      if (confirmedAt.getTime() > Date.parse(pending.expiresAt)) {
        store.pendingRebinds.splice(pendingIndex, 1);
        store.revision += 1;
        store.updatedAt = confirmedAt.toISOString();
        await writeStore(store);
        fail("WORKSPACE_REBIND_PREVIEW_EXPIRED", "工作区重新绑定确认已过期。", 410);
      }
      const workspace = store.workspaces.find((item) => item.workspaceId === pending.workspaceId);
      if (!workspace) fail("WORKSPACE_REBIND_PREVIEW_INVALID", "待绑定工作区已不存在。", 409);
      if (workspace.fingerprint !== pending.sourceFingerprint) {
        fail("WORKSPACE_REBIND_CONFLICT", "待绑定工作区已改变，请重新预览。", 409);
      }
      const storageLayout = await storageLayoutFor(workspace.workspaceId, { prepare: true });

      const conflicting = store.workspaces.find((item) => item.fingerprint === pending.fingerprint);
      if (pending.replacedWorkspaceId && conflicting?.workspaceId !== pending.replacedWorkspaceId) {
        fail("WORKSPACE_REBIND_CONFLICT", "当前 Vault 的绑定已改变，请重新预览。", 409);
      }
      let removedWorkspaceId = null;
      if (conflicting && conflicting.workspaceId !== workspace.workspaceId) {
        if (
          (!pending.replacedWorkspaceId && Date.parse(conflicting.createdAt) < Date.parse(pending.requestedAt)) ||
          await workspaceContainsState(conflicting.workspaceId)
        ) {
          fail("WORKSPACE_REBIND_CONFLICT", "该 Vault 已属于另一个既有工作区。", 409);
        }
        removedWorkspaceId = conflicting.workspaceId;
        store.workspaces = store.workspaces.filter((item) => item.workspaceId !== conflicting.workspaceId);
      }
      workspace.fingerprint = pending.fingerprint;
      workspace.updatedAt = confirmedAt.toISOString();
      store.pendingRebinds = store.pendingRebinds.filter(
        (item) =>
          item.workspaceId !== workspace.workspaceId &&
          item.workspaceId !== removedWorkspaceId &&
          item.fingerprint !== pending.fingerprint,
      );
      store.revision += 1;
      store.updatedAt = confirmedAt.toISOString();
      await writeStore(store);
      return { ...structuredClone(workspace), storageLayout };
    }, { lock: true });
  }

  // Hold once around an API mutation or the whole multi-provider restore, never
  // separately around each provider stage (all stages precede cleanup).
  function withBoundWorkspace({ fingerprint, workspaceId }, operation) {
    return serialized(async () => {
      const store = await readStore({ createDirectory: false });
      if (!store.workspaces.some((item) => item.workspaceId === workspaceId && item.fingerprint === fingerprint)) {
        fail("WORKSPACE_BINDING_CHANGED", "工作区绑定已改变，请重新加载后重试。", 409);
      }
      return operation();
    }, { lock: true });
  }

  return Object.freeze({ resolveVault, lookupVault, listWorkspaces, previewRebind, confirmRebind, withBoundWorkspace });
}
