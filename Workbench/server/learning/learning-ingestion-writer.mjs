import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeFilenamePart } from "../security.mjs";
import { LearningIngestionError } from "./learning-ingestion-repository.mjs";

const TARGET_BASE = "Wiki/学习";
const SELECTION_TYPES = new Set(["plan", "notes"]);
const ARTIFACT_PREFIX = "artifact:";
const MAX_PLAN_CHARS = 32 * 1024;

export class LearningIngestionWriterError extends LearningIngestionError {}

function fail(code, message, status = 400) {
  throw new LearningIngestionWriterError(code, message, status);
}

function comparable(absolutePath) {
  return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Server-generated target paths must stay inside the target vault root. The
// browser can only ever influence artifact ids through the content store, and
// those ids are schema-constrained UUIDs; this check is the last line before
// any mkdir or write and also covers hand-crafted caller input.
function requireSafeRelativePath(targetRoot, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) {
    fail("INGESTION_UNSAFE_PATH", "目标文件路径无效。", 500);
  }
  const normalized = relativePath.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (
    normalized.length === 0 ||
    normalized.some((segment) => segment === "..") ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes("\\")
  ) {
    fail("INGESTION_UNSAFE_PATH", "目标文件路径无效。", 500);
  }
  const lexical = path.resolve(targetRoot, ...normalized);
  if (!isPathInside(targetRoot, lexical)) {
    fail("INGESTION_UNSAFE_PATH", "目标文件路径越出了目标 Vault。", 500);
  }
  return { relativePath: normalized.join("/"), absolute: lexical };
}

async function pathExists(absolutePath) {
  try {
    const details = await lstat(absolutePath);
    return { existed: true, isSymbolicLink: details.isSymbolicLink() };
  } catch (error) {
    if (error?.code === "ENOENT") return { existed: false, isSymbolicLink: false };
    throw error;
  }
}

function planMarkdown(content) {
  const milestones = Array.isArray(content.milestones) ? content.milestones : [];
  const lines = [
    "# 学习计划",
    "",
    "## 学习目标",
    String(content.learningGoal ?? "").trim() || "（未填写）",
    "",
    "## 预期产出",
    String(content.expectedOutcome ?? "").trim() || "（未填写）",
    "",
    "## 里程碑",
    ...(milestones.length
      ? milestones.map((milestone) => `- [${milestone.done ? "x" : " "}] ${String(milestone.title ?? "").trim() || "（未命名里程碑）"}`)
      : ["（无里程碑）"]),
    "",
  ].join("\n");
  return lines.slice(0, MAX_PLAN_CHARS);
}

export function sanitizeRepositoryDirectoryName(fullName) {
  // "owner/repo" and any exotic characters become a plain file-name-safe slug.
  return sanitizeFilenamePart(String(fullName ?? ""), "repository") || "repository";
}

export function buildTargetFiles({ repoFullName, selectedContentTypes, content, now = () => new Date() }) {
  if (!Array.isArray(selectedContentTypes) || !selectedContentTypes.length) {
    fail("INGESTION_INVALID_SELECTION", "请至少选择一种要摄取的內容。", 400);
  }
  const repoDirectory = sanitizeRepositoryDirectoryName(repoFullName);
  const dir = `${TARGET_BASE}/${repoDirectory}`;

  const artifactIds = new Set(Array.isArray(content?.artifacts) ? content.artifacts.map((artifact) => artifact.artifactId) : []);
  const missing = [];
  const files = [];

  for (const selection of selectedContentTypes) {
    if (selection === "plan") {
      if (content?.learningPlan && typeof content.learningPlan === "object") {
        files.push({ kind: "plan", artifactId: null, relativePath: `${dir}/学习计划.md`, markdown: planMarkdown(content.learningPlan) });
      } else {
        missing.push("学习计划");
      }
      continue;
    }
    if (selection === "notes") {
      const text = typeof content?.notes?.markdownText === "string" ? content.notes.markdownText.trim() : "";
      if (text) {
        files.push({ kind: "notes", artifactId: null, relativePath: `${dir}/学习笔记.md`, markdown: text });
      } else {
        missing.push("学习笔记");
      }
      continue;
    }
    if (typeof selection === "string" && selection.startsWith(ARTIFACT_PREFIX)) {
      const artifactId = selection.slice(ARTIFACT_PREFIX.length);
      const artifact = Array.isArray(content?.artifacts) ? content.artifacts.find((item) => item.artifactId === artifactId) : null;
      if (artifact) {
        const title = String(artifact.title ?? "").trim() || "产出物";
        files.push({
          kind: "artifact",
          artifactId,
          relativePath: `${dir}/学习产出-${artifactId}.md`,
          markdown: `# ${title.slice(0, 240)}\n\n${String(artifact.markdownText ?? "").trim()}\n`,
        });
      } else {
        missing.push(titleOf(artifactId));
      }
      continue;
    }
    fail("INGESTION_INVALID_SELECTION", "摄取内容选择包含不支持的条目。", 400);
  }

  if (missing.length) {
    fail("INGESTION_EMPTY_SELECTION", `选中的摄取内容不存在：${missing.join("、")}。`, 400);
  }
  if (!files.length) {
    fail("INGESTION_EMPTY_SELECTION", "选中的摄取内容为空。", 400);
  }
  return { files };
}

function titleOf(artifactId) {
  return String(artifactId ?? "").slice(0, 24) || "学习产出物";
}

// Maps the preview's file plan onto final target paths given the user's
// conflict resolution. `previewExistence` is the snapshot taken at preview
// time; a file whose real state differs now is a stale preview and rejects.
export async function planConflictResolution({ targetRoot, files, previewExistence, resolution }) {
  if (resolution !== undefined && !["skip", "new-version"].includes(resolution)) {
    fail("INGESTION_INVALID_RESOLUTION", "冲突处理方式无效。", 400);
  }
  if (!Array.isArray(files) || !files.length) fail("INGESTION_PLAN_EMPTY", "没有可写入的文件计划。", 400);
  const preview = new Map();
  if (Array.isArray(previewExistence)) {
    for (const entry of previewExistence) {
      if (entry && typeof entry.relativePath === "string") preview.set(entry.relativePath, entry.existed === true);
    }
  }
  const plan = [];
  for (const file of files) {
    const safe = requireSafeRelativePath(targetRoot, file.relativePath);
    const snapshotted = preview.has(file.relativePath);
    if (!snapshotted) fail("INGESTION_PLAN_MISMATCH", "目标文件计划与预览不一致。", 409);
    const existedAtPreview = preview.get(file.relativePath);
    const current = await pathExists(safe.absolute);
    if (current.existed !== existedAtPreview) {
      fail("INGESTION_CONFLICT_CHANGED", "目标文件状态已改变，请重新预览后再确认。", 409);
    }
    if (!current.existed) {
      plan.push({ ...file, relativePath: safe.relativePath, baseRelativePath: safe.relativePath, mode: "create" });
      continue;
    }
    if (current.isSymbolicLink) fail("INGESTION_UNSAFE_PATH", "目标位置是符号链接，拒绝写入。", 500);
    if (resolution === "skip") {
      plan.push({ ...file, relativePath: safe.relativePath, baseRelativePath: safe.relativePath, mode: "skip" });
      continue;
    }
    if (resolution === "new-version") {
      const extension = path.extname(safe.relativePath);
      const stem = safe.relativePath.slice(0, -extension.length);
      let candidate = null;
      for (let version = 2; version <= 32; version += 1) {
        const next = `${stem}-${version}${extension}`;
        const checked = requireSafeRelativePath(targetRoot, next);
        const status = await pathExists(checked.absolute);
        if (!status.existed) { candidate = { relativePath: next, absolute: checked.absolute }; break; }
        if (status.isSymbolicLink) fail("INGESTION_UNSAFE_PATH", "目标位置是符号链接，拒绝写入。", 500);
      }
      if (!candidate) fail("INGESTION_NAME_EXHAUSTED", "无法生成不冲突的新版本文件名。", 409);
      plan.push({ ...file, relativePath: candidate.relativePath, baseRelativePath: safe.relativePath, mode: "new-version" });
      continue;
    }
    fail("INGESTION_CONFLICT_UNRESOLVED", "目标文件已存在，请选择跳过或生成新版本。", 409);
  }
  return plan;
}

// Walks the target directory tree, creating real (never symlinked) directories
// and verifying every ancestor stays inside the vault root by realpath.
async function resolveSafeDirectory(targetRoot, relativeDirectory) {
  const absoluteRoot = await realpath(targetRoot);
  const rootDetails = await lstat(absoluteRoot);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    fail("INGESTION_UNSAFE_PATH", "目标 Vault 根目录无效。", 500);
  }
  if (relativeDirectory === "") return { absolute: absoluteRoot, root: absoluteRoot };
  const segments = relativeDirectory.split("/");
  let current = absoluteRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const details = await pathExists(current);
    if (!details.existed) {
      await mkdir(current, { mode: 0o700 });
    } else if (details.isSymbolicLink || !(await lstat(current)).isDirectory()) {
      fail("INGESTION_UNSAFE_PATH", "写入路径存在符号链接或非目录条目。", 500);
    }
    const real = comparable(await realpath(current));
    if (!isPathInside(comparable(absoluteRoot), real)) {
      fail("INGESTION_UNSAFE_PATH", "写入路径越出了目标 Vault。", 500);
    }
  }
  return { absolute: current, root: absoluteRoot };
}

async function writeOneFile({ targetRoot, relativePath, markdown }) {
  const safe = requireSafeRelativePath(targetRoot, relativePath);
  const parent = path.posix.dirname(safe.relativePath);
  const directory = await resolveSafeDirectory(targetRoot, parent);
  const final = path.join(directory.absolute, path.basename(safe.relativePath));
  if (!isPathInside(directory.absolute, final)) fail("INGESTION_UNSAFE_PATH", "目标文件路径越出了目标目录。", 500);

  // No-overwrite guard: never replace an entry that appeared after the plan.
  const now = await pathExists(final);
  if (now.existed) fail("INGESTION_CONFLICT_CHANGED", "目标文件已存在，请重新预览。", 409);

  const temporary = path.join(directory.absolute, `.${path.basename(final)}.${randomUUID()}.ingest-tmp`);
  const body = String(markdown ?? "");
  if (Buffer.byteLength(body, "utf8") > MAX_PLAN_CHARS * 4) fail("INGESTION_TOO_LARGE", "目标文件超过安全大小。", 413);
  let handle = null;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    // Copy semantics: the final target must still be absent at rename time.
    const again = await pathExists(final);
    if (again.existed) fail("INGESTION_CONFLICT_CHANGED", "目标文件已存在，请重新预览。", 409);
    await rename(temporary, final);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error instanceof LearningIngestionWriterError) throw error;
    if (error?.code === "EEXIST" || error?.code === "EPERM") {
      fail("INGESTION_CONFLICT_CHANGED", "目标文件已存在，请重新预览。", 409);
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  return { absolutePath: final, relativePath: safe.relativePath };
}

// Snapshot whether each planned file already exists in the target vault. This
// is the preview's conflict census; confirm re-runs the same probes and must
// see an identical snapshot before any write is allowed.
export async function probeFileExistence({ targetRoot, files }) {
  return Promise.all(files.map(async (file) => {
    const safe = requireSafeRelativePath(targetRoot, file.relativePath);
    const status = await pathExists(safe.absolute);
    return { relativePath: safe.relativePath, kind: file.kind, artifactId: file.artifactId ?? null, existed: status.existed };
  }));
}

// Writes the whole approved plan. Files are written one by one with
// tmp -> fsync -> rename; a mid-batch failure rolls back every file this call
// created, in reverse order, so no partial artifacts are ever left behind.
export async function writeVaultFiles({ targetRoot, plan, now = () => new Date() }) {
  if (typeof targetRoot !== "string" || !path.isAbsolute(targetRoot)) fail("INGESTION_UNSAFE_PATH", "目标 Vault 根目录无效。", 500);
  const root = path.resolve(targetRoot);
  const written = [];
  try {
    for (const entry of plan) {
      if (entry?.mode === "skip") continue;
      const safe = requireSafeRelativePath(root, entry.relativePath);
      if (typeof entry.markdown !== "string") fail("INGESTION_PLAN_EMPTY", "写入计划缺少文件内容。", 400);
      written.push(await writeOneFile({ targetRoot: root, relativePath: safe.relativePath, markdown: entry.markdown }));
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...written].reverse()) {
      try {
        await unlink(item.absolutePath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") rollbackErrors.push(unlinkError);
      }
    }
    if (error instanceof LearningIngestionWriterError) {
      if (rollbackErrors.length) fail("INGESTION_PARTIAL_ROLLBACK", "写入失败且回滚未能完整完成，请检查目标 Vault。", 500);
      throw error;
    }
    if (rollbackErrors.length) fail("INGESTION_PARTIAL_ROLLBACK", "写入失败且回滚未能完整完成，请检查目标 Vault。", 500);
    fail("INGESTION_WRITE_FAILED", "写入 Obsidian 失败，已回滚本次尝试。", 500);
  }
  return { written };
}