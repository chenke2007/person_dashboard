import { useEffect, useRef, useState } from "react";
import {
  confirmLearning,
  createLearningDraft,
  editLearningDraft,
  previewLearningDraft,
} from "../../lib/learning-api.js";
import {
  LEARNING_GOALS,
  LEARNING_GOAL_LABELS,
  projectLearningWorkspace,
} from "../../lib/learning-model.js";
import "./learning.css";

const DEFAULT_GOAL = LEARNING_GOALS[0];

const OUTCOME_COPY = {
  active: "已加入学习",
  queued: "已加入学习队列",
};

const STATE_COPY = {
  draft: "草稿",
  queued: "排队",
  active: "学习中",
  archived: "学习已归档",
};

function messageOf(error, fallback) {
  const message = error?.message;
  return typeof message === "string" && message.trim() ? message.trim() : fallback;
}

// One dialog drives both entry points: a radar card join (creates the draft on
// open) and an existing draft from the learning page (edits in place). The
// create/edit/preview/confirm steps each hit the real HTTP contract; the draft
// is durable after the first create or save, so closing the dialog or
// refreshing never loses "saved" work.
export function LearningDraftDialog({
  repository,
  workspace: existingWorkspace,
  readOnly = false,
  capabilities = null,
  onRefreshWorkspace = null,
  onClose,
  onDraftSaved,
  onConfirmed,
  onOpenWorkspace,
}) {
  const repositoryId = repository?.repositoryId;
  // Each step is gated by its own server capability field; a missing or failed
  // capability conservatively disables that step. `readOnly` stays a hard
  // override (hosted/read-only workspace).
  const can = (key) => !readOnly && (capabilities ? capabilities[key] === true : true);
  const [workspace, setWorkspace] = useState(() => (existingWorkspace ? projectLearningWorkspace(existingWorkspace) : null));
  const [goal, setGoal] = useState(existingWorkspace?.mission?.goal ?? DEFAULT_GOAL);
  const [notes, setNotes] = useState(existingWorkspace?.mission?.notes ?? "");
  const [phase, setPhase] = useState(existingWorkspace ? "editing" : "creating");
  const [preview, setPreview] = useState(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [failedAction, setFailedAction] = useState(null);
  const [notice, setNotice] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const created = useRef(Boolean(existingWorkspace));
  const disposedRef = useRef(false);
  const dialogRef = useRef(null);
  const previouslyFocused = useRef(null);
  // StrictMode simulates an unmount/remount at mount time, so the disposed
  // marker must be re-armed by the effect setup; only a REAL unmount leaves
  // it true. Otherwise the async continuation of an in-flight operation
  // would see "disposed" and abandon the dialog.
  useEffect(() => {
    disposedRef.current = false;
    return () => { disposedRef.current = true; };
  }, []);
  // Move focus into the dialog for keyboard users and restore it to the
  // trigger when the dialog closes or unmounts.
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      const previous = previouslyFocused.current;
      if (previous && typeof previous.focus === "function" && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    if (!preview) return;
    const mission = preview.mission;
    const stale = Boolean(mission && (mission.goal !== goal || mission.notes !== notes));
    setPreviewStale(stale);
  }, [preview, goal, notes]);

  const dirty = Boolean(workspace) && (goal !== workspace.goal || notes !== workspace.notes);

  const createDraftNow = async () => {
    if (!can("create")) return;
    setBusy("create");
    setError(null);
    setFailedAction(null);
    setNotice(null);
    try {
      const result = await createLearningDraft(repositoryId, { goal, notes });
      if (disposedRef.current) return;
      const next = projectLearningWorkspace(result.workspace);
      setWorkspace(next);
      setGoal(next.goal);
      setNotes(next.notes);
      setPhase("editing");
      onDraftSaved?.(result.workspace);
    } catch (createError) {
      if (disposedRef.current) return;
      setError(messageOf(createError, "创建工作区失败，请重试。"));
      setFailedAction("create");
    } finally {
      if (!disposedRef.current) setBusy(null);
    }
  };

  useEffect(() => {
    if (created.current) return;
    created.current = true;
    void createDraftNow();
    // createDraftNow closes over initial prop state; a remount starts a fresh
    // dialog anyway, so a stable closure is the correct behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveDraft = async () => {
    if (!workspace || !can("edit")) return;
    setBusy("edit");
    setError(null);
    setFailedAction(null);
    setNotice(null);
    try {
      const result = await editLearningDraft(workspace.workspaceId, workspace.draftRevision, { goal, notes });
      if (disposedRef.current) return;
      const next = projectLearningWorkspace(result.workspace);
      setWorkspace(next);
      setGoal(next.goal);
      setNotes(next.notes);
      setNotice("任务已保存。");
      onDraftSaved?.(result.workspace);
    } catch (editError) {
      if (disposedRef.current) return;
      if (editError?.code === "REVISION_CONFLICT" && typeof onRefreshWorkspace === "function") {
        try {
          // Adopt the store's fresh revision so a retry is not doomed, while
          // the user's typed goal/notes stay in state (never discarded).
          const fresh = projectLearningWorkspace(await onRefreshWorkspace(workspace.workspaceId));
          if (disposedRef.current || !fresh.workspaceId) return;
          setWorkspace(fresh);
          setError("任务已被其他操作更新，已载入最新任务版本。你的修改仍未丢失，请再次保存或预览。");
          setFailedAction("edit");
          return;
        } catch (refreshError) {
          // Fall through to the generic save error below.
        }
      }
      setError(messageOf(editError, "保存失败，请重试。"));
      setFailedAction("edit");
    } finally {
      if (!disposedRef.current) setBusy(null);
    }
  };

  const openPreview = async () => {
    if (!workspace || !can("preview")) return;
    setBusy("preview");
    setError(null);
    setFailedAction(null);
    setNotice(null);
    try {
      let current = workspace;
      if (goal !== workspace.goal || notes !== workspace.notes) {
        if (!can("edit")) {
          setError("当前工作区不允许修改任务内容，无法生成新预览。");
          setFailedAction("preview");
          return;
        }
        const saved = await editLearningDraft(workspace.workspaceId, workspace.draftRevision, { goal, notes });
        if (disposedRef.current) return;
        current = projectLearningWorkspace(saved.workspace);
        setWorkspace(current);
        setGoal(current.goal);
        setNotes(current.notes);
        onDraftSaved?.(saved.workspace);
      }
      const page = await previewLearningDraft(current.workspaceId);
      if (disposedRef.current) return;
      setPreview(page);
      setPreviewStale(false);
      setPhase("previewing");
    } catch (previewError) {
      if (disposedRef.current) return;
      setError(messageOf(previewError, "无法生成预览，请重试。"));
      setFailedAction("preview");
    } finally {
      if (!disposedRef.current) setBusy(null);
    }
  };

  const confirmJoin = async () => {
    if (!preview || previewStale || !can("confirm")) return;
    setBusy("confirm");
    setError(null);
    setFailedAction(null);
    setNotice(null);
    try {
      const result = await confirmLearning(preview.token);
      if (disposedRef.current) return;
      // `confirmed` is the original confirm outcome; `workspace.state` is the
      // current state and may differ after a later activate/archive.
      setOutcome({ confirmed: result.confirmed, workspace: result.workspace });
      setPhase("confirmed");
      onConfirmed?.(result.workspace, result.confirmed);
    } catch (confirmError) {
      if (disposedRef.current) return;
      // A server-declared dead token can never succeed by replaying it: the
      // only recovery is a fresh preview. Anything else (lost response,
      // network, timeout) is idempotent on the server, so the SAME token may
      // be safely retried.
      const code = confirmError?.code;
      const deadToken = code === "CONFIRM_TOKEN_INVALID" || code === "CONFIRM_TOKEN_CONSUMED"
        || code === "REVISION_CONFLICT" || code === "LEARNING_INVALID_TRANSITION";
      if (deadToken) {
        if (code === "CONFIRM_TOKEN_INVALID" || code === "CONFIRM_TOKEN_CONSUMED") {
          setError("确认凭证已失效，请重新预览后确认（任务内容会保留）。");
        } else {
          setError("任务内容已变化，请重新预览后确认（你的修改会保留）。");
        }
        setFailedAction("confirm-stale");
      } else {
        setError("确认结果未收到，请重试（重复确认不会创建重复记录）。如仍失败请重新预览。");
        setFailedAction("confirm");
      }
    } finally {
      if (!disposedRef.current) setBusy(null);
    }
  };

  const retry = () => {
    if (failedAction === "create") void createDraftNow();
    else if (failedAction === "edit") void saveDraft();
    else if (failedAction === "preview") void openPreview();
    else if (failedAction === "confirm") void confirmJoin();
    else if (failedAction === "confirm-stale") void openPreview();
  };

  const close = () => {
    // Read-only never blocks closing: the user can always dismiss the dialog.
    if (busy) return;
    onClose?.();
  };

  const errorBlock = failedAction ? (
    <div className="learning-dialog__error" role="alert">
      <p>{error}</p>
      <button disabled={Boolean(busy)} onClick={retry} type="button">
        {failedAction === "create" ? "重试"
          : failedAction === "confirm" ? "重试确认"
            : failedAction === "confirm-stale" ? "重新预览"
              : "重试"}
      </button>
      {failedAction === "confirm" ? (
        <button disabled={Boolean(busy)} onClick={() => { setError(null); setFailedAction(null); void openPreview(); }} type="button">
          重新预览
        </button>
      ) : null}
    </div>
  ) : error ? (
    <div className="learning-dialog__error" role="alert">
      <p>{error}</p>
    </div>
  ) : null;

  const editing = (
    <>
      <div className="learning-dialog__repo">
        <p className="learning-dialog__repolink"><a href={repository?.htmlUrl} rel="noopener noreferrer" target="_blank">{workspace?.fullName ?? repository?.fullName}</a></p>
        {repository?.description ? <p className="learning-dialog__repodesc">{repository.description}</p> : null}
      </div>
      <label className="learning-dialog__field">
        学习目标
        <select disabled={Boolean(busy)} name="goal" onChange={(event) => setGoal(event.target.value)} value={goal}>
          {LEARNING_GOALS.map((option) => (
            <option key={option} value={option}>{LEARNING_GOAL_LABELS[option]}</option>
          ))}
        </select>
      </label>
      <label className="learning-dialog__field">
        任务备注
        <textarea
          disabled={Boolean(busy)}
          maxLength={4000}
          name="notes"
          onChange={(event) => setNotes(event.target.value)}
          placeholder="记录你希望达成的理解、要验证的问题或复习要点（最多 4000 字）。"
          value={notes}
        />
      </label>
      {preview && dirty ? (
        <p className="learning-dialog__note" role="note">任务已修改，需重新预览后才能确认。</p>
      ) : null}
      {notice ? <p className="learning-dialog__notice">{notice}</p> : null}
      {errorBlock}
      <div className="learning-dialog__actions">
        <button disabled={Boolean(busy)} onClick={close} type="button">关闭</button>
        <button disabled={Boolean(busy) || !workspace || !can("edit")} onClick={saveDraft} type="button">{busy === "edit" ? "保存中…" : "保存修改"}</button>
        <button className="learning-dialog__primary" disabled={Boolean(busy) || !workspace || !can("preview")} onClick={openPreview} type="button">{busy === "preview" ? "预览中…" : "预览确认"}</button>
      </div>
    </>
  );

  const previewing = (
    <>
      <dl className="learning-dialog__preview">
        <div>
          <dt>来源仓库</dt>
          <dd><a href={preview?.sourceUrl} rel="noopener noreferrer" target="_blank">{preview?.fullName ?? workspace?.fullName}</a></dd>
        </div>
        <div>
          <dt>固定 commit</dt>
          <dd className="learning-dialog__sha">{preview?.sourceCommitSha ?? workspace?.sourceCommitSha}</dd>
        </div>
        <div>
          <dt>学习目标</dt>
          <dd>{LEARNING_GOAL_LABELS[preview?.mission?.goal ?? goal]}</dd>
        </div>
        <div>
          <dt>任务备注</dt>
          <dd className="learning-dialog__notes">{preview?.mission?.notes ?? notes}</dd>
        </div>
      </dl>
      <p className="learning-dialog__hint">确认后根据活跃上限进入学习或队列；预览内容与固定版本一致。</p>
      {errorBlock}
      <div className="learning-dialog__actions">
        <button disabled={Boolean(busy)} onClick={() => setPhase("editing")} type="button">返回编辑</button>
        <button className="learning-dialog__primary" disabled={Boolean(busy) || previewStale || !can("confirm")} onClick={confirmJoin} type="button">
          {busy === "confirm" ? "确认中…" : "确认加入学习"}
        </button>
      </div>
    </>
  );

  const confirmed = outcome ? (
    <>
      <p className="learning-dialog__result">{OUTCOME_COPY[outcome.confirmed] ?? "已加入学习"}</p>
      <dl className="learning-dialog__preview">
        <div>
          <dt>原始确认结果</dt>
          <dd>{OUTCOME_COPY[outcome.confirmed] ?? outcome.confirmed}</dd>
        </div>
        <div>
          <dt>当前状态</dt>
          <dd>{STATE_COPY[outcome.workspace?.state] ?? outcome.workspace?.state}</dd>
        </div>
        <div>
          <dt>来源仓库</dt>
          <dd><a href={outcome.workspace?.sourceUrl} rel="noopener noreferrer" target="_blank">{outcome.workspace?.fullName}</a></dd>
        </div>
        <div>
          <dt>固定 commit</dt>
          <dd className="learning-dialog__sha">{outcome.workspace?.sourceCommitSha}</dd>
        </div>
      </dl>
      <div className="learning-dialog__actions">
        <button onClick={onClose} type="button">关闭</button>
        <button className="learning-dialog__primary" onClick={() => onOpenWorkspace?.(outcome.workspace?.workspaceId)} type="button">查看工作区</button>
      </div>
    </>
  ) : null;

  return (
    <div className="learning-dialog-wrapper" role="presentation">
      <div aria-label="学习任务" aria-modal="true" className="learning-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
        <header className="learning-dialog__head">
          <h2>{existingWorkspace ? "编辑学习任务" : "加入学习"}</h2>
          <button aria-label="关闭" className="learning-dialog__close" disabled={Boolean(busy)} onClick={close} type="button">×</button>
        </header>
        {phase === "creating" ? (
          <div className="learning-dialog__loading">
            <p>正在创建工作区…</p>
            {errorBlock}
          </div>
        ) : null}
        {phase === "editing" ? editing : null}
        {phase === "previewing" ? previewing : null}
        {phase === "confirmed" ? confirmed : null}
      </div>
    </div>
  );
}