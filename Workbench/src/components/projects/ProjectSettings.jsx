import { useEffect, useState } from "react";
import { IconArrowDown, IconArrowUp, IconPlus, IconX } from "@tabler/icons-react";

export function ProjectSettings({ project, columns, onClose, onUpdateProject, onCreateColumn, onUpdateColumn, onReorderColumns }) {
  const [projectForm, setProjectForm] = useState({ name: "", description: "" });
  const [columnForms, setColumnForms] = useState({});
  const [newColumn, setNewColumn] = useState({ name: "", isFinal: false });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setProjectForm({ name: project.name, description: project.description || "" });
    setColumnForms(Object.fromEntries(columns.map((column) => [column.id, { name: column.name, isFinal: column.isFinal }])))
  }, [project.id, project.updatedAt, columns]);
  const run = async (operation) => { setSaving(true); setError(""); try { await operation(); } catch (operationError) { setError(operationError.message); } finally { setSaving(false); } };
  const move = (index, offset) => {
    const next = [...columns]; const [column] = next.splice(index, 1); next.splice(index + offset, 0, column);
    return run(() => onReorderColumns(next.map((item) => item.id)));
  };
  return <div className="task-drawer__backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside aria-label="项目设置" className="task-drawer project-settings" role="dialog" aria-modal="true"><header><div><span>{project.key}</span><h2>项目设置</h2></div><button aria-label="关闭项目设置" onClick={onClose} type="button"><IconX /></button></header>
    <form onSubmit={(event) => { event.preventDefault(); run(() => onUpdateProject(projectForm)); }}><h3>项目信息</h3><label>项目名称<input maxLength={120} onChange={(event) => setProjectForm((current) => ({ ...current, name: event.target.value }))} required value={projectForm.name} /></label><label>项目描述<textarea onChange={(event) => setProjectForm((current) => ({ ...current, description: event.target.value }))} rows="4" value={projectForm.description} /></label><button className="project-button project-button--primary" disabled={saving} type="submit">保存项目信息</button></form>
    <section className="project-settings__columns"><h3>状态列</h3>{columns.map((column, index) => { const form = columnForms[column.id] || column; return <div className="project-settings__column" key={column.id}><input aria-label={`${column.name}名称`} onChange={(event) => setColumnForms((current) => ({ ...current, [column.id]: { ...form, name: event.target.value } }))} value={form.name} /><label><input checked={form.isFinal} onChange={(event) => setColumnForms((current) => ({ ...current, [column.id]: { ...form, isFinal: event.target.checked } }))} type="checkbox" />最终状态</label><button aria-label={`${column.name}上移`} disabled={index === 0 || saving} onClick={() => move(index, -1)} type="button"><IconArrowUp />上移</button><button aria-label={`${column.name}下移`} disabled={index === columns.length - 1 || saving} onClick={() => move(index, 1)} type="button"><IconArrowDown />下移</button><button className="project-button" disabled={saving} onClick={() => run(() => onUpdateColumn(column.id, form))} type="button">保存</button></div>})}
      <form className="project-settings__new-column" onSubmit={(event) => { event.preventDefault(); run(async () => { await onCreateColumn(newColumn); setNewColumn({ name: "", isFinal: false }); }); }}><input maxLength={80} onChange={(event) => setNewColumn((current) => ({ ...current, name: event.target.value }))} placeholder="状态列名称" required value={newColumn.name} /><label><input checked={newColumn.isFinal} onChange={(event) => setNewColumn((current) => ({ ...current, isFinal: event.target.checked }))} type="checkbox" />最终状态</label><button className="project-button" disabled={saving} type="submit"><IconPlus />新增状态列</button></form>
    </section>{error ? <div className="project-error" role="alert">{error}</div> : null}
  </aside></div>;
}
