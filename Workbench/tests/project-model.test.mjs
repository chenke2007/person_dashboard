import assert from "node:assert/strict";
import test from "node:test";

import {
  backlogTasks,
  filterTasks,
  projectMetrics,
  tasksForColumn,
} from "../src/lib/project-model.js";

const columns = [
  { id: "todo", name: "待办", position: 0, isFinal: false },
  { id: "done", name: "已完成", position: 1, isFinal: true },
];
const tasks = [
  { id: "a", title: "发布 项目功能", description: "完成接口", columnId: "todo", priority: "high", dueDate: "2026-08-31", position: 1, archivedAt: null },
  { id: "b", title: "整理文档", description: "发布说明", columnId: "done", priority: "medium", dueDate: "2026-08-20", position: 0, archivedAt: null },
  { id: "c", title: "Backlog", description: "稍后", columnId: null, priority: "low", dueDate: null, position: 0, archivedAt: null },
  { id: "d", title: "归档发布", description: "", columnId: "todo", priority: "high", dueDate: null, position: 0, archivedAt: "2026-08-01T00:00:00.000Z" },
];
const taskLabels = [
  { taskId: "a", labelId: "important" },
  { taskId: "b", labelId: "docs" },
];

test("combines filter groups with AND and labels within a group with OR", () => {
  const result = filterTasks(tasks, {
    query: "发布",
    priorities: ["high"],
    labelIds: ["important", "docs"],
  }, { columns, taskLabels });
  assert.deepEqual(result.map((task) => task.id), ["a"]);
});

test("projects Board and Backlog tasks without mutating API order", () => {
  const original = structuredClone(tasks);
  assert.deepEqual(tasksForColumn({ tasks }, "todo").map((task) => task.id), ["a"]);
  assert.deepEqual(backlogTasks({ tasks }).map((task) => task.id), ["c"]);
  assert.deepEqual(tasks, original);
});

test("derives completion and overdue metrics from final columns", () => {
  assert.deepEqual(projectMetrics({ tasks, columns }, "2026-09-01"), {
    activeTasks: 3,
    completedTasks: 1,
    overdueTasks: 1,
    completion: 1 / 3,
  });
});
