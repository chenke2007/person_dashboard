import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { IconArrowRight, IconBriefcase, IconPlus } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { createProject, loadProjects } from "../lib/project-api.js";
import "../components/projects/projects.css";

export function ProjectsView({ snapshot, onCreate, creating = false }) {
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
              <Link className="project-card" key={project.id} to={`/projects/${project.id}`}>
                <div className="project-card__key"><IconBriefcase /><span>{project.key}</span></div>
                <h2>{project.name}</h2><p>{project.description || "尚未填写项目说明"}</p>
                <div className="project-card__progress"><span style={{ width: `${percent}%` }} /></div>
                <footer><span>{percent}% 完成</span><span>{metrics.activeTasks || 0} 项任务</span><span className={metrics.overdueTasks ? "is-danger" : ""}>{metrics.overdueTasks || 0} 项逾期</span><IconArrowRight /></footer>
              </Link>
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
  const refresh = () => loadProjects().then(setSnapshot).catch(setError);
  useEffect(() => { void refresh(); }, []);
  if (error) return <section className="projects-page page-shell"><PageHeader eyebrow="EXECUTION LAYER" title="项目" /><div className="project-error">{error.message}</div></section>;
  if (!snapshot) return <section className="projects-page page-shell"><PageHeader eyebrow="EXECUTION LAYER" title="项目" /><div className="project-loading">正在读取项目…</div></section>;
  return <ProjectsView creating={creating} onCreate={async (input) => { setCreating(true); try { await createProject(input); await refresh(); } finally { setCreating(false); } }} snapshot={snapshot} />;
}
