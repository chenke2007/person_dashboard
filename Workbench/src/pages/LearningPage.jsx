import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { LearningDraftDialog } from "../components/learning/LearningDraftDialog";
import {
  activateLearning,
  archiveLearning,
  loadLearningCapabilities,
  loadLearningWorkspace,
  loadLearningWorkspaces,
} from "../lib/learning-api.js";
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

function WorkspaceRow({ workspace, canMutate, busy, onActivate, onArchive, onEdit, onOpenDetail }) {
  const goalLabel = LEARNING_GOAL_LABELS[workspace.goal] ?? workspace.goal;
  const activateBusy = busy?.activate?.has(workspace.workspaceId);
  const archiveBusy = busy?.archive?.has(workspace.workspaceId);
  const activateError = workspace.state === "queued" ? busy?.activateError?.[workspace.workspaceId] ?? null : null;
  const archiveError = busy?.archiveError?.[workspace.workspaceId] ?? null;
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
        {canMutate && workspace.state === "draft" ? (
          <button disabled={activateBusy || archiveBusy} onClick={() => onEdit(workspace)} type="button">编辑任务</button>
        ) : null}
        {canMutate && workspace.state === "queued" ? (
          <button disabled={activateBusy || archiveBusy} onClick={() => onActivate(workspace)} type="button">
            {activateBusy ? "激活中…" : "激活"}
          </button>
        ) : null}
        {canMutate && workspace.state !== "archived" ? (
          <button disabled={activateBusy || archiveBusy || workspace.state === "queued" && activateBusy} onClick={() => onArchive(workspace)} type="button">
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
  const loadedDetailId = useRef(null);

  const canMutate = caps?.create === true;

  const loadCaps = useCallback(() => {
    loadLearningCapabilities()
      .then((body) => { setCaps(body?.capabilities ?? null); setCapsError(null); })
      .catch((error) => setCapsError(failMessage(error, "无法读取学习权限信息")));
  }, []);

  const loadList = useCallback(async () => {
    try {
      const body = await loadLearningWorkspaces({ includeArchived: true });
      setList(projectLearningList(body));
      setRawList(Array.isArray(body?.workspaces) ? body.workspaces : []);
      setListError(null);
      setListStale(false);
      setLoading(false);
    } catch (error) {
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
    if (!id) return;
    loadedDetailId.current = id;
    try {
      const body = await loadLearningWorkspace(id);
      if (loadedDetailId.current !== id) return; // superseded by a newer route
      setRawDetail(body?.workspace ?? null);
      setDetailFor(id);
      setDetailError(null);
    } catch (error) {
      if (loadedDetailId.current !== id) return;
      setDetailFor((current) => current);
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
    setBusy((b) => ({ ...b, activate: new Set([...(b.activate ?? []), workspace.workspaceId]) }));
    setBusy((b) => ({ ...b, activateError: { ...b.activateError, [workspace.workspaceId]: null } }));
    setNotice(null);
    try {
      const result = await activateLearning(workspace.workspaceId, workspace.draftRevision);
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
      setBusy((b) => ({ ...b, activateError: { ...b.activateError, [workspace.workspaceId]: failMessage(error, "激活失败，请重试。") } }));
    } finally {
      setBusy((b) => ({ ...b, activate: new Set([...(b.activate ?? [])].filter((id) => id !== workspace.workspaceId)) }));
    }
  }, [refreshAfterMutation]);

  const onArchive = useCallback(async (workspace) => {
    setBusy((b) => ({ ...b, archive: new Set([...(b.archive ?? []), workspace.workspaceId]) }));
    setBusy((b) => ({ ...b, archiveError: { ...b.archiveError, [workspace.workspaceId]: null } }));
    setNotice(null);
    try {
      await archiveLearning(workspace.workspaceId);
      setNotice({ level: "success", message: "学习任务已归档，来源与任务内容仍然保留。" });
      await refreshAfterMutation();
    } catch (error) {
      setBusy((b) => ({ ...b, archiveError: { ...b.archiveError, [workspace.workspaceId]: failMessage(error, "归档失败，请重试。") } }));
    } finally {
      setBusy((b) => ({ ...b, archive: new Set([...(b.archive ?? [])].filter((id) => id !== workspace.workspaceId)) }));
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
              {canMutate && projectedDetail.state === "draft" ? (
                <button className="learning-detail__primary" onClick={() => setEditingWorkspace(projectedDetail)} type="button">编辑任务</button>
              ) : null}
              {canMutate && projectedDetail.state === "queued" ? (
                <button className="learning-detail__primary" disabled={busy.activate?.has(projectedDetail.workspaceId)} onClick={() => onActivate(projectedDetail)} type="button">
                  {busy.activate?.has(projectedDetail.workspaceId) ? "激活中…" : "激活"}
                </button>
              ) : null}
              {canMutate && projectedDetail.state !== "archived" ? (
                <button onClick={() => onArchive(projectedDetail)} type="button">{archiveLabel(projectedDetail)}</button>
              ) : null}
            </div>
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
            readOnly={!canMutate}
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
                      canMutate={canMutate}
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
          readOnly={!canMutate}
          repository={editingRepository}
          workspace={rawList.find((current) => current.workspaceId === editingWorkspace.workspaceId) ?? editingWorkspace}
        />
      ) : null}
    </section>
  );
}