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
      import { ProjectView } from "../src/pages/ProjectPage.jsx";
      const render = (Component, props) => renderToStaticMarkup(<MemoryRouter><Component {...props} /></MemoryRouter>);
      exports.renderProjects = (props) => render(ProjectsView, props);
      exports.renderProject = (props) => render(ProjectView, props);
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
});
