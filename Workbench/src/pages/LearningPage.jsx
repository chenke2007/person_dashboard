import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { LearningContentEditor } from "../components/learning/LearningContentEditor";
import { LearningDraftDialog } from "../components/learning/LearningDraftDialog";
import { LearningIngestionPanel } from "../components/learning/LearningIngestionPanel";
import {
  activateLearning,
  addLearningArtifact,
  archiveLearning,
  loadLearningCapabilities,
  loadLearningContent,
  loadLearningWorkspace,
  loadLearningWorkspaces,
  saveLearningNotes,
  saveLearningPlan,
} from "../lib/learning-api.js";
import { loadRepositorySummaryByCommit } from "../lib/summary-api.js";
import {
  LEARNING_GOAL_LABELS,
  LEARNING_STATE_LABELS,
  projectLearningList,
  projectLearningWorkspace,
} from "../lib/learning-model.js";
import "../components/learning/learning.css";

const SECTION_LABELS = {
  draft: "任务草稿",
  queued: "排队中",
  active: "学习中",
  archived: "已归档",
};

function failMessage(error, fallback) {
  const message = error?.message;
  return typeof message === "string" && message.trim() ? message.trim() : fallback;
}

function WorkspaceRow({ workspace, canEdit, canActivate, canArchive, busy, onActivate, onArchive, onEdit, onOpenDetail }) {
  const goalLabel = LEARNING_GOAL_LABELS[workspace.goal] ?? workspace.goal;
  const activateBusy = busy?.activate?.has(workspace.workspaceId);
  const archiveBusy = busy?.archive?.has(workspace.workspaceId);
  const activateError = workspace.state === "queued" ? busy?.activateError?.[workspace.workspaceId] ?? null : null;
  const archiveError = busy?.archiveError?.[workspace.workspaceId] ?? null;
  const rowBusy = activateBusy || archiveBusy;
  return (
    <li className="learning-item">
      <div className="learning-item__main">
        <p className="learning-item__name">
          <a href={workspace.sourceUrl} rel="noopener noreferrer" target="_blank">{workspace.fullName}</a>
          <span className={`learning-item__state learning-item__state--${workspace.state}`}>
            {LEARNING_STATE_LABELS[workspace.state] ?? workspace.state}
          </span>
        </p>
        <p className="learning-item__meta">目标：{goalLabel} · 固定 {workspace.sourceCommitSha?.slice(0, 12)}…</p>
      </div>
      <div className="learning-item__actions">
        {canEdit && workspace.state === "draft" ? (
          <button disabled={rowBusy} onClick={() => onEdit(workspace)} type="button">编辑任务</button>
        ) : null}
        {canActivate && workspace.state === "queued" ? (
          <button disabled={rowBusy} onClick={() => onActivate(workspace)} type="button">
            {activateBusy ? "激活中…" : "激活"}
          </button>
        ) : null}
        {canArchive && workspace.state !== "archived" ? (
          <button disabled={rowBusy} onClick={() => onArchive(workspace)} type="button">
            {archiveBusy ? "归档中…" : archiveLabel(workspace)}
          </button>
        ) : null}
        <button onClick={() => onOpenDetail(workspace.workspaceId)} type="button">详情</button>
      </div>
      {activateError ? <p className="learning-item__error" role="alert">{activateError}</p> : null}
      {archiveError ? <p className="learning-item__error" role="alert">{archiveError}</p> : null}
    </li>
  );
}

function archiveLabel(workspace) {
  return workspace.state === "queued" ? "归档（退出队列）" : "归档学习";
}

export function LearningPage() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const [caps, setCaps] = useState(null);
  const [capsError, setCapsError] = useState(null);
  const [list, setList] = useState(null);
  const [rawList, setRawList] = useState([]);
  const [listError, setListError] = useState(null);
  const [listStale, setListStale] = useState(false);
  const [loading, setLoading] = useState(true);
  // Detail state is keyed by the workspace id it was fetched for, so a failed
  // or pending switch never exposes the previous workspace's content.
  const [detailFor, setDetailFor] = useState(null);
  const [rawDetail, setRawDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [busy, setBusy] = useState({ activate: new Set(), archive: new Set(), activateError: {}, archiveError: {} });
  const [notice, setNotice] = useState(null);
  const [editingWorkspace, setEditingWorkspace] = useState(null);
  // Request-ordering and lifecycle guards. A route switch can leave several
  // GETs in flight for the same or different workspace ids; comparing ids is
  // not enough (A→B→A, or a refresh of the same id). Every load captures a
  // monotonic sequence number and applies only if it is still the latest, the
  // component is alive, and the route still targets that workspace.
  const detailSeqRef = useRef(0);
  const listSeqRef = useRef(0);
  const aliveRef = useRef(true);
  const workspaceIdRef = useRef(workspaceId);
  // `busyRef` is the synchronous source of truth for in-flight mutations: two
  // clicks in the same tick read it before any re-render can disable the
  // button, so the handler itself rejects duplicate submissions.
  const busyRef = useRef(busy);
  const updateBusy = useCallback((updater) => {
    const next = updater(busyRef.current);
    busyRef.current = next;
    setBusy(next);
  }, []);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);
  // StrictMode simulates an unmount/remount on mount; re-arm the alive marker
  // in the setup so only a real unmount leaves it false.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Each mutation is gated by its own server capability field; capability
  // failure (caps null or an error) keeps every mutation disabled.
  const canEdit = caps?.edit === true;
  const canActivate = caps?.activate === true;
  const canArchive = caps?.archive === true;

  const loadCaps = useCallback(() => {
    loadLearningCapabilities()
      .then((body) => { setCaps(body?.capabilities ?? null); setCapsError(null); })
      .catch((error) => {
        // A failed refresh must never keep advertising the previous writable
        // capabilities: stale caps would leave mutations enabled with no
        // fresh server confirmation. Null them so every gate stays false.
        setCaps(null);
        setCapsError(failMessage(error, "无法读取学习权限信息"));
      });
  }, []);

  const loadList = useCallback(async () => {
    const seq = ++listSeqRef.current;
    try {
      const body = await loadLearningWorkspaces({ includeArchived: true });
      if (!aliveRef.current || listSeqRef.current !== seq) return;
      setList(projectLearningList(body));
      setRawList(Array.isArray(body?.workspaces) ? body.workspaces : []);
      setListError(null);
      setListStale(false);
      setLoading(false);
    } catch (error) {
      if (!aliveRef.current || listSeqRef.current !== seq) return;
      // A refresh failure over displayed data keeps the last good list and only
      // marks it stale; a first load with no data is a fatal error.
      if (listRef.current) {
        setListError(failMessage(error, "学习列表刷新失败。"));
        setListStale(true);
      } else {
        setList(null);
        setListError(failMessage(error, "学习列表加载失败。"));
      }
      setLoading(false);
    }
  }, []);
  const listRef = useRef(list);
  useEffect(() => { listRef.current = list; }, [list]);

  const loadDetail = useCallback(async (id) => {
    if (!id || id !== workspaceIdRef.current) return;
    const seq = ++detailSeqRef.current;
    try {
      const body = await loadLearningWorkspace(id);
      if (!aliveRef.current || detailSeqRef.current !== seq || workspaceIdRef.current !== id) return;
      setRawDetail(body?.workspace ?? null);
      setDetailFor(id);
      setDetailError(null);
    } catch (error) {
      if (!aliveRef.current || detailSeqRef.current !== seq || workspaceIdRef.current !== id) return;
      setDetailError(failMessage(error, "学习任务详情加载失败。"));
    }
  }, []);

  useEffect(() => { void loadCaps(); }, [loadCaps]);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    if (workspaceId) void loadDetail(workspaceId);
    else { setDetailFor(null); setRawDetail(null); setDetailError(null); }
  }, [workspaceId, loadDetail]);

  const refreshAfterMutation = useCallback(async () => {
    await Promise.all([loadList(), workspaceId ? loadDetail(workspaceId) : Promise.resolve()]);
  }, [loadList, loadDetail, workspaceId]);

  const onActivate = useCallback(async (workspace) => {
    if (busyRef.current.activate?.has(workspace.workspaceId)) return;
    updateBusy((b) => ({
      ...b,
      activate: new Set([...(b.activate ?? []), workspace.workspaceId]),
      activateError: { ...b.activateError, [workspace.workspaceId]: null },
    }));
    setNotice(null);
    try {
      const result = await activateLearning(workspace.workspaceId, workspace.draftRevision);
      // If the user left this workspace while the request was pending, the
      // completion must not paint notices or refresh the OTHER workspace's view.
      if (!aliveRef.current || (workspaceIdRef.current && workspaceIdRef.current !== workspace.workspaceId)) return;
      if (result?.outcome === "ACTIVE_LIMIT_REACHED") {
        setNotice({ level: "error", message: "已达 3 个活跃学习项目上限；该任务仍在队列中，请先归档一个学习项目后再激活。" });
      } else if (result?.outcome === "already-active") {
        setNotice({ level: "success", message: "该任务已经处于学习中状态。" });
      } else {
        setNotice({ level: "success", message: "已激活，该任务进入学习中。" });
      }
      // The mutation already succeeded; a failed refresh must not be reported
      // as an action failure — old data stays visible and marked stale.
      await refreshAfterMutation();
    } catch (error) {
      if (error?.code === "REVISION_CONFLICT" && aliveRef.current) {
        // The stored revision is stale; a bare retry would replay the same dead
        // revision forever. Refresh first so the retry targets the latest one.
        if (workspaceIdRef.current === workspace.workspaceId) void loadDetail(workspace.workspaceId);
        else void loadList();
      }
      updateBusy((b) => ({
        ...b,
        activateError: { ...b.activateError, [workspace.workspaceId]: failMessage(error, "激活失败，请重试。") },
      }));
    } finally {
      updateBusy((b) => ({
        ...b,
        activate: new Set([...(b.activate ?? [])].filter((id) => id !== workspace.workspaceId)),
      }));
    }
  }, [refreshAfterMutation, loadDetail, loadList]);

const onArchive = useCallback(async (workspace) => {
    if (busyRef.current.archive?.has(workspace.workspaceId)) return;
    updateBusy((b) => ({
      ...b,
      archive: new Set([...(b.archive ?? []), workspace.workspaceId]),
      archiveError: { ...b.archiveError, [workspace.workspaceId]: null },
    }));
    setNotice(null);
    try {
      await archiveLearning(workspace.workspaceId);
      if (!aliveRef.current || (workspaceIdRef.current && workspaceIdRef.current !== workspace.workspaceId)) return;
      setNotice({ level: "success", message: "学习任务已归档，来源与任务内容仍然保留。" });
      await refreshAfterMutation();
    } catch (error) {
      updateBusy((b) => ({
        ...b,
        archiveError: { ...b.archiveError, [workspace.workspaceId]: failMessage(error, "归档失败，请重试。") },
      }));
    } finally {
      updateBusy((b) => ({
        ...b,
        archive: new Set([...(b.archive ?? [])].filter((id) => id !== workspace.workspaceId)),
      }));
    }
  }, [refreshAfterMutation]);

  const editingRepository = useMemo(() => {
    const base = editingWorkspace ?? rawDetail;
    if (!base) return null;
    return {
      repositoryId: base.repositoryId,
      fullName: base.fullName,
      htmlUrl: base.sourceUrl,
      description: null,
    };
  }, [editingWorkspace, rawDetail]);

  const isDetail = Boolean(workspaceId);
  const detailMatches = isDetail && detailFor === workspaceId;
  const projectedDetail = detailMatches && rawDetail ? projectLearningWorkspace(rawDetail) : null;
  const staleDetail = isDetail && Boolean(detailError) && detailMatches;
  const detailBusy = projectedDetail
    ? busy.activate?.has(projectedDetail.workspaceId) || busy.archive?.has(projectedDetail.workspaceId)
    : false;

  // Stable per-workspace wire functions for the content editor: identities are
  // keyed on the workspace id only, so editor effect guards never re-fire on
  // unrelated page re-renders.
  const contentHandlers = useMemo(() => {
    if (!isDetail || !projectedDetail) return null;
    const id = projectedDetail.workspaceId;
    return Object.freeze({
      loadContent: () => loadLearningContent(id),
      loadSummary: (repositoryId, sourceCommitSha) => loadRepositorySummaryByCommit(repositoryId, sourceCommitSha),
      savePlan: (revision, plan) => saveLearningPlan(id, revision, plan),
      saveNotes: (revision, text) => saveLearningNotes(id, revision, { markdownText: text }),
      addArtifact: (revision, artifact) => addLearningArtifact(id, revision, artifact),
    });
  }, [isDetail, projectedDetail?.workspaceId]);

  if (isDetail) {
    return (
      <section className="learning-page page-shell">
        <PageHeader eyebrow="LEARNING" title="学习任务工作区" description="独立学习工作区：本阶段支持任务草案、固定版本审核、学习/队列管理和归档，暂无课程、测验或完成学习能力。" />
        {capsError ? (
          <div className="learning-notice learning-notice--error" role="alert">
            <p>无法确认学习权限：{capsError}。已停用修改操作以保安全。</p>
            <button onClick={loadCaps} type="button">重试</button>
          </div>
        ) : null}
        {notice ? (
          <div className={`learning-notice learning-notice--${notice.level}`} role="status">
            <p>{notice.message}</p>
          </div>
        ) : null}
        {staleDetail ? (
          <div className="learning-notice learning-notice--error" role="alert">
            <p>详情刷新失败：{detailError}，正在显示上次成功数据。</p>
            <button onClick={() => void loadDetail(workspaceId)} type="button">重试</button>
          </div>
        ) : null}
        {!staleDetail && detailError && !detailMatches ? (
          <div className="learning-notice learning-notice--error" role="alert">
            <p>学习任务详情加载失败：{detailError}</p>
            <button onClick={() => void loadDetail(workspaceId)} type="button">重试</button>
          </div>
        ) : null}
        {!projectedDetail && !detailError ? <p className="learning-empty">正在读取学习任务…</p> : null}
        {projectedDetail ? (
          <>
            <dl className="learning-detail">
              <div>
                <dt>来源仓库</dt>
                <dd><a href={projectedDetail.sourceUrl} rel="noopener noreferrer" target="_blank">{projectedDetail.fullName}</a></dd>
              </div>
              <div>
                <dt>固定 commit</dt>
                <dd className="learning-sha">{projectedDetail.sourceCommitSha}</dd>
              </div>
              <div>
                <dt>学习目标</dt>
                <dd>{LEARNING_GOAL_LABELS[projectedDetail.goal] ?? projectedDetail.goal}</dd>
              </div>
              <div>
                <dt>任务备注</dt>
                <dd className="learning-detail__notes">{projectedDetail.notes || "（无备注）"}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd><span className={`learning-item__state learning-item__state--${projectedDetail.state}`}>{LEARNING_STATE_LABELS[projectedDetail.state] ?? projectedDetail.state}</span></dd>
              </div>
              <div>
                <dt>创建 / 更新时间</dt>
                <dd>{projectedDetail.createdAt ?? "—"} / {projectedDetail.updatedAt ?? "—"}</dd>
              </div>
            </dl>
            <div className="learning-detail__actions">
              <button onClick={() => navigate("/learning")} type="button">返回列表</button>
              {canEdit && projectedDetail.state === "draft" ? (
                <button className="learning-detail__primary" onClick={() => setEditingWorkspace(projectedDetail)} type="button">编辑任务</button>
              ) : null}
              {canActivate && projectedDetail.state === "queued" ? (
                <button className="learning-detail__primary" disabled={detailBusy} onClick={() => onActivate(projectedDetail)} type="button">
                  {busy.activate?.has(projectedDetail.workspaceId) ? "激活中…" : "激活"}
                </button>
              ) : null}
              {canArchive && projectedDetail.state !== "archived" ? (
                <button disabled={detailBusy} onClick={() => onArchive(projectedDetail)} type="button">{archiveLabel(projectedDetail)}</button>
              ) : null}
            </div>
            {busy.activateError?.[projectedDetail.workspaceId] ? (
              <div className="learning-notice learning-notice--error" role="alert">
                <p>激活失败：{busy.activateError[projectedDetail.workspaceId]}</p>
                <button disabled={detailBusy} onClick={() => onActivate(projectedDetail)} type="button">重试激活</button>
              </div>
            ) : null}
            {busy.archiveError?.[projectedDetail.workspaceId] ? (
              <div className="learning-notice learning-notice--error" role="alert">
                <p>归档失败：{busy.archiveError[projectedDetail.workspaceId]}</p>
                <button disabled={detailBusy} onClick={() => onArchive(projectedDetail)} type="button">重试归档</button>
              </div>
            ) : null}
            {contentHandlers ? (
              <LearningContentEditor
                onAddArtifact={contentHandlers.addArtifact}
                onLoadContent={contentHandlers.loadContent}
                onLoadSummary={contentHandlers.loadSummary}
                onSaveNotes={contentHandlers.saveNotes}
                onSavePlan={contentHandlers.savePlan}
                readOnly={!canEdit}
                workspace={{
                  workspaceId: projectedDetail.workspaceId,
                  repositoryId: projectedDetail.repositoryId,
                  sourceCommitSha: projectedDetail.sourceCommitSha,
                }}
              />
            ) : null}
            <LearningIngestionPanel
              caps={caps}
              readOnly={!canEdit}
              workspaceId={projectedDetail.workspaceId}
            />
          </>
        ) : null}
        {editingWorkspace && editingRepository ? (
          <LearningDraftDialog
            onClose={() => setEditingWorkspace(null)}
            onConfirmed={(workspace, outcome) => {
              setNotice({ level: "success", message: outcome === "queued" ? "已加入学习队列（当前有 3 个活跃项目）。" : "已加入学习。" });
              setEditingWorkspace(null);
              void refreshAfterMutation();
            }}
            onDraftSaved={() => void refreshAfterMutation()}
            onOpenWorkspace={(id) => navigate(`/learning/${id}`)}
            capabilities={caps}
            onRefreshWorkspace={(id) => loadLearningWorkspace(id).then((body) => body?.workspace)}
            readOnly={!canEdit}
            repository={editingRepository}
            workspace={rawDetail ?? editingWorkspace}
          />
        ) : null}
      </section>
    );
  }

  const groups = list?.groups ?? null;
  return (
    <section className="learning-page page-shell">
      <PageHeader eyebrow="LEARNING" title="学习任务" description="独立学习任务工作区：查看草案、学习、排队与已归档任务，管理学习目标与固定版本。本阶段暂无课程、测验或完成学习能力。" />
      {capsError ? (
        <div className="learning-notice learning-notice--error" role="alert">
          <p>无法确认学习权限：{capsError}。已停用修改操作以保安全。</p>
          <button onClick={loadCaps} type="button">重试</button>
        </div>
      ) : null}
      {notice ? (
        <div className={`learning-notice learning-notice--${notice.level}`} role="status">
          <p>{notice.message}</p>
        </div>
      ) : null}
      {listError && !list ? (
        <div className="learning-notice learning-notice--error" role="alert">
          <p>学习列表加载失败：{listError}</p>
          <button onClick={() => void loadList()} type="button">重试</button>
        </div>
      ) : null}
      {listError && list ? (
        <div className="learning-notice learning-notice--error" role="alert">
          <p>学习列表刷新失败：{listError}，正在显示上次成功数据。</p>
          <button onClick={() => void loadList()} type="button">重试</button>
        </div>
      ) : null}
      {listStale && list ? <p className="learning-stale">数据可能不是最新，上次成功读取后刷新失败。</p> : null}
      {!listError && loading && !list ? <div className="learning-empty">正在读取学习任务…</div> : null}
      {list?.anomaly ? (
        <div className="learning-notice learning-notice--error" role="alert">
          <p>服务端返回了超过 3 个活跃学习项目，已按原样完整展示，未截断。请检查本地数据。</p>
        </div>
      ) : null}
      {groups ? (
        <>
          {(["draft", "queued", "active", "archived"]).map((state) => {
            const items = groups[state] ?? [];
            if (!items.length) return null;
            return (
              <section aria-label={SECTION_LABELS[state]} className="learning-section" key={state}>
                <h2 className="learning-section__title">{SECTION_LABELS[state]}<span className="learning-section__count">{items.length}</span></h2>
                <ul className="learning-list">
                  {items.map((workspace) => (
                    <WorkspaceRow
                      busy={busy}
                      canActivate={canActivate}
                      canArchive={canArchive}
                      canEdit={canEdit}
                      key={workspace.workspaceId}
                      onActivate={onActivate}
                      onArchive={onArchive}
                      onEdit={(entry) => setEditingWorkspace(entry)}
                      onOpenDetail={(id) => navigate(`/learning/${id}`)}
                      workspace={workspace}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          {!rawList.length ? (
            <div className="learning-empty">
              <h3>尚无学习任务</h3>
              <p>从 AI 雷达卡片点击“加入学习”，创建任务草案并确认固定版本后，这里会出现独立学习工作区。</p>
            </div>
          ) : null}
        </>
      ) : null}
      {editingWorkspace && editingRepository ? (
        <LearningDraftDialog
          onClose={() => setEditingWorkspace(null)}
          onConfirmed={(workspace, outcome) => {
            setNotice({ level: "success", message: outcome === "queued" ? "已加入学习队列（当前有 3 个活跃项目）。" : "已加入学习。" });
            setEditingWorkspace(null);
            void refreshAfterMutation();
          }}
          onDraftSaved={() => void loadList()}
          onOpenWorkspace={(id) => navigate(`/learning/${id}`)}
          capabilities={caps}
          onRefreshWorkspace={(id) => loadLearningWorkspace(id).then((body) => body?.workspace)}
          readOnly={!canEdit}
          repository={editingRepository}
          workspace={rawList.find((current) => current.workspaceId === editingWorkspace.workspaceId) ?? editingWorkspace}
        />
      ) : null}
    </section>
  );
}