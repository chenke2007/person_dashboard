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
  onClose,
  onDraftSaved,
  onConfirmed,
  onOpenWorkspace,
}) {
  const repositoryId = repository?.repositoryId;
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

  useEffect(() => {
    if (!preview) return;
    const mission = preview.mission;
    const stale = Boolean(mission && (mission.goal !== goal || mission.notes !== notes));
    setPreviewStale(stale);
  }, [preview, goal, notes]);

  const dirty = Boolean(workspace) && (goal !== workspace.goal || notes !== workspace.notes);

  const createDraftNow = async () => {
    setBusy("create");
    setError(null);
    setFailedAction(null);
    setNotice(null);
    try {
      const result = await createLearningDraft(repositoryId, { goal, notes });
      const next = projectLearningWorkspace(result.workspace);
      setWorkspace(next);
      setGoal(next.goal);
      setNotes(next.notes);
      setPhase("editing");
      onDraftSaved?.(result.workspace);
    } catch (createError) {
      setError(messageOf(createError, "创建工作区失败，请重试。"));
      setFailedAction("create");
    } finally {
      setBusy(null);
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
    if (!workspace || readOnly) return;
    setBusy("edit");
    setError(null);
    setFailedAction(null);
    setNotice(null);
    try {
      const result = await editLearningDraft(workspace.workspaceId, workspace.draftRevision, { goal, notes });
      const next = projectLearningWorkspace(result.workspace);
      setWorkspace(next);
      setGoal(next.goal);
      setNotes(next.notes);
      setNotice("任务已保存。");
      onDraftSaved?.(result.workspace);
    } catch (editError) {
      setError(messageOf(editError, "保存失败，请重试。"));
      setFailedAction("edit");
    } finally {
      setBusy(null);
    }
  };

  const openPreview = async () => {
    if (!workspace || readOnly) return;
    setBusy("preview");
    setError(null);
    setFailedAction(null);
    setNotice(null);
    try {
      let current = workspace;
      if (goal !== workspace.goal || notes !== workspace.notes) {
        const saved = await editLearningDraft(workspace.workspaceId, workspace.draftRevision, { goal, notes });
        current = projectLearningWorkspace(saved.workspace);
        setWorkspace(current);
        setGoal(current.goal);
        setNotes(current.notes);
        onDraftSaved?.(saved.workspace);
      }
      const page = await previewLearningDraft(current.workspaceId);
      setPreview(page);
      setPreviewStale(false);
      setPhase("previewing");
    } catch (previewError) {
      setError(messageOf(previewError, "无法生成预览，请重试。"));
      setFailedAction("preview");
    } finally {
      setBusy(null);
    }
  };

  const confirmJoin = async () => {
    if (!preview || previewStale || readOnly) return;
    setBusy("confirm");
    setError(null);
    setFailedAction(null);
    setNotice(null);
    try {
      const result = await confirmLearning(preview.token);
      // `confirmed` is the original confirm outcome; `workspace.state` is the
      // current state and may differ after a later activate/archive.
      setOutcome({ confirmed: result.confirmed, workspace: result.workspace });
      setPhase("confirmed");
      onConfirmed?.(result.workspace, result.confirmed);
    } catch (confirmError) {
      setError("确认结果未收到，请重试（重复确认不会创建重复记录）。如仍失败请重新预览。");
      setFailedAction("confirm");
    } finally {
      setBusy(null);
    }
  };

  const retry = () => {
    if (failedAction === "create") void createDraftNow();
    else if (failedAction === "edit") void saveDraft();
    else if (failedAction === "preview") void openPreview();
    else if (failedAction === "confirm") void confirmJoin();
  };

  const close = () => {
    if (busy || readOnly) return;
    onClose?.();
  };

  const errorBlock = failedAction ? (
    <div className="learning-dialog__error" role="alert">
      <p>{error}</p>
      <button disabled={Boolean(busy)} onClick={retry} type="button">
        {failedAction === "create" ? "重试" : failedAction === "confirm" ? "重试确认" : "重试"}
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
        <button disabled={Boolean(busy) || !workspace} onClick={saveDraft} type="button">{busy === "edit" ? "保存中…" : "保存修改"}</button>
        <button className="learning-dialog__primary" disabled={Boolean(busy) || !workspace} onClick={openPreview} type="button">{busy === "preview" ? "预览中…" : "预览确认"}</button>
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
        <button className="learning-dialog__primary" disabled={Boolean(busy) || previewStale} onClick={confirmJoin} type="button">
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
      <div aria-label="学习任务" aria-modal="true" className="learning-dialog" role="dialog">
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