import { useCallback, useEffect, useRef, useState } from "react";
import { planDraftFromSummary } from "../../lib/learning-plan.js";

// Editable learning content (plan / notes / artifacts) of one learning
// workspace. The page passes wire functions across the component seam, so the
// interaction states — save in flight, success, failure, retry, revision
// conflict, read-only viewing, summary-derived draft — are all testable by
// driving those functions directly. Content writes never touch the workspace
// state machine and never offer an Obsidian write path.

const EMPTY_PLAN = Object.freeze({ learningGoal: "", expectedOutcome: "", milestones: [], currentMilestone: null });

function emptyPlan() {
  return { ...EMPTY_PLAN, milestones: [] };
}

function nextMilestoneId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `milestone-${crypto.randomUUID()}`;
  }
  return `milestone-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function failMessage(error, fallback) {
  const message = error?.message;
  return typeof message === "string" && message.trim() ? message.trim() : fallback;
}

export function LearningContentEditor({
  workspace,
  readOnly = false,
  onLoadContent,
  onLoadSummary,
  onSavePlan,
  onSaveNotes,
  onAddArtifact,
}) {
  const workspaceId = workspace?.workspaceId ?? null;
  const [record, setRecord] = useState(null);
  const [revision, setRevision] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [planForm, setPlanForm] = useState(emptyPlan);
  const [noteText, setNoteText] = useState("");
  const [artifactForm, setArtifactForm] = useState({ type: "笔记", title: "", markdownText: "" });
  const [planSave, setPlanSave] = useState({ busy: false, error: null, saved: false });
  const [noteSave, setNoteSave] = useState({ busy: false, error: null, saved: false });
  const [artifactSave, setArtifactSave] = useState({ busy: false, error: null, saved: false });
  const [summaryState, setSummaryState] = useState({ busy: false, notice: null });
  const [notice, setNotice] = useState(null);
  // Synchronous gate so two clicks in one tick can never double-submit.
  const busyRef = useRef({ plan: false, note: false, artifact: false });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await onLoadContent();
      const content = result?.content ?? null;
      setRecord(content);
      setRevision(content?.revision ?? null);
      setPlanForm(content?.learningPlan ? structuredClone(content.learningPlan) : emptyPlan());
      setNoteText(content?.notes?.markdownText ?? "");
      setNotice(null);
    } catch (error) {
      setLoadError(failMessage(error, "学习内容加载失败。"));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, onLoadContent]);

  useEffect(() => { void load(); }, [load]);

  // On a revision conflict the server already moved on: refresh ONLY the
  // version and the server-owned artifact list. The user's in-progress plan
  // and note text stay untouched so nothing they typed is lost.
  const refreshLatest = useCallback(async () => {
    const result = await onLoadContent();
    const content = result?.content ?? null;
    if (content) {
      setRecord(content);
      setRevision(content.revision);
    }
    return content;
  }, [workspaceId, onLoadContent]);

  const savePlan = useCallback(async () => {
    if (readOnly || busyRef.current.plan) return;
    busyRef.current.plan = true;
    setPlanSave({ busy: true, error: null, saved: false });
    setNotice(null);
    try {
      const result = await onSavePlan(revision, structuredClone(planForm));
      setRecord(result?.content ?? null);
      setRevision(result?.content?.revision ?? null);
      setPlanSave({ busy: false, error: null, saved: true });
    } catch (error) {
      if (error?.code === "REVISION_CONFLICT") {
        try { await refreshLatest(); } catch { /* Keep the current revision; retry will re-check. */ }
        setNotice("内容已被其他窗口或标签页更新，已载入最新版本号；你未保存的输入已保留，请检查后重试。");
        setPlanSave({ busy: false, error: "保存冲突：内容已被其他窗口更新。请检查你的输入后重试。", saved: false });
      } else {
        setPlanSave({ busy: false, error: failMessage(error, "计划保存失败，请重试。"), saved: false });
      }
    } finally {
      busyRef.current.plan = false;
    }
  }, [readOnly, revision, planForm, onSavePlan, refreshLatest]);

  const saveNotes = useCallback(async () => {
    if (readOnly || busyRef.current.note) return;
    busyRef.current.note = true;
    setNoteSave({ busy: true, error: null, saved: false });
    setNotice(null);
    try {
      const result = await onSaveNotes(revision, noteText);
      setRecord(result?.content ?? null);
      setRevision(result?.content?.revision ?? null);
      setNoteSave({ busy: false, error: null, saved: true });
    } catch (error) {
      if (error?.code === "REVISION_CONFLICT") {
        try { await refreshLatest(); } catch { /* Keep the current revision. */ }
        setNotice("内容已被其他窗口或标签页更新，已载入最新版本号；你未保存的输入已保留，请检查后重试。");
        setNoteSave({ busy: false, error: "保存冲突：内容已被其他窗口更新。请检查你的输入后重试。", saved: false });
      } else {
        setNoteSave({ busy: false, error: failMessage(error, "笔记保存失败，请重试。"), saved: false });
      }
    } finally {
      busyRef.current.note = false;
    }
  }, [readOnly, revision, noteText, onSaveNotes, refreshLatest]);

  const addArtifact = useCallback(async () => {
    if (readOnly || busyRef.current.artifact) return;
    busyRef.current.artifact = true;
    setArtifactSave({ busy: true, error: null, saved: false });
    setNotice(null);
    try {
      const result = await onAddArtifact(revision, structuredClone(artifactForm));
      setRecord(result?.content ?? null);
      setRevision(result?.content?.revision ?? null);
      setArtifactForm({ type: "笔记", title: "", markdownText: "" });
      setArtifactSave({ busy: false, error: null, saved: true });
    } catch (error) {
      if (error?.code === "REVISION_CONFLICT") {
        try { await refreshLatest(); } catch { /* Keep the current revision. */ }
        setNotice("内容已被其他窗口或标签页更新，已载入最新版本号；你未保存的输入已保留，请检查后重试。");
        setArtifactSave({ busy: false, error: "保存冲突：内容已被其他窗口更新。请检查你的输入后重试。", saved: false });
      } else {
        setArtifactSave({ busy: false, error: failMessage(error, "产出添加失败，请重试。"), saved: false });
      }
    } finally {
      busyRef.current.artifact = false;
    }
  }, [readOnly, revision, artifactForm, onAddArtifact, refreshLatest]);

  const createDraftFromSummary = useCallback(async () => {
    if (readOnly || summaryState.busy) return;
    setSummaryState({ busy: true, notice: null });
    try {
      const result = await onLoadSummary(workspace?.repositoryId, workspace?.sourceCommitSha);
      const draft = planDraftFromSummary(result?.summary ?? null);
      if (!draft) {
        setSummaryState({ busy: false, notice: "该仓库还没有这个固定版本的摘要，无法从摘要创建计划；仍可手工填写学习目标。" });
        return;
      }
      setPlanForm(draft);
      setSummaryState({ busy: false, notice: "已从摘要创建可编辑计划草案，请确认（并可按需修改）后保存。" });
    } catch (error) {
      setSummaryState({ busy: false, notice: failMessage(error, "读取摘要失败，请稍后重试。") });
    }
  }, [readOnly, summaryState.busy, onLoadSummary, workspace?.repositoryId, workspace?.sourceCommitSha]);

  const updateMilestone = (milestoneId, patch) => {
    setPlanForm((current) => ({
      ...current,
      milestones: current.milestones.map((milestone) => (milestone.milestoneId === milestoneId ? { ...milestone, ...patch } : milestone)),
    }));
  };
  const addMilestone = () => {
    setPlanForm((current) => ({
      ...current,
      milestones: [...current.milestones, { milestoneId: nextMilestoneId(), title: "", done: false }],
    }));
  };
  const removeMilestone = (milestoneId) => {
    setPlanForm((current) => ({
      ...current,
      milestones: current.milestones.filter((milestone) => milestone.milestoneId !== milestoneId),
      currentMilestone: current.currentMilestone === milestoneId ? null : current.currentMilestone,
    }));
  };

  const artifacts = record?.artifacts ?? [];
  if (loading) return <p className="learning-empty">正在读取学习内容…</p>;
  if (loadError) {
    return (
      <div className="learning-notice learning-notice--error" role="alert">
        <p>学习内容加载失败：{loadError}</p>
        <button onClick={() => void load()} type="button">重试</button>
      </div>
    );
  }

  return (
    <div className="learning-content">
      {notice ? (
        <div className="learning-notice learning-notice--error" role="status">
          <p>{notice}</p>
        </div>
      ) : null}

      <section aria-label="学习计划" className="learning-content-block">
        <h3>学习计划<span className="learning-content--muted">版本 {revision ?? "—"}</span></h3>
        {!readOnly ? (
          <button disabled={summaryState.busy} onClick={createDraftFromSummary} type="button">
            {summaryState.busy ? "读取摘要中…" : "从摘要创建计划"}
          </button>
        ) : null}
        {summaryState.notice ? <p className="learning-content-hint" role="status">{summaryState.notice}</p> : null}
        <label className="learning-content-field">
          <span>学习目标</span>
          <textarea disabled={readOnly} name="learningGoal" onChange={(event) => setPlanForm((current) => ({ ...current, learningGoal: event.target.value }))} placeholder="例如：理解该仓库的架构设计与关键取舍" rows={4} value={planForm.learningGoal} />
        </label>
        <label className="learning-content-field">
          <span>预期成果</span>
          <textarea disabled={readOnly} name="expectedOutcome" onChange={(event) => setPlanForm((current) => ({ ...current, expectedOutcome: event.target.value }))} placeholder="完成后你能够说明什么、交付什么" rows={3} value={planForm.expectedOutcome} />
        </label>
        <div className="learning-milestones">
          <h4>里程碑</h4>
          {planForm.milestones.length === 0 ? <p className="learning-content--muted">尚无里程碑。</p> : null}
          {planForm.milestones.map((milestone) => (
            <div className="learning-milestone" key={milestone.milestoneId}>
              <input
                checked={milestone.done}
                disabled={readOnly}
                name="milestone-done"
                onChange={(event) => updateMilestone(milestone.milestoneId, { done: event.target.checked })}
                type="checkbox"
              />
              <input
                disabled={readOnly}
                name="milestone"
                onChange={(event) => updateMilestone(milestone.milestoneId, { title: event.target.value })}
                placeholder="里程碑内容"
                type="text"
                value={milestone.title}
              />
              {!readOnly ? (
                <button onClick={() => removeMilestone(milestone.milestoneId)} type="button">移除里程碑</button>
              ) : null}
            </div>
          ))}
          {!readOnly ? <button onClick={addMilestone} type="button">添加里程碑</button> : null}
        </div>
        <label className="learning-content-field">
          <span>当前里程碑</span>
          <select
            disabled={readOnly}
            name="currentMilestone"
            onChange={(event) => setPlanForm((current) => ({ ...current, currentMilestone: event.target.value || null }))}
            value={planForm.currentMilestone ?? ""}
          >
            <option value="">（未选择）</option>
            {planForm.milestones.map((milestone) => (
              <option key={milestone.milestoneId} value={milestone.milestoneId}>{milestone.title || milestone.milestoneId}</option>
            ))}
          </select>
        </label>
        {!readOnly ? (
          <div className="learning-content-save">
            <button disabled={planSave.busy} onClick={savePlan} type="button">{planSave.busy ? "保存中…" : "保存计划"}</button>
            {planSave.busy ? (
              <p className="learning-content-ok" role="status">保存中…</p>
            ) : planSave.error ? (
              <>
                <p className="learning-content-error" role="alert">{planSave.error}</p>
                <button className="learning-content-retry" onClick={savePlan} type="button">重试保存计划</button>
              </>
            ) : planSave.saved ? (
              <p className="learning-content-ok" role="status">计划已保存。</p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-label="学习笔记" className="learning-content-block">
        <h3>学习笔记（Markdown）</h3>
        <textarea
          className="learning-content-notes"
          disabled={readOnly}
          name="notesText"
          onChange={(event) => setNoteText(event.target.value)}
          placeholder="记录学习笔记 (Markdown)…"
          rows={10}
          value={noteText}
        />
        {!readOnly ? (
          <div className="learning-content-save">
            <button disabled={noteSave.busy} onClick={saveNotes} type="button">{noteSave.busy ? "保存中…" : "保存笔记"}</button>
            {noteSave.busy ? (
              <p className="learning-content-ok" role="status">保存中…</p>
            ) : noteSave.error ? (
              <>
                <p className="learning-content-error" role="alert">{noteSave.error}</p>
                <button className="learning-content-retry" onClick={saveNotes} type="button">重试保存笔记</button>
              </>
            ) : noteSave.saved ? (
              <p className="learning-content-ok" role="status">笔记已保存。</p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-label="学习产出" className="learning-content-block">
        <h3>学习产出</h3>
        {artifacts.length === 0 ? <p className="learning-content--muted">暂无学习产出。</p> : null}
        <ul className="learning-artifacts">
          {artifacts.map((item) => (
            <li key={item.artifactId}>
              <h4>{item.title}<span className="learning-artifact-type">{item.type}</span></h4>
              <p>{item.markdownText}</p>
              <p className="learning-content--muted">创建 {item.createdAt ?? "—"} · 更新 {item.updatedAt ?? "—"}</p>
            </li>
          ))}
        </ul>
        {!readOnly ? (
          <div className="learning-artifact-form">
            <label className="learning-content-field">
              <span>类型</span>
              <input name="artifactType" onChange={(event) => setArtifactForm((current) => ({ ...current, type: event.target.value }))} placeholder="例如：笔记 / 实验计划 / 总结" value={artifactForm.type} />
            </label>
            <label className="learning-content-field">
              <span>标题</span>
              <input name="artifactTitle" onChange={(event) => setArtifactForm((current) => ({ ...current, title: event.target.value }))} placeholder="产出标题" value={artifactForm.title} />
            </label>
            <label className="learning-content-field">
              <span>正文（Markdown）</span>
              <textarea name="artifactMarkdown" onChange={(event) => setArtifactForm((current) => ({ ...current, markdownText: event.target.value }))} placeholder="产出正文 (Markdown)…" rows={4} value={artifactForm.markdownText} />
            </label>
            <div className="learning-content-save">
              <button disabled={artifactSave.busy} onClick={addArtifact} type="button">{artifactSave.busy ? "添加中…" : "添加产出"}</button>
              {artifactSave.busy ? (
                <p className="learning-content-ok" role="status">添加中…</p>
              ) : artifactSave.error ? (
                <>
                  <p className="learning-content-error" role="alert">{artifactSave.error}</p>
                  <button className="learning-content-retry" onClick={addArtifact} type="button">重试添加产出</button>
                </>
              ) : artifactSave.saved ? (
                <p className="learning-content-ok" role="status">产出已添加。</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}