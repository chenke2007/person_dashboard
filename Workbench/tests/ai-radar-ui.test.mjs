import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import React from "react";

const filename = fileURLToPath(new URL("./ai-radar-ui-render.cjs", import.meta.url));
const result = await build({
  stdin: {
    contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import {
        AiRadarView,
        radarFilterFromSearch,
        radarFilterToSearch,
        createRadarDashboardLoader,
      } from "../src/pages/AiRadarPage.jsx";
      exports.renderView = (props) => renderToStaticMarkup(React.createElement(AiRadarView, props));
      exports.radarFilterFromSearch = radarFilterFromSearch;
      exports.radarFilterToSearch = radarFilterToSearch;
      exports.createRadarDashboardLoader = createRadarDashboardLoader;
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  packages: "external",
  plugins: [
    {
      name: "ignore-css",
      setup(buildContext) {
        buildContext.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      },
    },
  ],
  write: false,
});
const compiled = new Module(filename);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(fileURLToPath(new URL(".", import.meta.url)));
compiled.require = createRequire(import.meta.url);
compiled._compile(result.outputFiles[0].text, filename);

// Mounted (happy-dom) harness: verifies the schedule form reflects persisted
// values that arrive after the initial render, which a static render cannot.
const window = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : typeof window[key] === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? window[key].bind(window) : window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const statusFilename = fileURLToPath(new URL("./ai-radar-ui-status.cjs", import.meta.url));
const statusBuild = await build({
  stdin: {
    contents: `
      import { AiRadarStatus as StatusComponent } from "../src/components/ai-radar/AiRadarStatus.jsx";
      export const AiRadarStatus = StatusComponent;
      export const statusProps = (schedule, status = { running: false, lastSuccessAt: null, nextRunAt: null, error: null }) => ({
        status,
        schedule,
        stale: false,
        readOnly: false,
        busy: { collect: false, save: false },
        actionErrors: { collect: null, save: null },
        actions: { onCollect: async () => {}, onUpdateSchedule: async () => {} },
      });
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  packages: "external",
  plugins: [
    {
      name: "ignore-css",
      setup(buildContext) {
        buildContext.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      },
    },
  ],
  write: false,
});
const statusCompiled = new Module(statusFilename);
statusCompiled.filename = statusFilename;
statusCompiled.paths = Module._nodeModulePaths(fileURLToPath(new URL(".", import.meta.url)));
statusCompiled.require = createRequire(import.meta.url);
statusCompiled._compile(statusBuild.outputFiles[0].text, statusFilename);

// Renders AiRadarStatus with the given schedule and returns helpers to re-render.
async function mountStatus(t) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const renderSchedule = async (schedule) => {
    await act(() => { root.render(React.createElement(statusCompiled.exports.AiRadarStatus, statusCompiled.exports.statusProps(schedule))); });
  };
  t.after(() => { act(() => root.unmount()); container.remove(); });
  return { container, root, renderSchedule };
}

function card(overrides = {}) {
  return {
    repositoryId: 1,
    fullName: "synthetic-lab/agent-tool",
    htmlUrl: "https://github.com/synthetic-lab/agent-tool",
    description: "Synthetic agent tooling.",
    language: "TypeScript",
    topics: ["agent"],
    license: "MIT",
    archived: false,
    fork: false,
    focusAreas: ["agent"],
    stars: 107,
    observedStarDelta: 4,
    trendStatus: "incomplete",
    coverage: { observedDays: 3, expectedDays: 7, missingDays: 4, complete: false },
    maintainedAt: "2026-09-01T00:00:00.000Z",
    reasons: ["明确关注方向：agent。"],
    decisionStatus: "unread",
    decisionUpdatedAt: null,
    ...overrides,
  };
}

function view(overrides = {}) {
  return {
    period: "day",
    list: "rising",
    state: "all",
    focus: "all",
    viewLimit: 8,
    cards: [card()],
    localDate: "2026-09-02",
    timeZone: "Etc/UTC",
    empty: false,
    ...overrides,
  };
}

function props(overrides = {}) {
  return {
    filter: { period: "day", list: "rising", state: "all", focus: "all" },
    onChangeFilter: () => {},
    view: view(),
    loading: false,
    error: null,
    stale: false,
    status: { running: false, lastAttemptAt: null, lastSuccessAt: "2026-09-02T01:00:00.000Z", nextRunAt: "2026-09-03T08:00:00.000Z", error: null },
    schedule: { enabled: true, time: "08:00", timeZone: "Etc/UTC" },
    preferences: [{ id: "11111111-2222-4333-8444-555555555555", repositoryId: null, kind: "topic", value: "agents", direction: "less", createdAt: "2026-09-02T01:00:00.000Z", revertedAt: null }],
    readOnly: false,
    busy: { collect: false, save: false, decision: null, lessLike: null, revert: null, reset: false },
    actionErrors: { collect: null, save: null, decision: {}, lessLike: {}, revert: {}, reset: null },
    actions: {
      onCollect: async () => {},
      onDecide: async () => {},
      onLessLike: async () => {},
      onRevertPreference: async () => {},
      onResetPreferences: async () => {},
      onUpdateSchedule: async () => {},
      onRetry: async () => {},
    },
    ...overrides,
  };
}

const viewHtml = (overrides = {}) => compiled.exports.renderView(props(overrides));

test("radar page renders title, periods, lists and local observation optics", () => {
  const html = viewHtml();
  assert.match(html, /AI 雷达/);
  assert.match(html, /今日/);
  assert.match(html, /每周/);
  assert.match(html, /每月/);
  assert.match(html, /快速上升/);
  assert.match(html, /长期热门/);
  assert.match(html, /与你相关/);
  assert.match(html, /synthetic-lab\/agent-tool/);
  assert.match(html, /Synthetic agent tooling\./);
  assert.match(html, /href="https:\/\/github\.com\/synthetic-lab\/agent-tool"/);
  assert.match(html, />107</);
  assert.match(html, /本地观测/);
  assert.match(html, /\+4</);
  assert.match(html, /覆盖 3\/7 天/);
  assert.match(html, /明确关注方向：agent。/);
  assert.match(html, /TypeScript/);
});

test("state and focus filters expose labelled selections anchored to the search params", () => {
  const html = viewHtml({ filter: { period: "week", list: "relevant", state: "saved", focus: "rag-knowledge" } });
  assert.match(html, /全部/);
  assert.match(html, /未处理/);
  assert.match(html, /已忽略/);
  assert.match(html, /AI Agent/);
  assert.match(html, /RAG\/知识库/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /value="rag-knowledge"/);
  assert.match(html, /value="saved"/);
  assert.match(html, /AI 应用与生产力/);
});

test("empty state does not invent repository data", () => {
  const html = viewHtml({ view: view({ cards: [], empty: true }) });
  assert.match(html, /暂无/);
  assert.doesNotMatch(html, /synthetic-lab/);
  assert.doesNotMatch(html, /repositoryId/);
});

test("loading, failure and stale states are explicit", () => {
  const loading = viewHtml({ view: null, loading: true, error: null });
  assert.match(loading, /正在读取/);

  const failed = viewHtml({ view: null, loading: false, error: "雷达服务暂时不可用。" });
  assert.match(failed, /加载失败/);
  assert.match(failed, /雷达服务暂时不可用。/);

  const stale = viewHtml({ stale: true });
  assert.match(stale, /可能不是最新/);
});

test("missing baselines and non-exact windows keep their honest copy", () => {
  const collecting = viewHtml({ view: view({ cards: [card({ observedStarDelta: null, trendStatus: "collecting", reasons: ["缺少合格的历史基线，继续收集。"] })] }) });
  assert.match(collecting, /继续收集/);

  const windowed = viewHtml({ view: view({ cards: [card({ reasons: ["与 2026-08-26 基线相比（实际 3 天窗口，非请求的精确窗口）。"] })] }) });
  assert.match(windowed, /实际 3 天窗口/);
});

test("decision and preference actions render with busy and failure feedback", () => {
  const html = viewHtml({
    view: view({ cards: [card({ repositoryId: 6, decisionStatus: "saved" }), card({ repositoryId: 7, decisionStatus: "unread" })] }),
    busy: { collect: false, save: false, decision: new Set([7]), lessLike: new Set([7]), revert: new Set(), reset: false },
    actionErrors: { collect: null, save: null, decision: { 7: "保存失败，请重试。" }, lessLike: { 7: "偏好提交失败。" }, revert: {}, reset: null },
  });
  assert.match(html, /取消收藏/);
  assert.match(html, /保存中/);
  assert.match(html, /保存失败，请重试。/);
  assert.match(html, /减少类似推荐/);
  assert.match(html, /偏好提交失败。/);
  assert.match(html, /撤销/);
  assert.match(html, /重置全部/);
  assert.match(html, /类似主题：agents/);
});

test("schedule controls show persisted values, next run and manual collection", () => {
  const html = viewHtml({ status: { running: true, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: "2026-09-03T08:00:00.000Z", error: null } });
  assert.match(html, /启用自动采集/);
  assert.match(html, /value="08:00"/);
  assert.match(html, /value="Etc\/UTC"/);
  assert.match(html, /立即采集/);
  assert.match(html, /采集中/);
  assert.match(html, /下次运行/);
  assert.match(html, /2026-09-03/);
  assert.match(html, /保存设置/);
});

test("read-only mode keeps reads and disables every mutation control", () => {
  const html = viewHtml({ readOnly: true });
  assert.match(html, /synthetic-lab\/agent-tool/);
  assert.match(html, /启用自动采集/);
  assert.match(html, /<input[^>]*disabled/);
  assert.match(html, /<select[^>]*disabled/);
  assert.doesNotMatch(html, />立即采集</);
  assert.doesNotMatch(html, />保存设置</);
  assert.doesNotMatch(html, /aria-label="收藏/);
  assert.doesNotMatch(html, /aria-label="忽略/);
  assert.doesNotMatch(html, /aria-label="减少类似推荐/);
  assert.doesNotMatch(html, />撤销</);
  assert.doesNotMatch(html, />重置全部</);
});

test("card actions stay visible and labelled without hover", () => {
  const html = viewHtml({ view: view({ cards: [card({ decisionStatus: "unread" })] }) });
  assert.match(html, /aria-label="收藏/);
  assert.match(html, /aria-label="忽略/);
  assert.match(html, /aria-label="减少类似推荐/);
  assert.doesNotMatch(html, /收集基线不足|请将鼠标|移入卡片/);
});

test("radar filter search params round-trip with fallbacks and default omission", () => {
  const parsed = compiled.exports.radarFilterFromSearch(new URLSearchParams("period=week&list=relevant&state=saved&focus=agent"));
  assert.deepEqual(parsed, { period: "week", list: "relevant", state: "saved", focus: "agent" });

  const fallback = compiled.exports.radarFilterFromSearch(new URLSearchParams("period=decade&state=starred&focus=machine-learning"));
  assert.deepEqual(fallback, { period: "day", list: "rising", state: "all", focus: "all" });

  const encoded = compiled.exports.radarFilterToSearch({ period: "day", list: "rising", state: "all", focus: "all" });
  assert.equal(encoded.toString(), "");

  const nonDefault = compiled.exports.radarFilterToSearch({ period: "week", list: "relevant", state: "saved", focus: "rag-knowledge" });
  assert.equal(nonDefault.toString(), "period=week&list=relevant&state=saved&focus=rag-knowledge");

  const roundTrip = compiled.exports.radarFilterFromSearch(nonDefault);
  assert.deepEqual(roundTrip, { period: "week", list: "relevant", state: "saved", focus: "rag-knowledge" });
});

test("dashboard loader drops superseded slow responses and surfaces the latest", async () => {
  const requests = [];
  const changes = [];
  const loader = compiled.exports.createRadarDashboardLoader(
    (filter) => new Promise((resolve, reject) => requests.push({ filter, resolve, reject })),
    (value, error) => changes.push({ value, error }),
  );

  const first = loader.load({ period: "day", state: "all", focus: "all" });
  const second = loader.load({ period: "week", state: "saved", focus: "agent" });
  assert.equal(requests.length, 2);

  requests[1].resolve({ period: "week" });
  assert.deepEqual(await second, { period: "week" });
  requests[0].resolve({ period: "day" });
  assert.equal(await first, null);

  assert.deepEqual(changes, [{ value: { period: "week" }, error: undefined }]);

  const failure = loader.load({ period: "month" });
  const newer = loader.load({ period: "day", state: "all", focus: "all" });
  requests[3].resolve({ period: "day" });
  await newer;
  requests[2].reject(new Error("stale synthetic failure"));
  await assert.rejects(failure, /stale synthetic failure/);
  assert.equal(changes.length, 2);
});

test("radar navigation stays behind the local Workbench gate and labels the entry", async () => {
  const [app, shell] = await Promise.all([
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/AppShell.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(app, /<Route path="\/ai-radar"/);
  assert.match(app, /localWorkbench\s*\?\s*<Route path="\/ai-radar"/);
  assert.match(shell, /to: "\/ai-radar",\s*label: "AI 雷达"/);
  assert.match(shell, /\.\.\.\(localWorkbench\s*\?\s*\[\{\s*to: "\/ai-radar"/);
  // The obsidian read-only profile curates a narrow nav that omits AI radar.
  assert.match(shell, /\["\/", "\/graph", "\/wiki", "\/materials", "\/projects"\]\.includes/);
});
test("schedule form reflects persisted values once they arrive after the initial render", async (t) => {
  const { container, renderSchedule } = await mountStatus(t);

  // Initial render has no schedule yet (async server fetch still pending).
  await renderSchedule(null);
  assert.equal(container.querySelector('input[name="enabled"]').checked, false);

  // Persisted schedule arrives; the form must re-initialize from it.
  await renderSchedule({ enabled: true, time: "23:30", timeZone: "Asia/Shanghai" });
  assert.equal(container.querySelector('input[name="enabled"]').checked, true);
  assert.equal(container.querySelector('input[name="time"]').value, "23:30");
  assert.equal(container.querySelector('select[name="timeZone"]').value, "Asia/Shanghai");
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "立即采集"));
});
