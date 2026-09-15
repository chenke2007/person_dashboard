import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i;
const CONFIG_NAME_MAX = 120;

export class LearningVaultCatalogError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "LearningVaultCatalogError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 400) {
  throw new LearningVaultCatalogError(code, message, status);
}

function comparableRoot(root) {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// The same fingerprint scheme the workspace registry uses to bind a Vault:
// sha256 over the resolved lowercase root. Stable across restarts and paths
// that differ only in case, and never reversible into the root itself.
export function defaultFingerprintOf(root) {
  if (typeof root !== "string" || !root.trim()) fail("VAULT_TARGET_ROOT_INVALID", "Vault 根目录无效。");
  return createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex");
}

export async function defaultProbeWritable(root) {
  try {
    const resolved = await realpath(root);
    const details = await lstat(resolved);
    if (!details.isDirectory() || details.isSymbolicLink()) return false;
    await access(resolved, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function validateDisplayName(value, fallback) {
  if (typeof value !== "string") return fallback;
  const name = value.normalize("NFC").trim();
  if (!name || name.length > CONFIG_NAME_MAX || /[/\\]/.test(name) || name === "." || name === "..") return fallback;
  return name;
}

export function createLearningVaultCatalog({
  vaultRoot,
  configPath = null,
  fingerprintOf = defaultFingerprintOf,
  probeWritable = defaultProbeWritable,
  readConfigFile = readFile,
} = {}) {
  if (typeof vaultRoot !== "string" || !path.isAbsolute(vaultRoot)) {
    fail("VAULT_TARGET_ROOT_INVALID", "当前 Vault 根目录无效。", 500);
  }
  if (typeof fingerprintOf !== "function" || typeof probeWritable !== "function" || typeof readConfigFile !== "function") {
    fail("VAULT_TARGET_CONFIG_INVALID", "Vault 候选目录配置无效。", 500);
  }
  const currentRoot = path.resolve(vaultRoot);

  async function loadConfig() {
    if (!configPath) return { vaults: [], warnings: [] };
    let raw;
    try {
      raw = await readConfigFile(configPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { vaults: [], warnings: [] };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail("VAULT_TARGET_CONFIG_INVALID", "Vault 候选目录配置无法解析。", 500);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.vaults)) {
      fail("VAULT_TARGET_CONFIG_INVALID", "Vault 候选目录配置格式无效。", 500);
    }
    const warnings = [];
    const vaults = [];
    for (const entry of parsed.vaults) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        warnings.push("候选目录条目格式无效，已跳过。");
        continue;
      }
      const root = typeof entry.root === "string" ? entry.root.trim() : "";
      if (!root || !path.isAbsolute(root)) {
        warnings.push("候选目录必须使用绝对路径，已跳过相对或空路径条目。");
        continue;
      }
      vaults.push({ name: entry.name, root: path.resolve(root) });
    }
    return { vaults, warnings };
  }

  async function entries() {
    const { vaults, warnings } = await loadConfig();
    const resolved = new Map([[comparableRoot(currentRoot), true]]);
    const rows = [{ vaultId: fingerprintOf(currentRoot), displayName: path.basename(currentRoot), root: currentRoot, source: "current" }];
    for (const entry of vaults) {
      const key = comparableRoot(entry.root);
      if (resolved.has(key)) continue; // Current vault or an earlier config entry wins.
      resolved.set(key, true);
      rows.push({
        vaultId: fingerprintOf(entry.root),
        displayName: validateDisplayName(entry.name, path.basename(entry.root)),
        root: entry.root,
        source: "config",
      });
    }
    return { rows, warnings };
  }

  async function listCandidates() {
    const { rows, warnings } = await entries();
    const candidates = [];
    for (const row of rows) {
      const writable = await probeWritable(row.root);
      candidates.push({
        vaultId: row.vaultId,
        displayName: row.displayName,
        maskedPath: `…/${path.basename(row.root)}`,
        writable,
        isCurrent: row.source === "current",
        source: row.source,
      });
    }
    return { candidates, warnings };
  }

  async function resolveTarget(vaultId) {
    if (typeof vaultId !== "string" || !FINGERPRINT_PATTERN.test(vaultId)) return null;
    const wanted = vaultId.toLowerCase();
    const { rows } = await entries();
    const row = rows.find((item) => item.vaultId.toLowerCase() === wanted);
    if (!row) return null;
    return {
      vaultId: row.vaultId,
      displayName: row.displayName,
      root: row.root,
      maskedPath: `…/${path.basename(row.root)}`,
      writable: await probeWritable(row.root),
      isCurrent: row.source === "current",
      source: row.source,
    };
  }

  return Object.freeze({ listCandidates, resolveTarget });
}