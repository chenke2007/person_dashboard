import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const filename = fileURLToPath(new URL("./projects-ui-render.cjs", import.meta.url));
const result = await build({
  stdin: {
    contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { MemoryRouter } from "react-router-dom";
      import { ProjectsView } from "../src/pages/ProjectsPage.jsx";
      import { ProjectView, createProjectSnapshotLoader } from "../src/pages/ProjectPage.jsx";
      import { TaskDrawer } from "../src/components/projects/TaskDrawer.jsx";
      const render = (Component, props) => renderToStaticMarkup(<MemoryRouter><Component {...props} /></MemoryRouter>);
      exports.renderProjects = (props) => render(ProjectsView, props);
      exports.renderProject = (props) => render(ProjectView, props);
      exports.renderTaskDrawer = (props) => render(TaskDrawer, props);
      exports.createProjectSnapshotLoader = createProjectSnapshotLoader;
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  packages: "external",
  plugins: [{
    name: "ignore-css",
    setup(buildContext) {
      buildContext.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
    },
  }],
  write: false,
});
const compiled = new Module(filename);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(fileURLToPath(new URL(".", import.meta.url)));
compiled.require = createRequire(import.meta.url);
compiled._compile(result.outputFiles[0].text, filename);

test("project overview renders an actionable empty state", () => {
  const html = compiled.exports.renderProjects({
    snapshot: { projects: [], metrics: {} },
    onCreate: () => {},
  });
  assert.match(html, /创建第一个项目/);
  assert.match(html, /项目把知识库里的资料连接到可以推进的任务/);
});

test("project overview renders persisted metrics instead of demo values", () => {
  const html = compiled.exports.renderProjects({
    snapshot: {
      projects: [{ id: "project-1", key: "PAW", name: "Workbench", description: "执行层" }],
      metrics: { "project-1": { activeTasks: 4, completedTasks: 1, overdueTasks: 2, completion: 0.25 } },
    },
    onCreate: () => {},
  });
  assert.match(html, /Workbench/);
  assert.match(html, /25%/);
  assert.match(html, /2 项逾期/);
});

test("project view exposes Board, List, Backlog and accessible task movement", () => {
  const snapshot = {
    revision: 3,
    project: { id: "project-1", key: "PAW", name: "Workbench", description: "执行层" },
    columns: [
      { id: "todo", name: "待办", position: 0, isFinal: false },
      { id: "done", name: "已完成", position: 1, isFinal: true },
    ],
    tasks: [
      { id: "task-1", number: 1, title: "实现看板", description: "", columnId: "todo", priority: "high", position: 0, archivedAt: null },
      { id: "task-2", number: 2, title: "未来任务", description: "", columnId: null, priority: "low", position: 0, archivedAt: null },
    ],
    labels: [], taskLabels: [], taskLinks: [], activities: [],
  };
  const html = compiled.exports.renderProject({
    snapshot,
    view: "board",
    filters: {},
    onChangeView: () => {},
    onChangeFilters: () => {},
    onCreateTask: () => {},
    onOpenTask: () => {},
    onMoveTask: () => {},
  });
  assert.match(html, />看板</);
  assert.match(html, />列表</);
  assert.match(html, />Backlog</);
  assert.match(html, /实现看板/);
  assert.match(html, /移动任务“实现看板”/);
});

test("project view exposes archived tasks and their restore action", () => {
  const html = compiled.exports.renderProject({
    snapshot: {
      project: { id: "project-1", key: "PAW", name: "Workbench" },
      columns: [],
      tasks: [{ id: "task-1", number: 1, title: "Synthetic archived task", columnId: null, priority: "medium", position: 0, archivedAt: "2026-09-01T00:00:00.000Z" }],
      labels: [], taskLabels: [], taskLinks: [], activities: [],
    },
    view: "archived",
    filters: {},
    onChangeView() {}, onChangeFilters() {}, onCreateTask() {}, onOpenTask() {}, onMoveTask() {}, onOpenSettings() {}, onRestoreTask() {},
  });
  assert.match(html, /已归档任务/);
  assert.match(html, /Synthetic archived task/);
  assert.match(html, /恢复任务/);
});

test("project snapshot lifecycle requests archives only for that view and ignores stale responses", async () => {
  const requests = [];
  const snapshots = [];
  const loader = compiled.exports.createProjectSnapshotLoader((projectId, options) => new Promise((resolve) => {
    requests.push({ projectId, options, resolve });
  }), (snapshot) => snapshots.push(snapshot));

  const initial = loader.load("project-1");
  assert.deepEqual(requests[0], { projectId: "project-1", options: { includeArchived: false }, resolve: requests[0].resolve });
  const defaultSnapshot = { tasks: [{ id: "active", archivedAt: null }] };
  requests[0].resolve(defaultSnapshot);
  assert.equal(await initial, defaultSnapshot);

  const archived = loader.load("project-1", { includeArchived: true });
  assert.equal(requests[1].options.includeArchived, true);
  loader.invalidate();
  const archivedSnapshot = { tasks: [{ id: "archived", archivedAt: "2026-09-01T00:00:00.000Z" }] };
  requests[1].resolve(archivedSnapshot);
  assert.equal(await archived, null);
  assert.deepEqual(snapshots, [defaultSnapshot]);

  const board = loader.load("project-1");
  assert.equal(requests[2].options.includeArchived, false);
  requests[2].resolve(defaultSnapshot);
  assert.equal(await board, defaultSnapshot);
  assert.deepEqual(snapshots, [defaultSnapshot, defaultSnapshot]);
});

test("project planning keeps drag, drawer, filters and view preference wired", async () => {
  const page = await readFile(new URL("../src/pages/ProjectPage.jsx", import.meta.url), "utf8");
  const drawer = await readFile(new URL("../src/components/projects/TaskDrawer.jsx", import.meta.url), "utf8");
  assert.match(page, /DndContext/);
  assert.match(page, /workbench-project-view/);
  assert.match(page, /TaskDrawer/);
  assert.match(page, /priority/);
  assert.match(page, /labelIds/);
  assert.match(page, /dueAfter/);
  assert.match(drawer, /保存任务/);
  assert.match(drawer, /归档任务/);
  assert.match(drawer, /关联文档/);
  assert.match(drawer, /文档已移动或删除/);
  assert.match(drawer, /response\.data\?\.items/);
  assert.match(page, /await refresh\(\)\.catch/);
});

test("Backlog keeps an accessible path for moving tasks into execution", () => {
  const snapshot = {
    project: { id: "project-1", key: "PAW", name: "Workbench" },
    columns: [{ id: "todo", name: "待办", position: 0, isFinal: false }],
    tasks: [{ id: "task-1", number: 1, title: "整理需求", columnId: null, priority: "medium", position: 0, archivedAt: null }],
    labels: [], taskLabels: [], taskLinks: [], activities: [],
  };
  const html = compiled.exports.renderProject({ snapshot, view: "backlog", filters: {}, onChangeView() {}, onChangeFilters() {}, onCreateTask() {}, onOpenTask() {}, onMoveTask() {} });
  assert.match(html, /移动任务“整理需求”/);
  assert.match(html, /开始日期/);
});

test("project navigation and routes stay behind the local Workbench gate", async () => {
  const [app, shell] = await Promise.all([
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/AppShell.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(app, /localWorkbench\s*\?\s*<Route path="\/projects"/);
  assert.match(app, /localWorkbench\s*\?\s*<Route path="\/projects\/:projectId"/);
  assert.match(shell, /\.\.\.\(localWorkbench\s*\?\s*\[\{\s*to:\s*"\/projects"/);
  assert.match(shell, /\["\/", "\/graph", "\/wiki", "\/materials", "\/projects"\]\.includes/);
});

test("project settings expose project and workflow column management", async () => {
  const [page, settings] = await Promise.all([
    readFile(new URL("../src/pages/ProjectPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/projects/ProjectSettings.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /ProjectSettings/);
  assert.match(page, /createColumn/);
  assert.match(page, /reorderColumns/);
  assert.match(settings, /保存项目信息/);
  assert.match(settings, /新增状态列/);
  assert.match(settings, /最终状态/);
  assert.match(settings, /上移/);
  assert.match(settings, /下移/);
});

test("task editing always exposes label creation and compact multi-label filtering", () => {
  const drawer = compiled.exports.renderTaskDrawer({
    task: { id: "task-1", number: 1, title: "整理需求", description: "", priority: "medium" },
    projectKey: "PAW", labels: [], taskLabels: [], links: [], activities: [],
    onClose() {}, onSave() {}, onArchive() {}, onSetLabels() {}, onCreateLabel() {}, onAddLink() {}, onRemoveLink() {}, onOpenDocument() {},
  });
  assert.match(drawer, /暂无标签/);
  assert.match(drawer, /新建标签/);

  const project = compiled.exports.renderProject({
    snapshot: { project: { id: "p", key: "PAW", name: "Workbench" }, columns: [], tasks: [], labels: [{ id: "label-1", name: "前端", color: "#4a8c78" }], taskLabels: [], taskLinks: [], activities: [] },
    view: "list", filters: {}, onChangeView() {}, onChangeFilters() {}, onCreateTask() {}, onOpenTask() {}, onMoveTask() {}, onOpenSettings() {},
  });
  assert.match(project, /<summary aria-label="标签筛选">全部<\/summary>/);
  assert.doesNotMatch(project, /标签：全部/);
  assert.match(project, /type="checkbox"/);
  assert.doesNotMatch(project, /<select[^>]*multiple/);
});

test("label filter has an explicit close action and dismisses outside or with Escape", async () => {
  const page = await readFile(new URL("../src/pages/ProjectPage.jsx", import.meta.url), "utf8");
  assert.match(page, />完成<\/button>/);
  assert.match(page, /setLabelFilterOpen\(false\)/);
  assert.match(page, /event\.key === "Escape"/);
  assert.match(page, /pointerdown/);
});
