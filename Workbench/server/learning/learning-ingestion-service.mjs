import { createHash } from "node:crypto";
import { LearningIngestionError } from "./learning-ingestion-repository.mjs";
import {
  buildTargetFiles,
  planConflictResolution,
  probeFileExistence,
  writeVaultFiles,
} from "./learning-ingestion-writer.mjs";

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_INGESTION_FILES = 128;
const MAX_PREVIEW_SNIPPET_CHARS = 2_000;
const MAX_SELECTED_TYPES = 64;
const MAX_ERROR_MESSAGE_CHARS = 200;

function fail(code, message, status = 400) {
  throw new LearningIngestionError(code, message, status);
}

function safeErrorMessage(error) {
  const raw = error?.message;
  const message = typeof raw === "string" ? raw.trim() : "";
  if (!message) return "写入 Obsidian 失败，已回滚本次尝试。";
  // Only curated service messages are persisted; anything that looks like a
  // local path or credential is reduced to the safe fallback.
  const looksDangerous =
    pathLike(message) ||
    /\b(?:authorization|cookie|set-cookie)\s*:/i.test(message) ||
    /\b(?:token|api[_-]?key|password|secret)\s*[:=]\s*\S+/i.test(message);
  return looksDangerous ? "写入 Obsidian 失败，已回滚本次尝试。" : message.slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function pathLike(text) {
  return (
    /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/[A-Za-z0-9_.-]+\/)/i.test(text) &&
    /\\|\//.test(text)
  );
}

function dedupeSelection(selectedContentTypes) {
  if (!Array.isArray(selectedContentTypes) || selectedContentTypes.length === 0 || selectedContentTypes.length > MAX_SELECTED_TYPES) {
    fail("INGESTION_INVALID_SELECTION", "请选择要摄取的內容。", 400);
  }
  return [...new Set(selectedContentTypes.map((item) => (typeof item === "string" ? item : "")))].filter(Boolean);
}

function filePlanHashOf(files) {
  return createHash("sha256").update(JSON.stringify(files.map((file) => file.relativePath).sort())).digest("hex");
}

function publicFile(file, markdown) {
  return {
    relativePath: file.relativePath,
    kind: file.kind,
    artifactId: file.artifactId ?? null,
    conflict: file.existed === true,
    mode: "create",
    preview: typeof markdown === "string" ? markdown.slice(0, MAX_PREVIEW_SNIPPET_CHARS) : "",
  };
}

// Orchestrates the Obsidian ingestion workflow over three deep modules: the
// vault catalog (safe candidate resolution), the ingestion store (selection,
// token lifecycle and history) and the writer (conflict census + atomic batch
// write). The HTTP layer stays a thin router; every mutation runs under the
// same workspace-binding guard as the other learning mutations.
export function createLearningIngestionService({
  learning,
  store,
  catalog,
  bound,
  captureBinding,
  lookupBoundWorkspace,
  readOnly = false,
  hosted = false,
} = {}) {
  if (!learning || typeof learning.get !== "function") throw new TypeError("learning repository is required");
  if (!store || typeof catalog !== "object") throw new TypeError("ingestion store and vault catalog are required");
  if (typeof bound !== "function" || typeof captureBinding !== "function") throw new TypeError("ingestion service requires a bound wrapper");
  if (lookupBoundWorkspace !== null && typeof lookupBoundWorkspace !== "function") throw new TypeError("lookupBoundWorkspace must be a function or null");

  const mutation = (operation) => {
    if (hosted) fail("INGESTION_UNAVAILABLE", "托管模式下学习摄取不可用。", 404);
    if (readOnly) fail("INGESTION_READ_ONLY", "当前工作区不允许摄取出写。", 403);
    return bound(null, operation);
  };

  const storeFor = async ({ create = false } = {}) => {
    const repository = typeof store === "function" ? await store({ create }) : await store;
    if (!repository) fail("WORKSPACE_NOT_FOUND", "学习工作区不存在。", 404);
    return repository;
  };

  function capabilities() {
    return Object.freeze({
      read: !hosted,
      select: !hosted && !readOnly,
      preview: !hosted,
      confirm: !hosted && !readOnly,
    });
  }

  async function listTargets({ workspaceId }) {
    if (hosted) fail("INGESTION_UNAVAILABLE", "托管模式下学习摄取不可用。", 404);
    await learning.get(workspaceId);
    const { candidates, warnings } = await catalog.listCandidates();
    const selection = await (await storeFor()).getSelection(workspaceId);
    const selectedId = selection.selection?.targetVaultId ?? null;
    const targets = await Promise.all(candidates.map(async (candidate) => {
      const bound = lookupBoundWorkspace ? await lookupBoundWorkspace(candidate.vaultId) : null;
      return {
        vaultId: candidate.vaultId,
        displayName: candidate.displayName,
        maskedPath: candidate.maskedPath,
        writable: candidate.writable,
        isCurrent: candidate.isCurrent,
        boundToWorkspace: Boolean(bound),
        selected: candidate.vaultId === selectedId,
      };
    }));
    let current = null;
    if (selection.selection) {
      const match = targets.find((target) => target.vaultId === selection.selection.targetVaultId);
      current = {
        vaultId: selection.selection.targetVaultId,
        displayName: selection.selection.targetVaultDisplayName,
        maskedPath: selection.selection.targetMaskedPath,
        writable: match?.writable ?? false,
      };
    }
    return { targets, current, warnings };
  }

  async function setTarget({ workspaceId, vaultId }) {
    return mutation(async () => {
      await learning.get(workspaceId, { create: true });
      if (typeof vaultId !== "string" || !FINGERPRINT_PATTERN.test(vaultId)) {
        fail("INGESTION_INVALID_INPUT", "目标 Vault 指纹无效。", 400);
      }
      const target = await catalog.resolveTarget(vaultId);
      if (!target) fail("VAULT_TARGET_NOT_FOUND", "目标 Vault 不存在或未被允许。", 404);
      const repository = await storeFor({ create: true });
      const { selection } = await repository.setSelection({
        workspaceId,
        targetVaultId: target.vaultId,
        targetVaultDisplayName: target.displayName,
        targetMaskedPath: target.maskedPath,
      });
      return {
        target: {
          vaultId: selection.targetVaultId,
          displayName: selection.targetVaultDisplayName,
          maskedPath: selection.targetMaskedPath,
          writable: target.writable,
          isCurrent: target.isCurrent,
          selectedAt: selection.selectedAt,
        },
      };
    });
  }

  async function preview({ workspaceId, selectedContentTypes, targetVaultId }) {
    if (hosted) fail("INGESTION_UNAVAILABLE", "托管模式下学习摄取不可用。", 404);
    const types = dedupeSelection(selectedContentTypes);
    if (readOnly && (typeof targetVaultId !== "string" || !FINGERPRINT_PATTERN.test(targetVaultId))) {
      fail("INGESTION_TARGET_UNSELECTED", "请先选择目标仓库。", 409);
    }
    const { workspace } = await learning.get(workspaceId);
    const { content } = await learning.content.getContent({ workspaceId });
    const repository = await storeFor();

    let target;
    if (readOnly) {
      target = await catalog.resolveTarget(targetVaultId);
      if (!target) fail("VAULT_TARGET_NOT_FOUND", "目标 Vault 不存在或未被允许。", 404);
    } else {
      const selection = await repository.getSelection(workspaceId);
      if (!selection.selection) fail("INGESTION_TARGET_UNSELECTED", "请先选择目标仓库。", 409);
      target = await catalog.resolveTarget(selection.selection.targetVaultId);
      if (!target) fail("VAULT_TARGET_NOT_FOUND", "目标 Vault 已不可用，请重新选择。", 404);
    }

    let plan;
    try {
      plan = buildTargetFiles({ repoFullName: workspace.fullName, selectedContentTypes: types, content: content ?? {} });
    } catch (error) {
      if (error?.code === "INGESTION_EMPTY_SELECTION" || error?.code === "INGESTION_INVALID_SELECTION") throw error;
      throw error;
    }
    const existence = await probeFileExistence({ targetRoot: target.root, files: plan.files });
    const filePlanHash = filePlanHashOf(existence);
    const contentRevision = content?.revision ?? 0;
    const publicTarget = {
      vaultId: target.vaultId,
      displayName: target.displayName,
      maskedPath: target.maskedPath,
      writable: target.writable,
      isCurrent: target.isCurrent,
    };
    const files = existence.map((file) => {
      const source = plan.files.find((item) => item.relativePath === file.relativePath);
      return publicFile(file, source?.markdown ?? "");
    });
    const conflicts = files.filter((file) => file.conflict).map((file) => file.relativePath);

    if (readOnly || !target.writable) {
      // Read-only app mode and unwritable targets preview without minting a
      // token; the UI hides confirmation in both cases.
      return {
        previewRevision: null,
        confirmAvailable: false,
        target: publicTarget,
        sourceCommitSha: workspace.sourceCommitSha,
        contentRevision,
        selectedContentTypes: types,
        files,
        conflicts,
      };
    }

    const binding = await captureBinding();
    if (!binding) fail("WORKSPACE_NOT_FOUND", "当前 Vault 尚未绑定工作区。", 404);
    const issued = await bound(binding, () => repository.issuePreview({
      workspaceId,
      binding,
      target: { vaultId: target.vaultId, displayName: target.displayName, maskedPath: target.maskedPath },
      sourceCommitSha: workspace.sourceCommitSha,
      contentRevision,
      selectedContentTypes: types,
      files: existence,
      filePlanHash,
    }));
    return {
      previewRevision: issued.previewRevision,
      confirmAvailable: true,
      previewToken: issued.token,
      expiresAt: issued.expiresAt,
      target: publicTarget,
      sourceCommitSha: workspace.sourceCommitSha,
      contentRevision,
      selectedContentTypes: types,
      files,
      conflicts,
    };
  }

  async function confirm({ token, conflictResolution }) {
    // The whole confirm is one binding-guarded unit: the registry lock is
    // taken exactly once, so the token's stored binding, the current content,
    // the selection and the target-vault state cannot be spliced from two
    // different bindings. The store serializes begin/finish itself.
    if (hosted) fail("INGESTION_UNAVAILABLE", "托管模式下学习摄取不可用。", 404);
    if (readOnly) fail("INGESTION_READ_ONLY", "当前工作区不允许写入选定的 Obsidian 仓库。", 403);
    if (typeof token !== "string" || !token) fail("INGESTION_INVALID_INPUT", "确认凭证无效。", 409);
    if (conflictResolution !== undefined && !["skip", "new-version"].includes(conflictResolution)) {
      fail("INGESTION_INVALID_RESOLUTION", "冲突处理方式无效。", 400);
    }
    const binding = await captureBinding();
    if (!binding) fail("WORKSPACE_NOT_FOUND", "当前 Vault 尚未绑定工作区。", 404);
    return bound(binding, async () => {
        // All reads inside the binding guard use create:true so they resolve off
        // the cached workspace promise captured outside the registry lock;
        // create:false would re-enter the registry queue and deadlock.
        const repository = await storeFor({ create: true });
        const tokenRecord = await repository.ownerOf({ token });
        if (!tokenRecord) fail("INGESTION_TOKEN_INVALID", "确认凭证无效或已失效。", 409);
        const { workspace } = await learning.get(tokenRecord.workspaceId, { create: true });
        const { content } = await learning.content.getContent({ workspaceId: tokenRecord.workspaceId }, { create: true });
        const selection = await repository.getSelection(tokenRecord.workspaceId);
        if (!selection.selection) fail("INGESTION_TARGET_UNSELECTED", "目标仓库选择已失效。", 409);
        const target = await catalog.resolveTarget(selection.selection.targetVaultId);
        if (!target) fail("VAULT_TARGET_NOT_FOUND", "目标 Vault 已不存在，请重新选择。", 404);
        if (!target.writable) fail("VAULT_TARGET_UNWRITABLE", "目标 Vault 当前为只读，无法写入。", 403);

        try {
          const started = await repository.beginConfirm({
            token,
            sourceCommitSha: workspace.sourceCommitSha,
            contentRevision: content?.revision ?? 0,
            targetVaultId: target.vaultId,
            selectedContentTypes: tokenRecord.selectedContentTypes,
            filePlanHash: filePlanHashOf(tokenRecord.files),
            binding,
          });
          if (started.receipt) {
            return { replayed: true, ingestion: started.record, receipt: started.receipt };
          }
          const files = buildTargetFiles({
            repoFullName: workspace.fullName,
            selectedContentTypes: tokenRecord.selectedContentTypes,
            content: content ?? {},
          });
          const plan = await planConflictResolution({
            targetRoot: target.root,
            files: files.files,
            previewExistence: tokenRecord.files.map((file) => ({ relativePath: file.relativePath, existed: file.existed })),
            resolution: conflictResolution,
          });
          const { written } = await writeVaultFiles({ targetRoot: target.root, plan });
          const done = await repository.finishConfirm({
            token,
            outcome: { status: "written", writtenFiles: written.map((item) => item.relativePath) },
          });
          return { replayed: false, ingestion: done.record, receipt: done.receipt };
        } catch (error) {
          await repository.finishConfirm({
            token,
            outcome: {
              status: "failed",
              errorCode: String(error?.code ?? "INGESTION_WRITE_FAILED"),
              errorMessage: safeErrorMessage(error),
            },
          }).catch(() => {});
          throw error;
        }
      });
  }

  async function listIngestions({ workspaceId }) {
    if (hosted) fail("INGESTION_UNAVAILABLE", "托管模式下学习摄取不可用。", 404);
    await learning.get(workspaceId);
    const repository = await storeFor();
    const { records } = await repository.listRecords(workspaceId);
    return { ingestions: records };
  }

  return Object.freeze({
    capabilities, listTargets, setTarget, preview, confirm, listIngestions,
  });
}