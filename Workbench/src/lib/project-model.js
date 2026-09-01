const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function active(tasks) {
  return (tasks || []).filter((task) => !task.archivedAt);
}

function byPosition(left, right) {
  return (left.position ?? 0) - (right.position ?? 0) || collator.compare(left.title || "", right.title || "");
}

export function tasksForColumn(snapshot, columnId) {
  return active(snapshot?.tasks).filter((task) => task.columnId === columnId).sort(byPosition);
}

export function backlogTasks(snapshot) {
  return tasksForColumn(snapshot, null);
}

export function filterTasks(tasks, filters = {}, context = {}) {
  const query = String(filters.query || "").normalize("NFC").trim().toLocaleLowerCase("zh-CN");
  const priorities = new Set(filters.priorities || []);
  const statuses = new Set(filters.columnIds || filters.statuses || []);
  const labels = new Set(filters.labelIds || []);
  const labelsByTask = new Map();
  for (const link of context.taskLabels || []) {
    if (!labelsByTask.has(link.taskId)) labelsByTask.set(link.taskId, new Set());
    labelsByTask.get(link.taskId).add(link.labelId);
  }
  return active(tasks).filter((task) => {
    if (query && !`${task.title || ""}\n${task.description || ""}`.normalize("NFC").toLocaleLowerCase("zh-CN").includes(query)) return false;
    if (priorities.size && !priorities.has(task.priority)) return false;
    if (statuses.size && !statuses.has(task.columnId ?? "backlog")) return false;
    if (labels.size && ![...(labelsByTask.get(task.id) || [])].some((id) => labels.has(id))) return false;
    if (filters.dueBefore && (!task.dueDate || task.dueDate > filters.dueBefore)) return false;
    if (filters.dueAfter && (!task.dueDate || task.dueDate < filters.dueAfter)) return false;
    return true;
  }).sort(byPosition);
}

export function projectMetrics(snapshot, today = new Date().toISOString().slice(0, 10)) {
  const tasks = active(snapshot?.tasks);
  const columns = new Map((snapshot?.columns || []).map((column) => [column.id, column]));
  const completedTasks = tasks.filter((task) => columns.get(task.columnId)?.isFinal).length;
  const overdueTasks = tasks.filter((task) => task.dueDate && task.dueDate < today && !columns.get(task.columnId)?.isFinal).length;
  return {
    activeTasks: tasks.length,
    completedTasks,
    overdueTasks,
    completion: tasks.length ? completedTasks / tasks.length : 0,
  };
}
