import { useCallback, useEffect, useRef, useState } from "react";
import {
  confirmLearningIngestion,
  loadLearningArtifacts,
  loadLearningTargets,
  previewLearningIngestion,
  setLearningTarget,
} from "../../lib/learning-api.js";

// Selectable Obsidian ingestion surface for one learning workspace. The target
// vault is chosen from a server-resolved candidate catalog (the browser can
// never submit a path), previewed through a short-lived token, and only written
// after an explicit confirmation. Ingestion success records the write and never
// touches the learning workspace state machine.

const CONTENT_OPTIONS = [
  { key: "plan", label: "学习计划", target: "学习计划.md" },
  { key: "notes", label: "学习笔记", target: "学习笔记.md" },
];

// Codes that invalidate the underlying preview token: confirming again with the
// same token can never succeed, so the UI must fall back to a fresh preview.
const PREVIEW_INVALIDATING_CODES = new Set([
  "INGESTION_TOKEN_INVALID",
  "INGESTION_TARGET_CHANGED",
  "INGESTION_TARGET_UNSELECTED",
  "INGESTION_CONTENT_CHANGED",
  "INGESTION_SOURCE_CHANGED",
  "INGESTION_BINDING_CHANGED",
  "INGESTION_PLAN_MISMATCH",
]);

function failMessage(error, fallback) {
  const message = error?.message;
  return typeof message === "string" && message.trim() ? message.trim() : fallback;
}

export function LearningIngestionPanel({ caps, readOnly = false, workspaceId }) {
  const ingest = caps?.ingest;
  const canSelect = ingest?.select === true;
  const canPreview = ingest?.preview === true;
  const canConfirm = !readOnly && ingest?.confirm === true;

  const [targetsState, setTargetsState] = useState({ loading: false, error: null, candidates: [], current: null });
  const [targetBusy, setTargetBusy] = useState(false);
  const [artifactsState, setArtifactsState] = useState({ loading: false, error: null, artifacts: [] });
  const [selectedVaultId, setSelectedVaultId] = useState(null);
  const [selectedTypes, setSelectedTypes] = useState(() => new Set(["plan", "notes"]));
  const [preview, setPreview] = useState(null);
  const [previewState, setPreviewState] = useState({ busy: false, error: null });
  const [confirmState, setConfirmState] = useState({ busy: false, error: null });
  const [resolution, setResolution] = useState("cancel");
  const [outcome, setOutcome] = useState(null);
  const [notice, setNotice] = useState(null);
  const aliveRef = useRef(true);
  // Monotonic guard so a slow preview/confirm can never paint over a newer
  // target selection or content choice. Any interaction that changes what a
  // preview means bumps this counter; stale responses simply drop.
  const previewSeqRef = useRef(0);
  // Synchronous source of truth: two clicks in the same tick cannot double-fire.
  const busyRef = useRef({ target: false, preview: false, confirm: false });

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const loadTargets = useCallback(async () => {
    if (!workspaceId) return;
    setTargetsState((s) => ({ ...s, loading: true, error: null }));
    try {
      const body = await loadLearningTargets(workspaceId);
      if (!aliveRef.current) return;
      const candidates = Array.isArray(body?.targets) ? body.targets : [];
      const current = body?.current ?? null;
      setTargetsState({ loading: false, error: null, candidates, current });
      setSelectedVaultId(current?.vaultId ?? null);
    } catch (error) {
      if (!aliveRef.current) return;
      setTargetsState((s) => ({ ...s, loading: false, error: failMessage(error, "目标仓库加载失败。") }));
    }
  }, [workspaceId]);

  const loadArtifacts = useCallback(async () => {
    if (!workspaceId) return;
    setArtifactsState((s) => ({ ...s, loading: true, error: null }));
    try {
      const body = await loadLearningArtifacts(workspaceId);
      if (!aliveRef.current) return;
      setArtifactsState({ loading: false, error: null, artifacts: Array.isArray(body?.artifacts) ? body.artifacts : [] });
    } catch (error) {
      if (!aliveRef.current) return;
      setArtifactsState({ loading: false, error: failMessage(error, "学习产出物加载失败。"), artifacts: [] });
    }
  }, [workspaceId]);

  // A workspace switch resets every ingestion interaction state.
  useEffect(() => {
    previewSeqRef.current += 1;
    setPreview(null);
    setOutcome(null);
    setNotice(null);
    setConfirmState({ busy: false, error: null });
    setPreviewState({ busy: false, error: null });
    setResolution("cancel");
    void loadTargets();
    void loadArtifacts();
  }, [workspaceId, loadTargets, loadArtifacts]);

  const invalidatePreview = useCallback((bumpSeq = true) => {
    if (bumpSeq) previewSeqRef.current += 1;
    // A stale in-flight preview/confirm must neither paint nor keep the buttons
    // busy: the old completion only releases its flag when it is still the
    // latest sequence, so a newer flight started before it resolved stays safe.
    busyRef.current.preview = false;
    busyRef.current.confirm = false;
    setPreview(null);
    setOutcome(null);
    setPreviewState({ busy: false, error: null });
    setConfirmState((s) => ({ ...s, busy: false, error: null }));
  }, []);

  const onTargetChange = useCallback(async (vaultId) => {
    if (busyRef.current.target || busyRef.current.confirm) return;
    const candidate = targetsState.candidates.find((item) => item.vaultId === vaultId);
    if (!candidate) return;
    // Selecting another vault invalidates any preview tied to the previous one.
    invalidatePreview(true);
    setNotice(null);
    setSelectedVaultId(vaultId);
    if (!canSelect) {
      // Read-only app mode previews off the local choice without persisting it.
      setNotice({ level: "success", message: `已选择目标仓库：${candidate.displayName}` });
      return;
    }
    busyRef.current.target = true;
    setTargetBusy(true);
    try {
      const result = await setLearningTarget(workspaceId, vaultId);
      if (!aliveRef.current) return;
      const displayName = result?.target?.displayName ?? candidate.displayName;
      setNotice({ level: "success", message: `已选择目标仓库：${displayName}` });
    } catch (error) {
      if (!aliveRef.current) return;
      setNotice({ level: "error", message: failMessage(error, "目标仓库选择失败。") });
    } finally {
      busyRef.current.target = false;
      if (aliveRef.current) setTargetBusy(false);
    }
  }, [workspaceId, canSelect, targetsState.candidates, invalidatePreview]);

  const toggleType = useCallback((key, checked) => {
    invalidatePreview(true);
    setSelectedTypes((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, [invalidatePreview]);

  const onPreview = useCallback(async () => {
    if (!canPreview || busyRef.current.preview || busyRef.current.confirm || !selectedVaultId) return;
    const types = [...selectedTypes];
    const seq = previewSeqRef.current;
    busyRef.current.preview = true;
    setPreviewState({ busy: true, error: null });
    setOutcome(null);
    setNotice(null);
    setConfirmState((s) => ({ ...s, error: null }));
    try {
      const body = await previewLearningIngestion(workspaceId, types, selectedVaultId);
      if (!aliveRef.current || seq !== previewSeqRef.current) return;
      setPreview(body ?? null);
      setResolution("cancel");
      setPreviewState({ busy: false, error: null });
    } catch (error) {
      if (!aliveRef.current || seq !== previewSeqRef.current) return;
      setPreview(null);
      setPreviewState({ busy: false, error: failMessage(error, "预览失败。") });
    } finally {
      if (seq === previewSeqRef.current) busyRef.current.preview = false;
    }
  }, [canPreview, selectedTypes, selectedVaultId, workspaceId]);

  const onConfirm = useCallback(async () => {
    const token = preview?.previewToken;
    if (!canConfirm || !token || busyRef.current.confirm || busyRef.current.preview) return;
    const conflicts = preview?.conflicts ?? [];
    if (conflicts.length > 0 && resolution === "cancel") {
      setConfirmState({
        busy: false,
        error: "存在冲突文件：已存在的文件不会被覆盖。请选择“跳过冲突文件”或“生成新版本文件”，或取消本次写入。",
      });
      return;
    }
    const seq = previewSeqRef.current;
    busyRef.current.confirm = true;
    setConfirmState({ busy: true, error: null });
    setNotice(null);
    try {
      const body = await confirmLearningIngestion(
        workspaceId,
        token,
        conflicts.length > 0 ? resolution : undefined,
      );
      if (!aliveRef.current || seq !== previewSeqRef.current) return;
      const record = body?.ingestion ?? null;
      setOutcome({
        files: Array.isArray(record?.writtenFiles) ? record.writtenFiles : [],
        writtenAt: record?.writtenAt ?? null,
      });
      setPreview(null);
      setNotice({ level: "success", message: "已写入 Obsidian。" });
      setConfirmState({ busy: false, error: null });
    } catch (error) {
      if (!aliveRef.current || seq !== previewSeqRef.current) return;
      const message = failMessage(error, "写入 Obsidian 失败。");
      if (PREVIEW_INVALIDATING_CODES.has(error?.code)) {
        setPreview(null);
        setConfirmState({ busy: false, error: `${message}请重新预览。` });
      } else {
        // Write failures rolled back server-side; the same token can retry.
        setConfirmState({ busy: false, error: message });
      }
    } finally {
      if (seq === previewSeqRef.current) busyRef.current.confirm = false;
    }
  }, [canConfirm, preview, resolution, workspaceId]);

  if (!ingest || !canPreview || !workspaceId) return null;

  const candidates = targetsState.candidates;
  const conflicts = preview?.conflicts ?? [];
  const previewBusy = previewState.busy;
  const confirmBusy = confirmState.busy;
  const busy = previewBusy || confirmBusy || targetBusy;
  const previewBlocked = !selectedVaultId || selectedTypes.size === 0 || busy;

  return (
    <section aria-label="Obsidian 摄取" className="learning-ingestion">
      <h2 className="learning-ingestion__title">写入 Obsidian 仓库</h2>
      <p className="learning-ingestion__scope">
        将审核后的学习计划、笔记与产出物写入所选 Obsidian 仓库的 Wiki 目录。摄取写入不会改变学习任务状态，也不会覆盖目标仓库已有文件。
      </p>
      {!canConfirm ? (
        <p className="learning-ingestion__readonly">当前为只读模式：可以查看目标与预览，但不能写入 Obsidian。</p>
      ) : null}
      {notice ? (
        <div className={`learning-notice learning-notice--${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
          <p>{notice.message}</p>
        </div>
      ) : null}
      {targetsState.error ? (
        <div className="learning-notice learning-notice--error" role="alert">
          <p>{targetsState.error}</p>
          <button onClick={() => void loadTargets()} type="button">重试</button>
        </div>
      ) : null}

      <div className="learning-ingestion__field">
        <label htmlFor="learning-ingestion-target">目标 Obsidian 仓库</label>
        {targetsState.loading ? (
          <p className="learning-ingestion__hint">正在读取仓库候选…</p>
        ) : candidates.length === 0 ? (
          <p className="learning-ingestion__empty" role="status">未发现可用的 Obsidian 仓库候选。</p>
        ) : (
          <>
            <select
              disabled={targetBusy || confirmBusy}
              id="learning-ingestion-target"
              onChange={(event) => void onTargetChange(event.target.value)}
              value={selectedVaultId ?? ""}
            >
              {selectedVaultId ? null : <option value="">请选择目标仓库…</option>}
              {candidates.map((candidate) => (
                <option key={candidate.vaultId} value={candidate.vaultId}>
                  {candidate.displayName}
                  {candidate.writable ? "" : "（只读）"}
                  {candidate.boundToWorkspace ? "（已绑定）" : ""}
                  {candidate.isCurrent ? "（当前）" : ""}
                </option>
              ))}
            </select>
            <p className="learning-ingestion__hint">
              候选为已配置或已绑定的本地仓库，显示为脱敏路径；浏览器无法直接指定任意文件夹。
            </p>
          </>
        )}
      </div>

      <fieldset className="learning-ingestion__field" disabled={targetsState.error !== null}>
        <legend>选择摄取内容</legend>
        {CONTENT_OPTIONS.map((option) => (
          <label key={option.key}>
            <input
              checked={selectedTypes.has(option.key)}
              onChange={(event) => toggleType(option.key, event.target.checked)}
              type="checkbox"
            />
            {option.label}
            <span className="learning-ingestion__hint">→ {option.target}</span>
          </label>
        ))}
        {artifactsState.loading ? (
          <p className="learning-ingestion__hint">正在读取学习产出物…</p>
        ) : artifactsState.error ? (
          <p className="learning-ingestion__hint">{artifactsState.error}</p>
        ) : artifactsState.artifacts.length === 0 ? (
          <p className="learning-ingestion__hint">暂无学习产出物。</p>
        ) : (
          artifactsState.artifacts.map((artifact) => (
            <label key={artifact.artifactId}>
              <input
                checked={selectedTypes.has(`artifact:${artifact.artifactId}`)}
                onChange={(event) => toggleType(`artifact:${artifact.artifactId}`, event.target.checked)}
                type="checkbox"
              />
              {artifact.title}
              <span className="learning-ingestion__hint">→ 学习产出-{artifact.artifactId}.md</span>
            </label>
          ))
        )}
      </fieldset>

      <button
        className="learning-ingestion__preview"
        disabled={previewBlocked}
        onClick={() => void onPreview()}
        type="button"
      >
        {previewBusy ? "正在预览…" : "预览写入"}
      </button>
      {selectedVaultId && selectedTypes.size === 0 ? (
        <p className="learning-ingestion__hint">请至少选择一项要摄取的内容。</p>
      ) : null}

      {previewState.error ? (
        <div className="learning-notice learning-notice--error" role="alert">
          <p>预览失败：{previewState.error}</p>
          <button disabled={busy} onClick={() => void onPreview()} type="button">重新预览</button>
        </div>
      ) : null}

      {preview ? (
        <div className="learning-ingestion__preview-box">
          <h3>写入预览</h3>
          <dl className="learning-ingestion__summary">
            <div>
              <dt>目标仓库</dt>
              <dd>{preview.target?.displayName ?? "—"}{preview.target?.maskedPath ? ` · ${preview.target.maskedPath}` : ""}</dd>
            </div>
            <div>
              <dt>固定 commit</dt>
              <dd className="learning-sha">{preview.sourceCommitSha ?? "—"}</dd>
            </div>
            <div>
              <dt>文件数量</dt>
              <dd>{Array.isArray(preview.files) ? preview.files.length : 0}</dd>
            </div>
            <div>
              <dt>冲突文件</dt>
              <dd>{Array.isArray(preview.conflicts) ? preview.conflicts.length : 0}</dd>
            </div>
          </dl>
          <ul className="learning-ingestion__files">
            {preview.files.map((file) => (
              <li key={file.relativePath}>
                <code>{file.relativePath}</code>
                {file.conflict ? <span className="learning-ingestion__badge">已存在</span> : null}
                {file.preview ? <pre className="learning-ingestion__snippet">{file.preview}</pre> : null}
              </li>
            ))}
          </ul>
          {conflicts.length > 0 ? (
            <div className="learning-ingestion__conflicts" role="alert">
              <h4>冲突：以下文件已存在于目标仓库，不会被覆盖</h4>
              <ul>
                {conflicts.map((relativePath) => (
                  <li key={relativePath}><code>{relativePath}</code></li>
                ))}
              </ul>
              <fieldset>
                <legend>选择冲突处理方式</legend>
                <label>
                  <input checked={resolution === "cancel"} onChange={() => setResolution("cancel")} type="radio" name="ingestion-resolution" value="cancel" />
                  取消写入
                </label>
                <label>
                  <input checked={resolution === "skip"} onChange={() => setResolution("skip")} type="radio" name="ingestion-resolution" value="skip" />
                  跳过冲突文件
                </label>
                <label>
                  <input checked={resolution === "new-version"} onChange={() => setResolution("new-version")} type="radio" name="ingestion-resolution" value="new-version" />
                  生成新版本文件
                </label>
              </fieldset>
            </div>
          ) : null}
          {canConfirm ? (
            <button
              className="learning-ingestion__confirm"
              disabled={confirmBusy || previewBusy || (conflicts.length > 0 && resolution === "cancel")}
              onClick={() => void onConfirm()}
              type="button"
            >
              {confirmBusy ? "正在写入…" : "确认写入 Obsidian"}
            </button>
          ) : null}
          {confirmState.error ? (
            <div className="learning-notice learning-notice--error" role="alert">
              <p>写入失败：{confirmState.error}</p>
              {preview ? (
                <button disabled={confirmBusy || previewBusy} onClick={() => void onConfirm()} type="button">重试</button>
              ) : (
                <button disabled={busy} onClick={() => void onPreview()} type="button">重新预览</button>
              )}
            </div>
          ) : null}
          {!canConfirm ? (
            <p className="learning-ingestion__hint">当前为只读模式：可以预览，但不能写入 Obsidian。</p>
          ) : null}
        </div>
      ) : null}

      {outcome ? (
        <div className="learning-ingestion__outcome" role="status">
          <h3>已写入 Obsidian</h3>
          <p>摄取成功只代表内容已写入 Obsidian，不会自动改变学习任务状态。</p>
          <ul>
            {outcome.files.map((file) => (
              <li key={file}><code>{file}</code></li>
            ))}
          </ul>
          {outcome.writtenAt ? <p className="learning-ingestion__hint">写入时间：{outcome.writtenAt}</p> : null}
        </div>
      ) : null}
    </section>
  );
}