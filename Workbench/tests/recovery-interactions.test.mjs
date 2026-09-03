import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Module, createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Window } from "happy-dom";
import { createProjectRepository } from "../server/projects/project-repository.mjs";

const window = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : typeof window[key] === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? window[key].bind(window) : window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const filename = fileURLToPath(new URL("./recovery-interactions.cjs", import.meta.url));
const built = await build({
  stdin: { contents: `import React from "react"; import { MemoryRouter, Routes, Route } from "react-router-dom";
    import { ProjectPage } from "../src/pages/ProjectPage.jsx"; import { OverviewPage } from "../src/pages/OverviewPage.jsx";
    exports.project = (id) => <MemoryRouter initialEntries={['/projects/' + id]}><Routes><Route path="/projects/:projectId" element={<ProjectPage onOpenDocument={() => {}} />} /></Routes></MemoryRouter>;
    exports.overview = () => <MemoryRouter><OverviewPage onOpenDocument={() => {}} /></MemoryRouter>;`,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "jsx" },
  bundle: true, platform: "node", format: "cjs", jsx: "automatic", packages: "external", write: false,
  define: { "import.meta.env": "{}" },
  plugins: [{ name: "ignore-css", setup(context) { context.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" })); } }],
});
const compiled = new Module(filename);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(fileURLToPath(new URL(".", import.meta.url)));
compiled.require = createRequire(import.meta.url);
compiled._compile(built.outputFiles[0].text, filename);
const response = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
async function settle(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, "UI did not settle"); await act(async () => { await delay(20); }); }
}
async function mount(t, element, fetcher) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(() => root.unmount()); container.remove(); globalThis.fetch = previousFetch; });
  await act(async () => { root.render(element); });
  return container;
}
const button = (container, text) => [...container.querySelectorAll("button")].find((item) => item.textContent === text);

test("restoring archived tasks keeps the remaining archive visible and restorable through real page buttons", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synthetic-archive-interaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = createProjectRepository({ directory });
  const project = await repository.createProject({ key: "SYN", name: "Synthetic project" });
  for (const title of ["Synthetic archived A", "Synthetic archived B"]) {
    const task = await repository.createTask({ projectId: project.project.id, title });
    await repository.archiveTask(task.task.id);
  }
  localStorage.setItem("workbench-project-view", "archived");
  const loads = [];
  const container = await mount(t, compiled.exports.project(project.project.id), async (url, options) => {
    if (options?.method === "POST") return response(await repository.restoreTask(url.split("/")[3]));
    const includeArchived = url.includes("archived=include"); loads.push(includeArchived);
    return response(await repository.getProject(project.project.id, { includeArchived }));
  });
  await settle(() => container.textContent.includes("Synthetic archived B"));
  await act(async () => { button(container, "恢复任务").click(); });
  await settle(() => loads.length >= 2 && !container.textContent.includes("Synthetic archived A"));
  assert.match(container.textContent, /Synthetic archived B/);
  assert.equal(loads.at(-1), true);
  await act(async () => { button(container, "恢复任务").click(); });
  await settle(() => container.textContent.includes("暂无已归档任务"));
  assert.equal((await repository.getProject(project.project.id)).tasks.length, 2);
});

for (const douyin of [false, true]) {
  test(`overview renders metrics and source notices together (douyin=${douyin})`, async (t) => {
    const data = { capabilities: { douyin }, metrics: { raw: 2, wiki: 3, publishedWorks: null, totalPlays: null }, wikiStatus: {}, recent: [], activity: [], qualityNotices: ["抖音 synthetic source notice"] };
    const container = await mount(t, compiled.exports.overview(), async (url) => response(url === "/api/overview" ? data : { nodes: [], edges: [], stats: {} }));
    await settle(() => container.textContent.includes("索引实时"));
    if (douyin) {
      assert.match(container.textContent, /已发布作品/); assert.match(container.textContent, /总播放/); assert.match(container.textContent, /synthetic source notice/);
    } else {
      assert.doesNotMatch(container.textContent, /已发布作品|总播放|synthetic source notice/);
    }
    assert.match(container.textContent, /WIKI 页面/);
  });
}

test.after(async () => { await window.happyDOM.close(); });
