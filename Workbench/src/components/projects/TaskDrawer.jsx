import { useEffect, useMemo, useState } from "react";
import { IconArchive, IconExternalLink, IconLink, IconSearch, IconTrash, IconX } from "@tabler/icons-react";
import { searchVault } from "../../lib/api.js";
import { TaskActivity } from "./TaskActivity.jsx";

const blank = { title: "", description: "", priority: "medium", startDate: "", dueDate: "" };

export function TaskDrawer({ task, projectKey, labels = [], taskLabels = [], links = [], activities = [], onClose, onSave, onArchive, onSetLabels, onCreateLabel, onAddLink, onRemoveLink, onOpenDocument }) {
  const [form, setForm] = useState(blank);
  const [selectedLabels, setSelectedLabels] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [newLabel, setNewLabel] = useState({ name: "", color: "#4a8c78" });
  useEffect(() => {
    setForm(task ? { title: task.title || "", description: task.description || "", priority: task.priority || "medium", startDate: task.startDate || "", dueDate: task.dueDate || "" } : blank);
    setSelectedLabels(task ? taskLabels.filter((item) => item.taskId === task.id).map((item) => item.labelId) : []);
    setError(""); setQuery(""); setResults([]); setNewLabel({ name: "", color: "#4a8c78" });
  }, [task?.id]);
  useEffect(() => {
    if (!query.trim()) { setResults([]); return undefined; }
    let active = true;
    const timer = setTimeout(async () => {
      setSearching(true);
      try { const response = await searchVault(query.trim()); if (response.error) throw response.error; if (active) setResults((response.data?.items || []).slice(0, 20)); }
      catch (searchError) { if (active) setError(searchError.message); }
      finally { if (active) setSearching(false); }
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  const taskLinks = useMemo(() => links.filter((link) => link.taskId === task?.id), [links, task?.id]);
  if (!task) return null;
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault(); setError("");
    if (!form.title.trim()) { setError("任务标题不能为空。"); return; }
    if (form.startDate && form.dueDate && form.startDate > form.dueDate) { setError("开始日期不能晚于截止日期。"); return; }
    setSaving(true);
    try { const saved = await onSave({ ...form, title: form.title.trim() }); if (saved?.id) await onSetLabels?.(saved.id, selectedLabels); else if (task.id) await onSetLabels?.(task.id, selectedLabels); }
    catch (saveError) { setError(saveError.message); }
    finally { setSaving(false); }
  };
  const createCurrentLabel = async () => {
    if (!newLabel.name.trim()) { setError("标签名称不能为空。"); return; }
    setError("");
    try {
      const result = await onCreateLabel({ ...newLabel, name: newLabel.name.trim() });
      if (result?.label?.id) setSelectedLabels((current) => [...new Set([...current, result.label.id])]);
      setNewLabel({ name: "", color: "#4a8c78" });
    } catch (labelError) { setError(labelError.message); }
  };
  return <div className="task-drawer__backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside aria-label={task.id ? `任务 ${projectKey}-${task.number}` : "新建任务"} className="task-drawer" role="dialog" aria-modal="true">
    <header><div><span>{task.id ? `${projectKey}-${task.number}` : "新任务"}</span><h2>{task.id ? task.title : "新建任务"}</h2></div><button aria-label="关闭任务" onClick={onClose} type="button"><IconX /></button></header>
    <form onSubmit={submit}><label>标题<input autoFocus maxLength={240} onChange={set("title")} value={form.title} /></label><label>描述<textarea onChange={set("description")} rows="6" value={form.description} /></label><div className="task-form__row"><label>优先级<select onChange={set("priority")} value={form.priority}><option value="urgent">紧急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option><option value="none">无</option></select></label><label>开始日期<input onChange={set("startDate")} type="date" value={form.startDate} /></label><label>截止日期<input onChange={set("dueDate")} type="date" value={form.dueDate} /></label></div>
      {task.id ? <fieldset className="task-label-fieldset"><legend>标签</legend>{labels.length ? <div className="task-labels">{labels.map((label) => <label key={label.id}><input checked={selectedLabels.includes(label.id)} onChange={() => setSelectedLabels((current) => current.includes(label.id) ? current.filter((id) => id !== label.id) : [...current, label.id])} type="checkbox" /><span style={{ "--label-color": label.color }}>{label.name}</span></label>)}</div> : <p className="task-labels__empty">暂无标签，可在下方创建。</p>}<div className="task-label-create"><input aria-label="新标签名称" maxLength={60} onChange={(event) => setNewLabel((current) => ({ ...current, name: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createCurrentLabel(); } }} placeholder="新标签名称" value={newLabel.name} /><input aria-label="标签颜色" onChange={(event) => setNewLabel((current) => ({ ...current, color: event.target.value }))} type="color" value={newLabel.color} /><button className="project-button" onClick={createCurrentLabel} type="button">新建标签</button></div></fieldset> : <p className="task-labels__empty">保存任务后可以添加标签。</p>}
      {error ? <div className="project-error" role="alert">{error}</div> : null}<div className="task-form__actions"><button className="project-button project-button--primary" disabled={saving} type="submit">{saving ? "正在保存" : "保存任务"}</button>{task.id ? <button className="project-button project-button--danger" onClick={() => { if (window.confirm("确定归档这个任务吗？")) onArchive(); }} type="button"><IconArchive />归档任务</button> : null}</div>
    </form>
    {task.id ? <section className="task-links"><h3>关联文档</h3><label className="project-search"><IconSearch /><input onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Vault 文档" value={query} /></label>{searching ? <p>正在搜索…</p> : null}{results.length ? <ul className="task-link-results">{results.map((document) => <li key={document.id || document.relativePath}><button onClick={async () => { await onAddLink(document.id || document.relativePath); setQuery(""); setResults([]); }} type="button"><IconLink />{document.title || document.relativePath}</button></li>)}</ul> : null}<ul className="task-linked-documents">{taskLinks.map((link) => <li key={link.id}>{link.missing ? <><span>文档已移动或删除</span><button aria-label="移除失效关联" onClick={() => onRemoveLink(link.id)} type="button"><IconTrash /></button></> : <><button onClick={() => onOpenDocument({ id: link.documentId, relativePath: link.relativePath })} type="button"><IconExternalLink />{link.title || link.relativePath}</button><button aria-label={`移除 ${link.relativePath}`} onClick={() => onRemoveLink(link.id)} type="button"><IconTrash /></button></>}</li>)}</ul></section> : null}
    {task.id ? <TaskActivity activities={activities.filter((activity) => activity.taskId === task.id)} /> : null}
  </aside></div>;
}
