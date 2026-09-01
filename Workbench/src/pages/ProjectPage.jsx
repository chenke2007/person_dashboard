import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DndContext, KeyboardSensor, PointerSensor, closestCorners, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconArrowLeft, IconPlus, IconSearch, IconSettings } from "@tabler/icons-react";
import { addTaskLink, archiveTask, createColumn, createLabel, createTask, loadProject, moveTask, removeTaskLink, reorderColumns, setTaskLabels, updateColumn, updateProject, updateTask } from "../lib/project-api.js";
import { backlogTasks, filterTasks } from "../lib/project-model.js";
import { TaskDrawer } from "../components/projects/TaskDrawer.jsx";
import { ProjectSettings } from "../components/projects/ProjectSettings.jsx";
import "../components/projects/projects.css";

function TaskCard({ task, projectKey, columns, onOpenTask, onMoveTask }) {
  const sortable = useSortable({ id: task.id, data: { task } });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return <article className={`task-card${sortable.isDragging ? " is-dragging" : ""}`} onClick={() => onOpenTask(task)} ref={sortable.setNodeRef} style={style} {...sortable.attributes} {...sortable.listeners}>
    <div className="task-card__meta"><span>{projectKey}-{task.number}</span><span className={`priority priority--${task.priority}`}>{task.priority}</span></div><h3>{task.title}</h3>
    <label className="task-move" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}><span className="sr-only">移动任务“{task.title}”</span><select aria-label={`移动任务“${task.title}”`} onChange={(event) => onMoveTask(task, event.target.value || null, 0)} value={task.columnId || ""}><option value="">Backlog</option>{columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
  </article>;
}

function BoardColumn({ column, snapshot, tasks, onOpenTask, onMoveTask }) {
  const droppable = useDroppable({ id: `column:${column.id}`, data: { columnId: column.id } });
  return <section className={`board-column${droppable.isOver ? " is-over" : ""}`} ref={droppable.setNodeRef}><header><span>{column.name}</span><b>{tasks.length}</b></header><SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}><div>{tasks.map((task) => <TaskCard columns={snapshot.columns} key={task.id} onMoveTask={onMoveTask} onOpenTask={onOpenTask} projectKey={snapshot.project.key} task={task} />)}</div></SortableContext></section>;
}

function Board({ snapshot, tasks, onOpenTask, onMoveTask }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const task = snapshot.tasks.find((item) => item.id === active.id);
    if (!task) return;
    const overTask = snapshot.tasks.find((item) => item.id === over.id);
    const columnId = overTask?.columnId ?? over.data.current?.columnId ?? null;
    const inTarget = tasks.filter((item) => item.columnId === columnId && item.id !== task.id);
    const index = overTask ? Math.max(0, inTarget.findIndex((item) => item.id === overTask.id)) : inTarget.length;
    onMoveTask(task, columnId, index);
  };
  return <DndContext collisionDetection={closestCorners} onDragEnd={onDragEnd} sensors={sensors}><div className="project-board">{snapshot.columns.map((column) => <BoardColumn column={column} key={column.id} onMoveTask={onMoveTask} onOpenTask={onOpenTask} snapshot={snapshot} tasks={tasks.filter((task) => task.columnId === column.id).sort((a, b) => a.position - b.position)} />)}</div></DndContext>;
}

function List({ snapshot, tasks, onOpenTask, onMoveTask }) {
  return <div className="project-list" role="table"><div className="project-list__head" role="row"><span>任务</span><span>状态</span><span>优先级</span><span>标签</span><span>开始日期</span><span>截止日期</span><span>移动到</span></div>{tasks.map((task) => {
    const labelIds = snapshot.taskLabels.filter((item) => item.taskId === task.id).map((item) => item.labelId);
    return <div className="project-list__row" key={task.id} role="row"><button className="project-list__title" onClick={() => onOpenTask(task)} type="button">{snapshot.project.key}-{task.number} · {task.title}</button><span>{snapshot.columns.find((column) => column.id === task.columnId)?.name || "Backlog"}</span><span>{task.priority}</span><span>{snapshot.labels.filter((label) => labelIds.includes(label.id)).map((label) => label.name).join("、") || "—"}</span><span>{task.startDate || "—"}</span><span>{task.dueDate || "—"}</span><label className="task-move"><span className="sr-only">移动任务“{task.title}”</span><select aria-label={`移动任务“${task.title}”`} onChange={(event) => onMoveTask(task, event.target.value || null, 0)} value={task.columnId || ""}><option value="">Backlog</option>{snapshot.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label></div>;
  })}</div>;
}

export function ProjectView({ snapshot, view, filters, onChangeView, onChangeFilters, onCreateTask, onOpenTask, onMoveTask, onOpenSettings }) {
  const labelFilterRef = useRef(null);
  const [labelFilterOpen, setLabelFilterOpen] = useState(false);
  const visible = filterTasks(snapshot.tasks, filters, snapshot);
  const projected = view === "backlog" ? backlogTasks({ tasks: visible }) : visible;
  const change = (field) => (event) => onChangeFilters({ ...filters, [field]: event.target.value ? [event.target.value] : [] });
  const toggleLabelFilter = (labelId) => onChangeFilters({ ...filters, labelIds: (filters.labelIds || []).includes(labelId) ? filters.labelIds.filter((id) => id !== labelId) : [...(filters.labelIds || []), labelId] });
  useEffect(() => {
    if (!labelFilterOpen) return undefined;
    const dismissOutside = (event) => { if (!labelFilterRef.current?.contains(event.target)) setLabelFilterOpen(false); };
    const dismissEscape = (event) => { if (event.key === "Escape") setLabelFilterOpen(false); };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => { document.removeEventListener("pointerdown", dismissOutside); document.removeEventListener("keydown", dismissEscape); };
  }, [labelFilterOpen]);
  return <section className="project-page page-shell"><Link className="project-back" to="/projects"><IconArrowLeft />所有项目</Link><header className="project-heading"><div><span>{snapshot.project.key}</span><h1>{snapshot.project.name}</h1><p>{snapshot.project.description || "尚未填写项目说明"}</p></div><div className="project-heading__actions"><button className="project-button" onClick={onOpenSettings} type="button"><IconSettings />项目设置</button><button className="project-button project-button--primary" onClick={onCreateTask} type="button"><IconPlus />新建任务</button></div></header>
    <div className="project-toolbar"><div className="project-tabs" role="tablist">{[["board", "看板"], ["list", "列表"], ["backlog", "Backlog"]].map(([id, label]) => <button aria-selected={view === id} key={id} onClick={() => onChangeView(id)} role="tab" type="button">{label}</button>)}</div><label className="project-search"><IconSearch /><span className="sr-only">筛选任务</span><input onChange={(event) => onChangeFilters({ ...filters, query: event.target.value })} placeholder="筛选任务" value={filters.query || ""} /></label></div>
    <div className="project-filters"><label>状态<select onChange={change("columnIds")} value={filters.columnIds?.[0] || ""}><option value="">全部</option><option value="backlog">Backlog</option>{snapshot.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label>优先级<select onChange={change("priorities")} value={filters.priorities?.[0] || ""}><option value="">全部</option><option value="urgent">紧急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label><div className="project-label-filter" ref={labelFilterRef}><span>标签</span><details onToggle={(event) => setLabelFilterOpen(event.currentTarget.open)} open={labelFilterOpen}><summary aria-label="标签筛选">{filters.labelIds?.length ? `已选 ${filters.labelIds.length} 个` : "全部"}</summary><div className="project-label-filter__panel"><div className="project-label-filter__options">{snapshot.labels.length ? snapshot.labels.map((label) => <label key={label.id}><input checked={(filters.labelIds || []).includes(label.id)} onChange={() => toggleLabelFilter(label.id)} type="checkbox" /><i style={{ background: label.color }} />{label.name}</label>) : <p>暂无标签</p>}</div><footer><button onClick={() => onChangeFilters({ ...filters, labelIds: [] })} type="button">清空</button><button onClick={() => setLabelFilterOpen(false)} type="button">完成</button></footer></div></details></div><label>截止从<input onChange={(event) => onChangeFilters({ ...filters, dueAfter: event.target.value })} type="date" value={filters.dueAfter || ""} /></label><label>截止至<input onChange={(event) => onChangeFilters({ ...filters, dueBefore: event.target.value })} type="date" value={filters.dueBefore || ""} /></label></div>
    {view === "board" ? <Board onMoveTask={onMoveTask} onOpenTask={onOpenTask} snapshot={snapshot} tasks={visible} /> : <List onMoveTask={onMoveTask} onOpenTask={onOpenTask} snapshot={snapshot} tasks={projected} />}
  </section>;
}

export function ProjectPage({ onOpenDocument }) {
  const { projectId } = useParams();
  const [snapshot, setSnapshot] = useState(null); const [error, setError] = useState(null); const [selectedTask, setSelectedTask] = useState(null); const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState(() => localStorage.getItem("workbench-project-view") || "board"); const [filters, setFilters] = useState({});
  const refresh = useCallback(async () => { const next = await loadProject(projectId); setSnapshot(next); setSelectedTask((current) => current?.id ? next.tasks.find((task) => task.id === current.id) || null : current); return next; }, [projectId]);
  useEffect(() => { refresh().catch(setError); }, [refresh]);
  const changeView = (next) => { setView(next); localStorage.setItem("workbench-project-view", next); };
  const move = async (task, columnId, index) => { const previous = snapshot; setError(null); try { setSnapshot(await moveTask(task.id, { columnId, index, revision: snapshot.revision })); } catch (moveError) { setSnapshot(previous); setError(moveError); await refresh().catch(() => {}); } };
  const save = async (patch) => { setError(null); const result = selectedTask.id ? await updateTask(selectedTask.id, patch) : await createTask(projectId, patch); await refresh(); if (!selectedTask.id) setSelectedTask(result.task); return result.task; };
  const mutateAndRefresh = async (operation) => { setError(null); try { const result = await operation(); await refresh(); return result; } catch (mutationError) { setError(mutationError); throw mutationError; } };
  if (error && !snapshot) return <section className="project-page page-shell"><div className="project-error">{error.message}</div></section>;
  if (!snapshot) return <section className="project-page page-shell"><div className="project-loading">正在读取项目…</div></section>;
  return <><ProjectView filters={filters} onChangeFilters={setFilters} onChangeView={changeView} onCreateTask={() => setSelectedTask({ id: null, title: "", description: "", priority: "medium", startDate: "", dueDate: "" })} onMoveTask={move} onOpenSettings={() => setSettingsOpen(true)} onOpenTask={setSelectedTask} snapshot={snapshot} view={view} />
    {settingsOpen ? <ProjectSettings columns={snapshot.columns} onClose={() => setSettingsOpen(false)} onCreateColumn={(input) => mutateAndRefresh(() => createColumn(projectId, input))} onReorderColumns={(orderedIds) => mutateAndRefresh(() => reorderColumns(projectId, orderedIds))} onUpdateColumn={(columnId, patch) => mutateAndRefresh(() => updateColumn(projectId, columnId, patch))} onUpdateProject={(patch) => mutateAndRefresh(() => updateProject(projectId, patch))} project={snapshot.project} /> : null}
    <TaskDrawer activities={snapshot.activities} labels={snapshot.labels} links={snapshot.taskLinks} onAddLink={(documentId) => mutateAndRefresh(() => addTaskLink(selectedTask.id, documentId))} onArchive={() => mutateAndRefresh(() => archiveTask(selectedTask.id)).then(() => setSelectedTask(null))} onClose={() => setSelectedTask(null)} onCreateLabel={(input) => mutateAndRefresh(() => createLabel(input))} onOpenDocument={onOpenDocument} onRemoveLink={(linkId) => mutateAndRefresh(() => removeTaskLink(linkId))} onSave={save} onSetLabels={(taskId, labelIds) => mutateAndRefresh(() => setTaskLabels(taskId, labelIds))} projectKey={snapshot.project.key} task={selectedTask} taskLabels={snapshot.taskLabels} />
    {error ? <div className="project-toast" role="alert">{error.message}</div> : null}</>;
}
