const descriptions = {
  "task.created": "创建了任务",
  "task.updated": "更新了任务信息",
  "task.moved": "移动了任务",
  "task.labels_changed": "更新了标签",
  "task.linked": "关联了文档",
  "task.unlinked": "移除了文档关联",
  "task.archived": "归档了任务",
};

export function TaskActivity({ activities = [] }) {
  const ordered = [...activities].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <section className="task-activity"><h3>活动</h3>{ordered.length ? <ol>{ordered.map((activity) => <li key={activity.id}><span>{descriptions[activity.type] || "更新了任务"}</span><time dateTime={activity.createdAt}>{new Date(activity.createdAt).toLocaleString("zh-CN")}</time></li>)}</ol> : <p>还没有活动记录。</p>}</section>;
}
