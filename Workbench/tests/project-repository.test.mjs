import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectRepository } from "../server/projects/project-repository.mjs";

async function makeStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-projects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function sequenceIds() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function fixedClock() {
  let second = 0;
  return () => new Date(Date.UTC(2026, 8, 1, 0, 0, second++));
}

async function projectFixture(t, options = {}) {
  const directory = await makeStore(t);
  const repository = createProjectRepository({
    directory,
    makeId: sequenceIds(),
    now: fixedClock(),
    ...options,
  });
  const created = await repository.createProject({ key: "PAW", name: "Workbench" });
  return { directory, repository, created };
}

test("creates a durable project with default workflow columns", async (t) => {
  const directory = await makeStore(t);
  const repository = createProjectRepository({
    directory,
    makeId: sequenceIds(),
    now: fixedClock(),
  });

  assert.deepEqual(await repository.getWorkspace(), {
    version: 1,
    revision: 0,
    updatedAt: null,
    projects: [],
    metrics: {},
  });

  const created = await repository.createProject({
    key: " paw ",
    name: " Personal AI Workbench ",
    description: "把知识转成行动",
  });

  assert.equal(created.revision, 1);
  assert.deepEqual(
    {
      key: created.project.key,
      name: created.project.name,
      description: created.project.description,
      lastTaskNumber: created.project.lastTaskNumber,
      position: created.project.position,
    },
    {
      key: "PAW",
      name: "Personal AI Workbench",
      description: "把知识转成行动",
      lastTaskNumber: 0,
      position: 0,
    },
  );
  assert.deepEqual(
    created.columns.map(({ name, position, isFinal }) => ({ name, position, isFinal })),
    [
      { name: "待办", position: 0, isFinal: false },
      { name: "进行中", position: 1, isFinal: false },
      { name: "已完成", position: 2, isFinal: true },
    ],
  );

  const reconstructed = createProjectRepository({ directory });
  const snapshot = await reconstructed.getProject(created.project.id);
  assert.equal(snapshot.project.key, "PAW");
  assert.equal(snapshot.columns.length, 3);
  assert.deepEqual(snapshot.tasks, []);

  const persisted = JSON.parse(await readFile(path.join(directory, "projects.json"), "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.revision, 1);
  assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
});

test("numbers tasks monotonically and moves them with revision protection", async (t) => {
  const { repository, created } = await projectFixture(t);
  const first = await repository.createTask({
    projectId: created.project.id,
    title: "整理需求",
  });
  const second = await repository.createTask({
    projectId: created.project.id,
    title: "实现看板",
    priority: "high",
  });

  assert.equal(first.task.number, 1);
  assert.equal(second.task.number, 2);
  assert.equal(first.task.columnId, null);
  assert.deepEqual([first.task.position, second.task.position], [0, 1]);

  const doing = created.columns[1];
  const moved = await repository.moveTask({
    taskId: second.task.id,
    columnId: doing.id,
    index: 0,
    revision: second.revision,
  });
  assert.equal(moved.task.columnId, doing.id);
  assert.equal(moved.task.position, 0);
  assert.equal(moved.activities[0].type, "task.moved");

  await assert.rejects(
    repository.moveTask({
      taskId: first.task.id,
      columnId: doing.id,
      index: 0,
      revision: second.revision,
    }),
    (error) => error.code === "PROJECT_REVISION_CONFLICT" && error.status === 409,
  );

  const snapshot = await repository.getProject(created.project.id);
  assert.equal(snapshot.tasks.find((task) => task.id === first.task.id).columnId, null);
  assert.equal(snapshot.tasks.find((task) => task.id === second.task.id).columnId, doing.id);
  const metrics = (await repository.getWorkspace()).metrics[created.project.id];
  assert.equal(metrics.latestActivity.type, "task.moved");
  assert.equal(metrics.inProgressTasks, 1);
});

test("validates dates and project ownership before changing a task", async (t) => {
  const { repository, created } = await projectFixture(t);
  const other = await repository.createProject({ key: "OTHER", name: "Other" });

  await assert.rejects(
    repository.createTask({
      projectId: created.project.id,
      columnId: other.columns[0].id,
      title: "跨项目任务",
    }),
    (error) => error.code === "PROJECT_COLUMN_MISMATCH",
  );
  await assert.rejects(
    repository.createTask({
      projectId: created.project.id,
      title: "日期错误",
      startDate: "2026-09-03",
      dueDate: "2026-09-02",
    }),
    (error) => error.code === "PROJECT_DATE_RANGE_INVALID",
  );
  await repository.updateColumn(created.columns[0].id, { isFinal: true });
  await assert.rejects(
    repository.updateColumn(created.columns[1].id, { isFinal: true }),
    (error) => error.code === "PROJECT_WORKFLOW_REQUIRES_ACTIVE_COLUMN",
  );
});

test("persists labels, safe Vault links, archives, and auditable activities", async (t) => {
  let documentAvailable = true;
  const document = {
    id: "wiki/project-management.md",
    path: "wiki/project-management.md",
    kind: "wiki",
    title: "项目管理",
  };
  const { repository, created } = await projectFixture(t, {
    resolveDocument: async (id) => documentAvailable && id === document.id ? document : null,
  });
  const taskResult = await repository.createTask({ projectId: created.project.id, title: "关联知识" });
  const labelResult = await repository.createLabel({ name: " 重要 ", color: "#e05252" });
  const labeled = await repository.setTaskLabels({
    taskId: taskResult.task.id,
    labelIds: [labelResult.label.id],
  });
  assert.deepEqual(labeled.taskLabels, [{ taskId: taskResult.task.id, labelId: labelResult.label.id }]);

  const linked = await repository.addTaskLink({ taskId: taskResult.task.id, documentId: document.id });
  assert.equal(linked.link.relativePath, "wiki/project-management.md");
  await assert.rejects(
    repository.addTaskLink({ taskId: taskResult.task.id, documentId: "missing" }),
    (error) => error.code === "PROJECT_DOCUMENT_NOT_FOUND" && error.status === 404,
  );

  const archived = await repository.archiveTask(taskResult.task.id);
  assert.ok(archived.task.archivedAt);
  let snapshot = await repository.getProject(created.project.id);
  assert.equal(snapshot.taskLinks[0].title, "项目管理");
  assert.equal(snapshot.taskLinks[0].missing, false);
  documentAvailable = false;
  snapshot = await repository.getProject(created.project.id);
  assert.equal(snapshot.taskLinks[0].missing, true);
  assert.deepEqual(
    snapshot.activities.map((activity) => activity.type).slice(0, 4),
    ["task.archived", "task.linked", "task.labels_changed", "task.created"],
  );
});

test("updates projects, columns, tasks, links, and project archive state", async (t) => {
  const document = { id: "wiki/plan.md", path: "wiki/plan.md", kind: "wiki" };
  const { repository, created } = await projectFixture(t, {
    resolveDocument: async (id) => id === document.id ? document : null,
  });
  const renamed = await repository.updateProject(created.project.id, {
    name: "Workbench 项目",
    description: "执行层",
  });
  assert.equal(renamed.project.name, "Workbench 项目");

  const newColumn = await repository.createColumn({
    projectId: created.project.id,
    name: "验证中",
    color: "#8d6bd1",
  });
  const reordered = await repository.reorderColumns({
    projectId: created.project.id,
    orderedIds: [newColumn.column.id, ...created.columns.map((column) => column.id)],
  });
  assert.equal(reordered.columns[0].name, "验证中");
  const updatedColumn = await repository.updateColumn(newColumn.column.id, {
    name: "审核中",
    isFinal: false,
  });
  assert.equal(updatedColumn.column.name, "审核中");

  const createdTask = await repository.createTask({ projectId: created.project.id, title: "原标题" });
  const updatedTask = await repository.updateTask(createdTask.task.id, {
    title: "新标题",
    description: "包含验收标准",
    priority: "urgent",
    startDate: "2026-09-01",
    dueDate: "2026-09-02",
  });
  assert.equal(updatedTask.task.title, "新标题");
  assert.equal(updatedTask.task.priority, "urgent");

  const linked = await repository.addTaskLink({ taskId: createdTask.task.id, documentId: document.id });
  const removed = await repository.removeTaskLink(linked.link.id);
  assert.equal(removed.removedLinkId, linked.link.id);

  const archived = await repository.archiveProject(created.project.id);
  assert.ok(archived.project.archivedAt);
  assert.equal((await repository.getWorkspace()).projects.length, 0);
  assert.equal((await repository.getWorkspace({ includeArchived: true })).projects.length, 1);
  await assert.rejects(
    repository.createTask({ projectId: created.project.id, title: "不允许" }),
    (error) => error.code === "PROJECT_ARCHIVED",
  );
  const restored = await repository.restoreProject(created.project.id);
  assert.equal(restored.project.archivedAt, null);
  assert.equal((await repository.getWorkspace()).projects.length, 1);
});

test("refuses an unknown storage version without overwriting its bytes", async (t) => {
  const directory = await makeStore(t);
  const target = path.join(directory, "projects.json");
  const original = `${JSON.stringify({ version: 99, revision: 4 })}\n`;
  await writeFile(target, original, "utf8");
  const repository = createProjectRepository({ directory });

  await assert.rejects(
    repository.createProject({ key: "PAW", name: "Workbench" }),
    (error) => error.code === "PROJECT_STORAGE_VERSION_UNSUPPORTED" && error.status === 500,
  );
  assert.equal(await readFile(target, "utf8"), original);
});
