import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
      exports.AiRadarView = AiRadarView;
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

// Mounted full-page harness: runs AiRadarPage under a router against a
// controllable fetch so filter changes, collection, and out-of-order dashboard
// responses can be reproduced deterministically.
const pageFilename = fileURLToPath(new URL("./ai-radar-ui-page.cjs", import.meta.url));
const pageBuild = await build({
  stdin: {
    contents: `
      export { AiRadarPage } from "../src/pages/AiRadarPage.jsx";
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  packages: "external",
  define: {
    "import.meta.env": "{}",
  },
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
const pageCompiled = new Module(pageFilename);
pageCompiled.filename = pageFilename;
pageCompiled.paths = Module._nodeModulePaths(fileURLToPath(new URL(".", import.meta.url)));
pageCompiled.require = createRequire(import.meta.url);
pageCompiled._compile(pageBuild.outputFiles[0].text, pageFilename);

// Mounted + static harness for the overview radar panel. Exposes the pure
// projection, the presentational panel, and a self-loading wrapper (the hook
// wired to the presentational component) so the independent load, failure
// retention and retry can be verified under a controllable fetch.
const overviewFilename = fileURLToPath(new URL("./ai-radar-ui-overview.cjs", import.meta.url));
const overviewBuild = await build({
  stdin: {
    contents: `
      import React from "react";
      import { AiRadarOverview, projectRadarOverview, useRadarOverview } from "../src/components/ai-radar/AiRadarOverview";
      export { AiRadarOverview, projectRadarOverview };
      export function SelfOverview({ onOpenRadar }) {
        const { model, loading, error, refreshError, retry } = useRadarOverview();
        return React.createElement(AiRadarOverview, {
          model, loading, error, refreshError,
          onRetry: retry,
          onOpenRadar: onOpenRadar || (() => {}),
        });
      }
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
const overviewCompiled = new Module(overviewFilename);
overviewCompiled.filename = overviewFilename;
overviewCompiled.paths = Module._nodeModulePaths(fileURLToPath(new URL(".", import.meta.url)));
overviewCompiled.require = createRequire(import.meta.url);
overviewCompiled._compile(overviewBuild.outputFiles[0].text, overviewFilename);

const { MemoryRouter } = await import("react-router-dom");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Flushes the promise chain from a resolved fetch through React's async
// scheduler so state updates from controlled responses actually paint.
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await act(async () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  await act(async () => {});
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : ""), has: () => false },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function radarDashboard({ period = "day", marker }) {
  return {
    period,
    timeZone: "Etc/UTC",
    localDate: "2026-09-02",
    filters: { state: "all", focus: "all" },
    counts: { all: 1, unread: 1, saved: 0, summarized: 0, queued: 0, learning: 0, completed: 0, ignored: 0 },
    eligibleCount: 1,
    lists: {
      rising: [{
        repositoryId: 101,
        repository: { fullName: `synthetic-lab/${marker}`, htmlUrl: `https://github.com/synthetic-lab/${marker}`, description: `Synthetic ${marker} repo.`, language: "TypeScript", topics: ["agent"], license: "MIT", archived: false, fork: false, stars: 50, pushedAt: null, updatedAt: null },
        currentStars: 50,
        observedStarDelta: 2,
        status: "incomplete",
        coverage: { observedDays: 1, expectedDays: 1, missingDays: 0, complete: true },
        reasons: [`synthetic ${marker}`],
        decision: { status: "unread", updatedAt: null },
      }],
      established: [],
      relevant: [],
    },
    freshness: { queriedAt: "2026-09-02T01:00:00.000Z", asOf: "2026-09-02T01:00:00.000Z", lastDataAt: "2026-09-02T01:00:00.000Z", lastSuccessAt: "2026-09-02T01:00:00.000Z", stale: false },
    coverage: null,
    retryAt: null,
    errors: [],
    run: { id: "00000000-0000-4000-8000-000000000001", trigger: "startup", startedAt: "2026-09-02T01:00:00.000Z", finishedAt: "2026-09-02T01:00:01.000Z", status: "success", localDate: "2026-09-02", timeZone: "Etc/UTC", repositoryCount: 1, errors: [], sequence: 1, collection: null },
    schedule: { enabled: true, time: "08:00", timeZone: "Etc/UTC", lastAttemptAt: null, lastSuccessAt: null, nextRunAt: "2026-09-03T08:00:00.000Z" },
  };
}

// Mounts AiRadarPage under a router. `fetchImpl` receives (path, options) and
// must return a thenable resolving to a Response-like object. Returns helpers
// plus `entries` recording every fetch(path, method).
async function mountPage(t, fetchImpl, initialEntries = ["/ai-radar?period=day"]) {
  const entries = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (path, options = {}) => {
    entries.push({ path: String(path), method: options.method || "GET" });
    return Promise.resolve(fetchImpl(String(path), options));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => {
    root.render(React.createElement(MemoryRouter, { initialEntries }, React.createElement(pageCompiled.exports.AiRadarPage)));
  });
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  const clickTab = async (text) => {
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
    await act(() => button.click());
  };
  return { container, entries, clickTab };
}

// Renders AiRadarStatus with the given schedule and returns helpers to re-render.
async function mountStatus(t, statusOverride, extraProps = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const renderSchedule = async (schedule, status = statusOverride) => {
    await act(() => { root.render(React.createElement(statusCompiled.exports.AiRadarStatus, { ...statusCompiled.exports.statusProps(schedule, status), ...extraProps })); });
  };
  t.after(() => { act(() => root.unmount()); container.remove(); });
  return { container, root, renderSchedule };
}

// Mounts the self-loading overview radar panel under a controllable fetch and
// records every (path, method). Resolves like mountPage so overview requests
// (and only reads) can be asserted.
async function mountOverview(t, fetchImpl) {
  const entries = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (path, options = {}) => {
    entries.push({ path: String(path), method: options.method || "GET" });
    return Promise.resolve(fetchImpl(String(path), options));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => {
    root.render(React.createElement(overviewCompiled.exports.SelfOverview));
  });
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  return { container, root, entries };
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
    learningState: null,
    hasLearning: false,
    learningWorkspaceId: null,
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
    canJoinLearning: true,
    learningStatus: "ok",
    actions: {
      onCollect: async () => {},
      onDecide: async () => {},
      onLessLike: async () => {},
      onRevertPreference: async () => {},
      onResetPreferences: async () => {},
      onUpdateSchedule: async () => {},
      onJoinLearning: async () => {},
      onOpenLearning: async () => {},
      onRetry: async () => {},
    },
    ...overrides,
  };
}

const viewHtml = (overrides = {}) => compiled.exports.renderView(props(overrides));

const overviewHtml = (model, extra = {}) =>
  renderToStaticMarkup(
    React.createElement(overviewCompiled.exports.AiRadarOverview, {
      model,
      loading: false,
      error: null,
      refreshError: null,
      onRetry: () => {},
      onOpenRadar: () => {},
      ...extra,
    }),
  );

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

test("observed star delta renders positive, zero, negative and missing values honestly", () => {
  const mixed = viewHtml({
    view: view({
      cards: [
        card({ repositoryId: 11, observedStarDelta: 4 }),
        card({ repositoryId: 12, observedStarDelta: 0 }),
        card({ repositoryId: 13, observedStarDelta: -5 }),
        card({ repositoryId: 14, observedStarDelta: null }),
      ],
    }),
  });
  // Positive gains get a leading plus; zero and negative must never render "+0"/"+-5".
  assert.match(mixed, />\+4</);
  assert.match(mixed, />数据积累中</);
  assert.doesNotMatch(mixed, />\+0</);
  assert.doesNotMatch(mixed, />\+\-5/);

  const onlyNegative = viewHtml({ view: view({ cards: [card({ repositoryId: 15, observedStarDelta: -5 })] }) });
  assert.match(onlyNegative, />\-5</);

  const onlyZero = viewHtml({ view: view({ cards: [card({ repositoryId: 16, observedStarDelta: 0 })] }) });
  assert.match(onlyZero, />0</);

  const onlyMissing = viewHtml({ view: view({ cards: [card({ repositoryId: 17, observedStarDelta: null })] }) });
  assert.match(onlyMissing, /数据积累中/);
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

test("a card without a learning workspace offers 加入学习 and nothing else", () => {
  const html = viewHtml({ view: view({ cards: [card()] }) });
  assert.match(html, />加入学习</);
  assert.doesNotMatch(html, />查看学习</);
  assert.doesNotMatch(html, /radar-card__learning/);
});

test("a card with a learning workspace shows the lifecycle badge, 查看学习 and no 加入学习", () => {
  const html = viewHtml({
    view: view({ cards: [card({ learningState: "active", hasLearning: true, learningWorkspaceId: "11111111-2222-4333-8444-555555555555" })] }),
  });
  assert.match(html, />学习中</);
  assert.match(html, />查看学习</);
  assert.doesNotMatch(html, />加入学习</);

  const draft = viewHtml({ view: view({ cards: [card({ learningState: "draft", hasLearning: true })] }) });
  assert.match(draft, />学习（草稿）</);

  const queued = viewHtml({ view: view({ cards: [card({ learningState: "queued", hasLearning: true })] }) });
  assert.match(queued, />学习中（排队）</);
});

test("learning archive copy stays distinct from the repository archive flag", () => {
  // The repository itself is archived on GitHub AND its learning workspace is
  // archived: both facts render, with separate copy.
  const html = viewHtml({
    view: view({ cards: [card({ archived: true, learningState: "archived", hasLearning: true })] }),
  });
  assert.match(html, />已归档</);
  assert.match(html, />学习已归档</);
  // The learning archive must never read as a repository archive alone.
  assert.ok(html.indexOf("学习已归档") > 0);
});

test("加入学习 is suppressed while learning capability is pending or unavailable", () => {
  const pending = viewHtml({ canJoinLearning: false });
  assert.doesNotMatch(pending, />加入学习</);

  const unavailable = viewHtml({ learningStatus: "unavailable" });
  assert.doesNotMatch(unavailable, />加入学习</);
});

test("查看学习 stays visible in read-only mode because it only navigates", () => {
  const html = viewHtml({
    readOnly: true,
    view: view({ cards: [card({ learningState: "queued", hasLearning: true, learningWorkspaceId: "11111111-2222-4333-8444-555555555555" })] }),
  });
  assert.match(html, />查看学习</);
  assert.doesNotMatch(html, />加入学习</);
});

// Mounted view harness: renders AiRadarView so clicks reach the action
// handlers wired from the page.
async function mountView(t, viewProps) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => {
    root.render(React.createElement(compiled.exports.AiRadarView, props(viewProps)));
  });
  t.after(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

test("card join and view-learning actions report the repository and workspace id", async (t) => {
  const joined = [];
  const opened = [];
  const container = await mountView(t, {
    view: view({
      cards: [
        card({ repositoryId: 21, learningState: null, hasLearning: false }),
        card({ repositoryId: 22, learningState: "active", hasLearning: true, learningWorkspaceId: "22222222-2222-4333-8444-555555555555" }),
      ],
    }),
    actions: {
      ...props().actions,
      onJoinLearning: (id) => joined.push(id),
      onOpenLearning: (id) => opened.push(id),
    },
  });
  const join = [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === "加入学习");
  const open = [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === "查看学习");
  await act(() => join.click());
  await act(() => open.click());
  assert.deepEqual(joined, [21]);
  assert.deepEqual(opened, ["22222222-2222-4333-8444-555555555555"]);
});

test("radar filter search params round-trip with fallbacks and default omission", () => {
  const parsed = compiled.exports.radarFilterFromSearch(new URLSearchParams("period=week&list=relevant&state=saved&focus=agent"));
  assert.deepEqual(parsed, { period: "week", list: "relevant", state: "saved", focus: "agent", learning: "all" });

  const fallback = compiled.exports.radarFilterFromSearch(new URLSearchParams("period=decade&state=starred&focus=machine-learning"));
  assert.deepEqual(fallback, { period: "day", list: "rising", state: "all", focus: "all", learning: "all" });

  const encoded = compiled.exports.radarFilterToSearch({ period: "day", list: "rising", state: "all", focus: "all" });
  assert.equal(encoded.toString(), "");

  const nonDefault = compiled.exports.radarFilterToSearch({ period: "week", list: "relevant", state: "saved", focus: "rag-knowledge" });
  assert.equal(nonDefault.toString(), "period=week&list=relevant&state=saved&focus=rag-knowledge");

  const roundTrip = compiled.exports.radarFilterFromSearch(nonDefault);
  assert.deepEqual(roundTrip, { period: "week", list: "relevant", state: "saved", focus: "rag-knowledge", learning: "all" });
});

test("learning filter round-trips through the URL and falls back to all", () => {
  const parsed = compiled.exports.radarFilterFromSearch(new URLSearchParams("period=week&learning=active"));
  assert.deepEqual(parsed, { period: "week", list: "rising", state: "all", focus: "all", learning: "active" });

  const fallback = compiled.exports.radarFilterFromSearch(new URLSearchParams("learning=completed"));
  assert.equal(fallback.learning, "all");

  const encoded = compiled.exports.radarFilterToSearch({ period: "day", list: "rising", state: "all", focus: "all", learning: "queued" });
  assert.equal(encoded.toString(), "learning=queued");

  const roundTrip = compiled.exports.radarFilterFromSearch(new URLSearchParams(encoded.toString()));
  assert.equal(roundTrip.learning, "queued");
});

test("an unavailable learning status surfaces an explicit error with retry, never '尚未加入学习'", () => {
  const html = viewHtml({ learningStatus: "unavailable", actions: { ...props().actions, onRetry: () => {} } });
  assert.match(html, /学习状态当前不可用/);
  assert.match(html, />重试</);
  assert.doesNotMatch(html, /尚未加入学习/);
});

test("a learning-filtered board labels radar totals separately from learning matches", () => {
  const html = viewHtml({
    filter: { period: "day", list: "rising", state: "all", focus: "all", learning: "active" },
    view: view({ cards: [card({ learningState: "active", hasLearning: true })], eligibleCount: 28 }),
  });
  // The radar total (eligibleCount) must be labeled as the radar decision set,
  // while the visible count is the matched learning slice.
  assert.match(html, /雷达总数/);
  assert.match(html, /28/);
  assert.match(html, /本榜单展示 1 条/);
  assert.doesNotMatch(html, />28.*匹配结果</);
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

test("learning routes and navigation stay behind the local Workbench gate", async () => {
  const [app, shell] = await Promise.all([
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/AppShell.jsx", import.meta.url), "utf8"),
  ]);
  // All learning surfaces are local-only: hosted builds never expose the
  // routes, and the obsidian read-only profile's curated nav omits them too.
  assert.match(app, /localWorkbench\s*\?\s*<Route path="\/learning"/);
  assert.match(app, /localWorkbench\s*\?\s*<Route path="\/learning\/:workspaceId"/);
  assert.match(shell, /to: "\/learning",\s*label: "学习任务"/);
  assert.match(shell, /\.\.\.\(localWorkbench\s*\?\s*\[\{\s*to: "\/learning"/);
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

test("schedule error renders safe {code,message} text instead of leaking the raw object", async (t) => {
  const { container, renderSchedule } = await mountStatus(t, {
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    error: { code: "RADAR_SCHEDULER_RUN_FAILED", message: "AI Radar collection failed." },
  });
  await renderSchedule({ enabled: true, time: "08:00", timeZone: "Etc/UTC" });

  const text = container.textContent;
  assert.match(text, /调度错误/);
  assert.match(text, /AI Radar collection failed\./);
  assert.doesNotMatch(text, /\[object Object\]/);
  // The page must stay operable around the error: the collect and save buttons remain.
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "立即采集"));
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "保存设置"));
});

test("schedule error falls back to code when message is absent", async (t) => {
  const { container, renderSchedule } = await mountStatus(t, {
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    error: { code: "RADAR_SCHEDULER_RUN_FAILED", message: "" },
  });
  await renderSchedule({ enabled: true, time: "08:00", timeZone: "Etc/UTC" });
  assert.match(container.textContent, /RADAR_SCHEDULER_RUN_FAILED/);
});

test("collect result distinguishes success, partial, failed and not-persisted outcomes", async () => {
  const { describeRadarCollectResult } = await import("../src/lib/ai-radar-api.js");

  // Only persisted:true with an explicit success run is a clean success.
  assert.deepEqual(describeRadarCollectResult({ persisted: true, run: { status: "success" } }), { level: "success", message: "采集完成，数据已保存。" });
  assert.deepEqual(describeRadarCollectResult({ persisted: true, run: { status: "partial" } }), { level: "partial", message: "部分成功：部分仓库未能采集，其余结果已保存。" });

  // HTTP 200 business failure: scheduler-level error object.
  assert.deepEqual(describeRadarCollectResult({ persisted: false, error: { code: "RADAR_SCHEDULER_RUN_FAILED", message: "AI Radar collection failed." } }), { level: "failed", message: "采集失败：AI Radar collection failed." });
  // Not persisted with a failed run carrying an errors[] entry.
  assert.deepEqual(describeRadarCollectResult({ persisted: false, run: { status: "failed", errors: [{ code: "RADAR_PERSISTENCE_FAILED", message: "persist" }] } }), { level: "failed", message: "采集失败：persist" });
  // Cooldown/skip is surfaced as a guarded retry message, not fake success.
  assert.deepEqual(describeRadarCollectResult({ persisted: false, run: { status: "skipped", errors: [{ code: "RADAR_COOLDOWN", message: "cooldown" }] } }), { level: "failed", message: "采集被暂缓：cooldown" });
  // Not persisted with no error shape at all.
  assert.deepEqual(describeRadarCollectResult({ persisted: false, run: null, error: null }), { level: "failed", message: "采集失败，数据未能保存。" });
});

test("collect result treats a persisted run marked failed as failure, never fake success", async () => {
  const { describeRadarCollectResult } = await import("../src/lib/ai-radar-api.js");

  // The collector can durably commit a run whose status is still "failed"
  // (all requests failed / nothing observed), and the routes forward
  // persisted:true together with that failed run. A persisted flag alone must
  // not be read as success.
  const failed = describeRadarCollectResult({
    persisted: true,
    run: {
      status: "failed",
      repositoryCount: 0,
      errors: [{ code: "RADAR_DETAIL_FAILED", message: "rate limited" }],
    },
  });
  assert.equal(failed.level, "failed");
  assert.match(failed.message, /采集失败/);
  assert.match(failed.message, /rate limited/);

  // Persisted with a missing/unknown run status cannot claim success either.
  const unknown = describeRadarCollectResult({ persisted: true, run: null });
  assert.equal(unknown.level, "failed");
  assert.deepEqual(describeRadarCollectResult({ persisted: true }), { level: "failed", message: "采集结果不完整，数据未能全部保存。" });
});

test("collect result interprets the real collector failure shape the routes forward", async () => {
  // The collect endpoint answers 200 forwarding the collector result verbatim.
  // This mirrors the collector total-failure path: commit succeeds but zero
  // items were observed, so run.status is "failed" with persisted:true.
  const { describeRadarCollectResult } = await import("../src/lib/ai-radar-api.js");
  const real = describeRadarCollectResult({
    persisted: true,
    run: {
      id: "00000000-0000-4000-8000-000000000002",
      trigger: "manual",
      startedAt: "2026-09-02T01:00:00.000Z",
      finishedAt: "2026-09-02T01:00:01.000Z",
      status: "failed",
      localDate: "2026-09-02",
      timeZone: "Etc/UTC",
      repositoryCount: 0,
      errors: [{ code: "RADAR_DISCOVERY_FAILED", message: "discovery down" }],
      sequence: 1,
      collection: null,
    },
  });
  assert.equal(real.level, "failed");
  assert.match(real.message, /采集失败/);
  assert.match(real.message, /discovery down/);
});

test("describeRadarCollectResult flags a REAL collector total-failure as failed", async (t) => {
  // Do not hand-write the failure shape. Drive the actual createRadarCollector
  // against a temporary repository and a synthetic failing GitHub adapter so the
  // persisted:true + run.status:"failed" result passed to the UI interpreter is
  // the genuine collector output, not a fabricated response.
  const { createRadarRepository } = await import("../server/ai-radar/radar-repository.mjs");
  const { createRadarCollector } = await import("../server/ai-radar/radar-collector.mjs");
  const { mkdtemp, rm, realpath } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "radar-ui-collector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const timeZone = "Asia/Shanghai";
  const now = () => new Date("2026-09-02T16:30:00.000Z");
  const repository = createRadarRepository({ directory, now, timeZone });
  // Every discovery request throws, so the collector observes nothing but still
  // durably commits the failed run (persisted:true), matching real total failure.
  // A GITHUB_-prefixed code is what the real adapter produces and is preserved
  // through sanitization, so the surfaced message mirrors genuine output.
  const github = {
    async discoverCandidates() { throw { code: "GITHUB_NETWORK_ERROR", message: "GitHub could not be reached." }; },
    async getRepositories() { throw new Error("Unexpected detail work"); },
  };
  const collector = createRadarCollector({ github, repository, now, timeZone, focusAreas: ["agent"] });
  const result = await collector.collect({ trigger: "manual" });

  assert.equal(result.persisted, true, "the real collector durably commits the failed run");
  assert.equal(result.run.status, "failed", "nothing observed means the durable run is failed");

  const { describeRadarCollectResult } = await import("../src/lib/ai-radar-api.js");
  const outcome = describeRadarCollectResult(result);
  assert.equal(outcome.level, "failed");
  assert.match(outcome.message, /采集失败/);
  assert.match(outcome.message, /GitHub could not be reached/);
});

test("collect failure feedback renders and the page stays operable", async (t) => {
  const { container, renderSchedule } = await mountStatus(t, undefined, {
    actionErrors: { collect: "采集失败：AI Radar collection failed.", save: null },
    collectFeedback: null,
  });
  await renderSchedule({ enabled: true, time: "08:00", timeZone: "Etc/UTC" });

  assert.match(container.textContent, /采集失败：AI Radar collection failed\./);
  // Failure must not take the page down: manual collect and save remain usable.
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "立即采集"));
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "保存设置"));
  // Failed collection must not fake a successful status line.
  assert.doesNotMatch(container.textContent, /采集完成/);
});

test("collect success and partial feedback render as a non-error note", async (t) => {
  const { container, renderSchedule } = await mountStatus(t, undefined, {
    actionErrors: { collect: null, save: null },
    collectFeedback: { level: "partial", message: "部分成功：部分仓库未能采集，其余结果已保存。" },
  });
  await renderSchedule({ enabled: true, time: "08:00", timeZone: "Etc/UTC" });
  assert.match(container.textContent, /部分成功/);
});

test("collection completion refreshes the current filter, never the stale one; out-of-order B wins", async (t) => {
  const dayDash = deferred();
  const weekDeferreds = [deferred(), deferred()];
  let weekFetchCount = 0;
  const collect = deferred();

  const { container, entries, clickTab } = await mountPage(t, (path, options) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/ai-radar/collect") return collect.promise;
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    if (path === "/api/ai-radar?period=week") {
      const index = weekFetchCount;
      weekFetchCount += 1;
      const existing = weekDeferreds[index] ??= deferred();
      return existing.promise;
    }
    return jsonResponse({});
  });

  const weekDashB = (index) => weekDeferreds[index];

  // Filter A (day) starts collecting.
  await clickTab("立即采集");
  // Switch to filter B (week) while A's collection is still in flight.
  await clickTab("每周");

  // B's dashboard request resolves with B data.
  await act(async () => { weekDashB(0).resolve(jsonResponse(radarDashboard({ period: "week", marker: "weekrepo" }))); });
  await settle();
  assert.match(container.textContent, /weekrepo/);
  assert.doesNotMatch(container.textContent, /dayrepo/);

  // Collection ends with HTTP 200 success. The page must refresh the *current*
  // filter (week), issuing a fresh week dashboard request, not a stale day one.
  await act(async () => { collect.resolve(jsonResponse({ persisted: true, run: { status: "success" }, error: null })); });
  await settle();
  assert.ok(weekFetchCount >= 2, `expected a post-collect week refresh, got ${weekFetchCount} week fetches`);

  // The late stale A (day) response must never overwrite B.
  await act(async () => { weekDashB(1).resolve(jsonResponse(radarDashboard({ period: "week", marker: "weekrepo" }))); });
  await settle();
  await act(async () => { dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" }))); });
  await settle();

  // Final URL stays on week, and the visible card is B's, never A's.
  const activeTab = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-pressed") === "true");
  assert.equal(activeTab.textContent, "每周");
  assert.match(container.textContent, /weekrepo/);
  assert.doesNotMatch(container.textContent, /dayrepo/);
  const weekRequests = entries.filter((e) => e.path === "/api/ai-radar?period=week");
  assert.ok(weekRequests.length >= 2, "final request params must belong to B (week)");
});

test("pending filter change never shows the previous period's data under the new one", async (t) => {
  const dayDash = deferred();
  const weekDash = deferred();
  const { container, clickTab } = await mountPage(t, (path) => {
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    if (path === "/api/ai-radar?period=week") return weekDash.promise;
    return jsonResponse({});
  });

  // A (day) loads and renders.
  await act(async () => { dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" }))); });
  await settle();
  assert.match(container.textContent, /dayrepo/);

  // Switch to week while its response is still pending. The old day board must
  // not be repainted as the "week" board.
  await clickTab("每周");
  assert.doesNotMatch(container.textContent, /dayrepo/, "stale day board must not masquerade as the week board");
  assert.doesNotMatch(container.textContent, /weekrepo/);

  // Once B arrives, only B shows.
  await act(async () => { weekDash.resolve(jsonResponse(radarDashboard({ period: "week", marker: "weekrepo" }))); });
  await settle();
  assert.match(container.textContent, /weekrepo/);
  assert.doesNotMatch(container.textContent, /dayrepo/);
});

test("refreshing the same filter on failure keeps the last board, flags it stale and recovers on retry", async (t) => {
  // A same-filter refresh (e.g. after a mutation) can fail while old data still
  // exists. The board must survive, showing a refresh error, a stale marker and
  // a working retry — never a blank page pretending nothing went wrong.
  const dayDash = [deferred(), deferred(), deferred()];
  let dayFetchCount = 0;
  const collect = deferred();
  const { container } = await mountPage(t, (path, options) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/ai-radar/collect") return collect.promise;
    if (path === "/api/ai-radar?period=day") {
      const index = dayFetchCount;
      dayFetchCount += 1;
      return (dayDash[index] ??= deferred()).promise;
    }
    return jsonResponse({});
  });

  // Initial load succeeds and renders the board.
  await act(async () => { dayDash[0].resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" }))); });
  await settle();
  assert.match(container.textContent, /dayrepo/);

  // A mutation (collect) triggers a same-filter refresh, which then fails.
  await act(() => { [...container.querySelectorAll("button")].find((b) => b.textContent === "立即采集").click(); });
  await act(async () => { collect.resolve(jsonResponse({ persisted: true, run: { status: "success" }, error: null })); });
  await settle();
  await act(async () => { dayDash[1].reject(new Error("dashboard down")); });
  await settle();

  // The last good board stays visible; the failure is surfaced, not swallowed.
  assert.match(container.textContent, /dayrepo/, "old board must remain after a same-filter refresh failure");
  assert.match(container.textContent, /刷新失败/, "a refresh failure must not be hidden");
  assert.match(container.textContent, /可能不是最新/, "kept data must be flagged as stale");
  const refreshRetry = [...container.querySelectorAll("button")].find((b) => b.textContent === "重试");
  assert.ok(refreshRetry, "a retry action must be available on refresh failure");

  // Retry reloads the same filter successfully and clears the refresh error.
  await act(async () => { dayDash[2].resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo2" }))); });
  await act(() => refreshRetry.click());
  await settle();
  assert.doesNotMatch(container.textContent, /刷新失败/, "a successful retry clears the refresh error");
  assert.match(container.textContent, /dayrepo2/, "retry renders the freshly loaded board");
});

test("a failed first load with no cached board is a fatal error, not kept data", async (t) => {
  // When the very first load for the current filter fails with no cached board,
  // it must be a clear fatal empty state — not a silent wait or stale reuse.
  const dayDash = deferred();
  const { container } = await mountPage(t, (path, options) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    return jsonResponse({});
  });

  await act(async () => { dayDash.reject(new Error("radar unavailable")); });
  await settle();
  assert.match(container.textContent, /加载失败/);
  assert.match(container.textContent, /radar unavailable/);
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "重试"), "retry must be available on a fatal load failure");
});

test("status refresh failure keeps the last status, surfaces an error with retry and recovers", async (t) => {
  let statusCount = 0;
  const dayDash = deferred();
  const collect = deferred();
  const prefDash = deferred();
  const { container } = await mountPage(t, (path, options) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") {
      statusCount += 1;
      if (statusCount === 1) return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: "2026-09-02T01:00:00.000Z", nextRunAt: null, error: null });
      return Promise.reject(new Error("status down"));
    }
    if (path === "/api/ai-radar/preferences") return prefDash.promise;
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    return jsonResponse({});
  });

  await act(async () => {
    dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" })));
    prefDash.resolve(jsonResponse([]));
  });
  await settle();
  assert.match(container.textContent, /2026-09-02/, "last successful status must remain visible");

  // A refresh (after collection) re-fetches status, which then fails.
  await act(() => { [...container.querySelectorAll("button")].find((b) => b.textContent === "立即采集").click(); });
  await act(async () => { collect.resolve(jsonResponse({ persisted: true, run: { status: "success" }, error: null })); });
  await settle();
  await settle();
  assert.match(container.textContent, /状态刷新失败/, "a status refresh failure must not be hidden");
  assert.match(container.textContent, /status down/, "the status failure reason must be surfaced");
  assert.match(container.textContent, /2026-09-02/, "the last successful status values stay while flagged stale");
});

test("preferences refresh failure keeps last preferences, never fakes an empty list, and exposes retry", async (t) => {
  let prefFetchCount = 0;
  const dayDash = deferred();
  const collect = deferred();
  const statusDash = deferred();
  const prefFail = deferred();
  const { container } = await mountPage(t, (path, options) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") return statusDash.promise;
    if (path === "/api/ai-radar/preferences") {
      prefFetchCount += 1;
      if (prefFetchCount === 1) return jsonResponse([{ id: "11111111-2222-4333-8444-555555555555", repositoryId: null, kind: "topic", value: "agents", direction: "less", createdAt: "2026-09-02T01:00:00.000Z", revertedAt: null }]);
      return prefFail.promise;
    }
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    return jsonResponse({});
  });

  await act(async () => {
    dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" })));
    statusDash.resolve(jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null }));
  });
  await settle();
  assert.match(container.textContent, /类似主题：agents/, "last successful preferences stay visible");

  await act(() => { [...container.querySelectorAll("button")].find((b) => b.textContent === "立即采集").click(); });
  await act(async () => { collect.resolve(jsonResponse({ persisted: true, run: { status: "success" }, error: null })); });
  await settle();
  await act(async () => { prefFail.reject(new Error("prefs down")); });
  await settle();
  assert.match(container.textContent, /偏好.*失败|偏好读取失败/, "a preferences refresh failure must be surfaced");
  assert.match(container.textContent, /prefs down/, "the preferences failure reason must be surfaced");
});

test("preferences refresh failure keeps the last-success list visible alongside the error, and retry recovers", async (t) => {
  let prefFetchCount = 0;
  let failPrefs = false;
  const dayDash = deferred();
  const collect = deferred();
  const statusDash = deferred();
  const prefFail = deferred();
  const { container } = await mountPage(t, (path, options) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") return statusDash.promise;
    if (path === "/api/ai-radar/preferences") {
      prefFetchCount += 1;
      if (prefFetchCount === 1 || !failPrefs) return jsonResponse([{ id: "11111111-2222-4333-8444-555555555555", repositoryId: null, kind: "topic", value: "agents", direction: "less", createdAt: "2026-09-02T01:00:00.000Z", revertedAt: null }]);
      return prefFail.promise;
    }
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    return jsonResponse({});
  });

  await act(async () => {
    dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" })));
    statusDash.resolve(jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null }));
  });
  await settle();
  assert.match(container.textContent, /类似主题：agents/, "last successful preferences start visible");

  // A refresh (after collect) re-fetches preferences, which now fails while the
  // previous list still exists. The failure and the retained list must show
  // together — the list is never blanked by a failed refresh.
  failPrefs = true;
  await act(() => { [...container.querySelectorAll("button")].find((b) => b.textContent === "立即采集").click(); });
  await act(async () => { collect.resolve(jsonResponse({ persisted: true, run: { status: "success" }, error: null })); });
  await settle();
  await act(async () => { prefFail.reject(new Error("prefs down")); });
  await settle();

  assert.match(container.textContent, /推荐偏好读取失败|偏好读取失败/, "a preferences refresh failure must be surfaced");
  assert.match(container.textContent, /prefs down/, "the preferences failure reason must be surfaced");
  assert.match(container.textContent, /类似主题：agents/, "the last-success list must stay visible alongside the failure");
  assert.match(container.textContent, /正在显示上次成功数据/, "when data exists the kept-data claim applies");
  const retryBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "重试");
  assert.ok(retryBtn, "a retry action must be available on a preferences failure");

  // Retry re-fetches successfully and clears the error while the list remains.
  failPrefs = false;
  await act(() => retryBtn.click());
  await settle();
  assert.doesNotMatch(container.textContent, /推荐偏好读取失败|偏好读取失败|prefs down/, "a successful retry clears the preferences error");
  assert.match(container.textContent, /类似主题：agents/, "the list stays visible after recovery");
});

test("a failed first load of preferences with no prior data never claims last-success data", async (t) => {
  const dayDash = deferred();
  const statusDash = deferred();
  const prefFail = deferred();
  const { container } = await mountPage(t, (path, options) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") return statusDash.promise;
    if (path === "/api/ai-radar/preferences") return prefFail.promise;
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    return jsonResponse({});
  });

  await act(async () => {
    dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" })));
    statusDash.resolve(jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null }));
  });
  await act(async () => { prefFail.reject(new Error("prefs down")); });
  await settle();

  assert.match(container.textContent, /推荐偏好读取失败|偏好读取失败/, "the preferences failure must be surfaced");
  assert.match(container.textContent, /prefs down/, "the preference failure reason must be surfaced");
  // No prior data exists, so the page must not claim to be showing kept data.
  assert.doesNotMatch(container.textContent, /正在显示上次成功数据/, "must not claim kept data when there is none");
  // The honest empty state stays, never a fabricated list.
  assert.match(container.textContent, /暂无偏好|暂无/, "with no data the empty preferences state stays visible");
});

test("capability request failure keeps the radar conservative read-only, never silently writable", async (t) => {
  const dayDash = deferred();
  const capsFail = deferred();
  const { container } = await mountPage(t, (path, options) => {
    if (path === "/api/ai-radar/capabilities") return capsFail.promise;
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    return jsonResponse({});
  });
  await act(async () => { dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" }))); });
  await settle();
  await act(async () => { capsFail.reject(new Error("caps down")); });
  await settle();

  // A failed capability fetch must not let mutations fall back to writable.
  assert.match(container.textContent, /dayrepo/, "reads stay usable");
  assert.doesNotMatch(container.textContent, />立即采集</);
  assert.doesNotMatch(container.textContent, />保存设置</);
  assert.ok([...container.querySelectorAll("input")].some((i) => i.disabled), "mutations must stay disabled on a capability failure");
  assert.match(container.textContent, /无法确认雷达权限/, "the capability failure must be surfaced");
});

test("a pending capability response keeps mutations disabled until the server answers", async (t) => {
  const dayDash = deferred();
  const caps = deferred();
  const { container } = await mountPage(t, (path, options) => {
    if (path === "/api/ai-radar/capabilities") return caps.promise;
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    return jsonResponse({});
  });
  await act(async () => { dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" }))); });
  await settle();

  // While capabilities are unresolved the page must be conservative (disabled),
  // not optimistically writable.
  assert.equal([...container.querySelectorAll("button")].some((b) => b.textContent === "立即采集"), false, "mutations must be disabled while capability is pending");
  assert.ok([...container.querySelectorAll("input")].some((i) => i.disabled), "mutations must be disabled while capability is pending");

  // Once the server confirms writable, mutations become available.
  await act(async () => { caps.resolve(jsonResponse({ capabilities: { read: true, collect: true, schedule: true } })); });
  await settle();
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "立即采集"), "collect becomes available once capability confirms writable");
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "保存设置"), "schedule becomes available once capability confirms writable");
});

test("server radar capability (WORKBENCH_PROJECTS_READ_ONLY) disables page mutations even when Vault is writable", async (t) => {
  const dayDash = deferred();
  const { container } = await mountPage(t, (path) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: false, schedule: false } });
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    return jsonResponse({});
  });
  await act(async () => { dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" }))); });
  await settle();
  await settle();

  // The Vault is writable (import.meta.env.VITE_WORKBENCH_READ_ONLY is false),
  // yet the server capability says radar mutations are off: controls must hide
  // and reads must remain usable.
  assert.match(container.textContent, /dayrepo/);
  assert.doesNotMatch(container.textContent, />立即采集</);
  assert.doesNotMatch(container.textContent, />保存设置</);
  assert.ok([...container.querySelectorAll("input")].some((i) => i.disabled), "schedule inputs must be disabled in read-only radar");
  assert.ok(Boolean(container.querySelector("select")?.disabled), "schedule timezone select must be disabled in read-only radar");
  assert.doesNotMatch(container.textContent, /aria-label="收藏/);
  assert.doesNotMatch(container.textContent, /减少类似推荐/);
  assert.doesNotMatch(container.textContent, />撤销</);
  assert.doesNotMatch(container.textContent, />重置全部</);
});

const learningCapsFull = { read: true, create: true, edit: true, preview: true, confirm: true, activate: true, archive: true };

test("a pending or failed learning capability keeps 加入学习 disabled conservatively", async (t) => {
  const dayDash = deferred();
  const learningCaps = deferred();
  const { container } = await mountPage(t, (path) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/learning/capabilities") return learningCaps.promise;
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    return jsonResponse({});
  });
  await act(async () => { dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" }))); });
  await settle();

  // Pending learning capability: the join action stays hidden (conservative).
  assert.doesNotMatch(container.textContent, /加入学习/);

  // The server confirms a writable workspace: the join button becomes visible.
  await act(async () => { learningCaps.resolve(jsonResponse({ capabilities: learningCapsFull })); });
  await settle();
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent.trim() === "加入学习"), "join must appear once the capability confirms writable");
});

test("a failed learning capability disables 加入学习 and surfaces the reason with retry", async (t) => {
  const dayDash = deferred();
  const learningCaps = deferred();
  const { container } = await mountPage(t, (path) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/learning/capabilities") return learningCaps.promise;
    if (path === "/api/ai-radar?period=day") return dayDash.promise;
    return jsonResponse({});
  });
  await act(async () => { dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" }))); });
  await settle();
  await act(async () => { learningCaps.reject(new Error("learning caps down")); });
  await settle();

  assert.match(container.textContent, /dayrepo/);
  assert.equal([...container.querySelectorAll("button")].some((b) => b.textContent.trim() === "加入学习"), false, "join must stay hidden on a learning capability failure");
  assert.match(container.textContent, /无法确认学习权限/);
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "重试"), "the capability failure must offer a retry");
});

test("the radar page restores and re-queries the learning filter from the URL", async (t) => {
  const activeDash = deferred();
  const allDash = deferred();
  const requested = [];
  const { container } = await mountPage(t, (path) => {
    requested.push(path);
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/learning/capabilities") return jsonResponse({ capabilities: learningCapsFull });
    if (path === "/api/ai-radar?period=day&learning=active") return activeDash.promise;
    if (path === "/api/ai-radar?period=day") return allDash.promise;
    return jsonResponse({});
  }, ["/ai-radar?period=day&learning=active"]);
  await act(async () => { activeDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "activerepo" }))); });
  await settle();

  // The URL filter is restored into the dashboard query.
  assert.ok(requested.includes("/api/ai-radar?period=day&learning=active"), `learning filter must be passed through, got ${requested}`);
  assert.match(container.textContent, /activerepo/);

  // Changing the learning filter select re-queries with the new value.
  const select = container.querySelector('select[name="learning"]');
  await act(() => { select.value = "all"; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
  await act(async () => { allDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "allrepo" }))); });
  await settle();
  assert.ok(requested.filter((path) => path === "/api/ai-radar?period=day").length >= 1, "dropping the learning filter re-queries the plain dashboard");
  assert.match(container.textContent, /allrepo/);
  assert.doesNotMatch(container.textContent, /activerepo/);
});

test("joining learning from a card opens the draft dialog and a confirm closes it and refreshes", async (t) => {
  const dayFetches = [];
  let confirmed = false;
  const { container } = await mountPage(t, (path, options) => {
    if (path === "/api/ai-radar/capabilities") return jsonResponse({ capabilities: { read: true, collect: true, schedule: true } });
    if (path === "/api/ai-radar/status") return jsonResponse({ running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
    if (path === "/api/ai-radar/preferences") return jsonResponse([]);
    if (path === "/api/learning/capabilities") return jsonResponse({ capabilities: learningCapsFull });
    if (path === "/api/ai-radar?period=day") { dayFetches.push(1); return jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" })); }
    if (path === "/api/learning/drafts") return jsonResponse({ workspace: { workspaceId: "11111111-2222-4333-8444-555555555555", repositoryId: 101, fullName: "synthetic-lab/dayrepo", sourceUrl: "https://github.com/synthetic-lab/dayrepo", sourceCommitSha: "b".repeat(40), mission: { goal: "understand-architecture", notes: "" }, state: "draft", draftRevision: 1, createdAt: "2026-09-02T01:00:00.000Z", updatedAt: "2026-09-02T01:00:00.000Z" } });
    if (path === "/api/learning/11111111-2222-4333-8444-555555555555/preview") return jsonResponse({ token: "token.1", expiresAt: "2026-09-03T01:00:00.000Z", draftRevision: 1, sourceCommitSha: "b".repeat(40), mission: { goal: "understand-architecture", notes: "" }, repositoryId: 101, fullName: "synthetic-lab/dayrepo", sourceUrl: "https://github.com/synthetic-lab/dayrepo" });
    if (path === "/api/learning/confirm") {
      confirmed = true;
      return jsonResponse({ confirmed: "active", workspace: { workspaceId: "11111111-2222-4333-8444-555555555555", repositoryId: 101, fullName: "synthetic-lab/dayrepo", sourceUrl: "https://github.com/synthetic-lab/dayrepo", sourceCommitSha: "b".repeat(40), mission: { goal: "understand-architecture", notes: "" }, state: "active", draftRevision: 1, createdAt: "2026-09-02T01:00:00.000Z", updatedAt: "2026-09-02T01:00:00.000Z" } });
    }
    return jsonResponse({});
  });
  await settle();

  await act(() => [...container.querySelectorAll("button")].find((b) => b.textContent === "加入学习").click());
  await settle();
  assert.match(container.textContent, /加入学习/);
  assert.ok(container.querySelector(".learning-dialog"), "the draft dialog must open from the card");

  await act(() => [...container.querySelectorAll("button")].find((b) => b.textContent === "预览确认").click());
  await settle();
  await act(() => [...container.querySelectorAll("button")].find((b) => b.textContent === "确认加入学习").click());
  await settle();
  await settle();

  assert.equal(confirmed, true, "the confirm endpoint must be reached");
  assert.equal(container.querySelector(".learning-dialog"), null, "the dialog closes after a successful confirm");
  assert.ok(dayFetches.length >= 2, "the board refreshes after the joining flow");
});

// ---------------------------------------------------------------------------
// Task 8 — Overview daily picks
// ---------------------------------------------------------------------------
function relevantEntry(id, fullName, patch = {}) {
  return {
    repositoryId: id,
    repository: { fullName, htmlUrl: `https://github.com/${fullName}`, description: `Synthetic ${fullName}.`, language: "TypeScript", topics: ["agent"], license: "MIT", archived: false, fork: false, stars: 10 + id, pushedAt: null, updatedAt: null },
    currentStars: 10 + id,
    observedStarDelta: id,
    status: "incomplete",
    coverage: { observedDays: 1, expectedDays: 1, missingDays: 0, complete: true },
    reasons: [`synthetic ${fullName}`],
    decision: { status: "unread", updatedAt: null },
    ...patch,
  };
}

function relevantDashboard(count, { unread = count, stale = false } = {}) {
  const relevant = Array.from({ length: count }, (_, i) => relevantEntry(i + 1, `synthetic/radar-${i + 1}`));
  return {
    period: "day",
    timeZone: "Etc/UTC",
    localDate: "2026-09-02",
    filters: { state: "all", focus: "all" },
    counts: { all: count, unread, saved: 0, summarized: 0, queued: 0, learning: 0, completed: 0, ignored: 0 },
    eligibleCount: count,
    lists: { rising: [], established: [], relevant },
    freshness: { queriedAt: "2026-09-02T01:00:00.000Z", asOf: "2026-09-02T01:00:00.000Z", lastDataAt: "2026-09-02T01:00:00.000Z", lastSuccessAt: "2026-09-02T01:00:00.000Z", stale },
    coverage: null,
    retryAt: null,
    errors: [],
    run: null,
    schedule: null,
  };
}

test("overview projects at most three day/relevant picks preserving server order", () => {
  const model = overviewCompiled.exports.projectRadarOverview(relevantDashboard(6));
  assert.equal(model.cardCount, 3, "only three picks are projected");
  assert.deepEqual(model.cards.map((c) => c.fullName), ["synthetic/radar-1", "synthetic/radar-2", "synthetic/radar-3"], "server order is kept and capped at three");
  const html = overviewHtml(model);
  assert.match(html, /synthetic\/radar-1/);
  assert.match(html, /synthetic\/radar-3/);
  assert.doesNotMatch(html, /synthetic\/radar-4/);
});

test("overview shows fewer than three picks at their actual count, never fabricated", () => {
  const model = overviewCompiled.exports.projectRadarOverview(relevantDashboard(1));
  assert.equal(model.cardCount, 1, "one pick stays one pick");
  const html = overviewHtml(model);
  assert.match(html, /synthetic\/radar-1/);
  assert.doesNotMatch(html, /synthetic\/radar-2/);
});

test("overview empty state does not invent recommendations", () => {
  const model = overviewCompiled.exports.projectRadarOverview(relevantDashboard(0));
  assert.equal(model.empty, true);
  const html = overviewHtml(model);
  assert.match(html, /尚未积累/);
  assert.doesNotMatch(html, /synthetic\/radar/);
  assert.doesNotMatch(html, /repositoryId/);
  assert.doesNotMatch(html, /collection-empty">[\s\S]*synthetic/);
});

test("overview shows unread count, update time and a /ai-radar entry point", () => {
  const model = overviewCompiled.exports.projectRadarOverview(relevantDashboard(3, { unread: 5 }));
  assert.equal(model.unreadCount, 5);
  const html = overviewHtml(model);
  assert.match(html, /5 条未处理/);
  assert.match(html, /查看完整雷达/);
  assert.match(html, /更新于/);
});

test("overview only reads radar over GET and never triggers collection", async (t) => {
  const dash = deferred();
  const { entries } = await mountOverview(t, (path) => {
    if (path === "/api/ai-radar?period=day") return dash.promise;
    return jsonResponse({});
  });
  await act(async () => { dash.resolve(jsonResponse(relevantDashboard(2))); });
  await settle();
  assert.ok(entries.length >= 1, "the overview issues a radar read");
  let radarFetch = 0;
  for (const entry of entries) {
    assert.equal(entry.method, "GET", "overview must be read-only");
    if (entry.path.startsWith("/api/ai-radar")) radarFetch++;
  }
  assert.equal(radarFetch, 1, "one day/relevant read, no collect/schedule mutations");
});

test("overview keeps old picks when a refresh fails, flags them stale and recovers on retry", async (t) => {
  const deferreds = [deferred(), deferred(), deferred()];
  let fetchCount = 0;
  const { container } = await mountOverview(t, (path) => {
    if (path === "/api/ai-radar?period=day") {
      const idx = fetchCount;
      fetchCount += 1;
      return (deferreds[idx] ??= deferred()).promise;
    }
    return jsonResponse({});
  });

  // Initial load succeeds with three picks, no error.
  await act(async () => { deferreds[0].resolve(jsonResponse(relevantDashboard(3))); });
  await settle();
  assert.match(container.textContent, /synthetic\/radar-1/, "initial picks render");
  assert.doesNotMatch(container.textContent, /刷新失败|雷达数据加载失败/);

  // A refresh (visibility change) re-fetches and fails; old picks must remain.
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => { deferreds[1].reject(new Error("radar down")); });
  await settle();

  assert.match(container.textContent, /synthetic\/radar-1/, "old picks remain after a refresh failure");
  assert.match(container.textContent, /刷新失败/, "a refresh failure is surfaced");
  assert.match(container.textContent, /radar down/, "the failure reason is surfaced");
  assert.match(container.textContent, /可能不是最新/, "retained data is flagged stale");
  const retryBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "重试");
  assert.ok(retryBtn, "a retry action is available on refresh failure");

  // Retry reloads successfully and clears the error while picks stay visible.
  await act(() => retryBtn.click());
  await act(async () => { deferreds[2].resolve(jsonResponse(relevantDashboard(2, { unread: 2 }))); });
  await settle();
  assert.doesNotMatch(container.textContent, /刷新失败|radar down/, "a successful retry clears the refresh error");
  assert.match(container.textContent, /synthetic\/radar-1/, "picks reload after retry");
});

test("a failed first load of the overview radar is an explicit error, not a fake kept state", async (t) => {
  const fail = deferred();
  const { container } = await mountOverview(t, (path) => {
    if (path === "/api/ai-radar?period=day") return fail.promise;
    return jsonResponse({});
  });
  await act(async () => { fail.reject(new Error("radar unavailable")); });
  await settle();

  assert.match(container.textContent, /雷达数据加载失败/, "the first-load failure is explicit");
  assert.match(container.textContent, /radar unavailable/, "the reason is surfaced");
  assert.doesNotMatch(container.textContent, /正在显示上次成功数据/, "no kept data claim when nothing was ever loaded");
  assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "重试"), "retry is available on first-load failure");
});

test("overview radar panel is gated behind the local workbench build", async () => {
  const source = await readFile(new URL("../src/pages/OverviewPage.jsx", import.meta.url), "utf8");
  assert.match(source, /localWorkbench\s*=\s*import\.meta\.env\.VITE_WORKBENCH_HOSTED\s*!==\s*"true"/);
  assert.match(source, /\{localWorkbench \?\s*\(?[\s\S]*?<AiRadarOverview/);
  assert.match(source, /useRadarOverview\(\)/);
});
