import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { IconArrowRight, IconBriefcase, IconPlus } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { archiveProject, createProject, loadProjects, restoreProject } from "../lib/project-api.js";
import "../components/projects/projects.css";

export function ProjectsView({ snapshot, onCreate, onArchive, onRestore, showArchived = false, onToggleArchived, creating = false }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const projects = snapshot?.projects || [];

  const submit = async (event) => {
    event.preventDefault();
    await onCreate({ name, key });
    setName("");
    setKey("");
    setShowForm(false);
  };

  return (
    <section className="projects-page page-shell">
      <PageHeader eyebrow="EXECUTION LAYER" title="项目" description="把知识库里的资料连接到可以推进、检查和完成的任务。" />
      <div className="projects-page__actions">
        <button className="project-button" onClick={onToggleArchived} type="button">{showArchived ? "隐藏归档" : "查看归档"}</button>
        <button className="project-button project-button--primary" onClick={() => setShowForm(true)} type="button"><IconPlus />创建项目</button>
      </div>
      {showForm ? (
        <form className="project-create" onSubmit={submit}>
          <label>项目名称<input autoFocus maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></label>
          <label>项目缩写<input maxLength={12} onChange={(event) => setKey(event.target.value.toUpperCase())} pattern="[A-Za-z][A-Za-z0-9-]+" required value={key} /></label>
          <div><button className="project-button project-button--primary" disabled={creating} type="submit">{creating ? "正在创建" : "确认创建"}</button><button className="project-button" onClick={() => setShowForm(false)} type="button">取消</button></div>
        </form>
      ) : null}
      {projects.length ? (
        <div className="project-grid">
          {projects.map((project) => {
            const metrics = snapshot.metrics?.[project.id] || {};
            const percent = Math.round((metrics.completion || 0) * 100);
            return (
              <article className={`project-card${project.archivedAt ? " is-archived" : ""}`} key={project.id}>
                <Link className="project-card__link" to={`/projects/${project.id}`}>
                <div className="project-card__key"><IconBriefcase /><span>{project.key}</span></div>
                <h2>{project.name}</h2><p>{project.description || "尚未填写项目说明"}</p>
                <div className="project-card__progress"><span style={{ width: `${percent}%` }} /></div>
                <footer><span>{percent}% 完成</span><span>{metrics.inProgressTasks || 0} 项进行中</span><span className={metrics.overdueTasks ? "is-danger" : ""}>{metrics.overdueTasks || 0} 项逾期</span><IconArrowRight /></footer>
                <div className="project-card__activity">{metrics.latestActivity ? `最近活动 ${new Date(metrics.latestActivity.createdAt).toLocaleString("zh-CN")}` : "暂无活动"}</div>
                </Link>
                <button className="project-card__archive" onClick={() => project.archivedAt ? onRestore(project.id) : onArchive(project.id)} type="button">{project.archivedAt ? "恢复项目" : "归档项目"}</button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="project-empty"><IconBriefcase /><h2>创建第一个项目</h2><p>项目把知识库里的资料连接到可以推进的任务。</p><button className="project-button project-button--primary" onClick={() => setShowForm(true)} type="button">创建第一个项目</button></div>
      )}
    </section>
  );
}

export function ProjectsPage() {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const refresh = () => loadProjects({ includeArchived: showArchived }).then(setSnapshot).catch(setError);
  useEffect(() => { void refresh(); }, [showArchived]);
  if (error) return <section className="projects-page page-shell"><PageHeader eyebrow="EXECUTION LAYER" title="项目" /><div className="project-error">{error.message}</div></section>;
  if (!snapshot) return <section className="projects-page page-shell"><PageHeader eyebrow="EXECUTION LAYER" title="项目" /><div className="project-loading">正在读取项目…</div></section>;
  return <ProjectsView creating={creating} onArchive={async (projectId) => { await archiveProject(projectId); await refresh(); }} onCreate={async (input) => { setCreating(true); try { await createProject(input); await refresh(); } finally { setCreating(false); } }} onRestore={async (projectId) => { await restoreProject(projectId); await refresh(); }} onToggleArchived={() => setShowArchived((value) => !value)} showArchived={showArchived} snapshot={snapshot} />;
}
