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
async function mountPage(t, fetchImpl) {
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
    root.render(React.createElement(MemoryRouter, { initialEntries: ["/ai-radar?period=day"] }, React.createElement(pageCompiled.exports.AiRadarPage)));
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
  weekDashB(0).resolve(jsonResponse(radarDashboard({ period: "week", marker: "weekrepo" })));
  await settle();
  assert.match(container.textContent, /weekrepo/);
  assert.doesNotMatch(container.textContent, /dayrepo/);

  // Collection ends with HTTP 200 success. The page must refresh the *current*
  // filter (week), issuing a fresh week dashboard request, not a stale day one.
  collect.resolve(jsonResponse({ persisted: true, run: { status: "success" }, error: null }));
  await settle();
  assert.ok(weekFetchCount >= 2, `expected a post-collect week refresh, got ${weekFetchCount} week fetches`);

  // The late stale A (day) response must never overwrite B.
  weekDashB(1).resolve(jsonResponse(radarDashboard({ period: "week", marker: "weekrepo" })));
  await settle();
  dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" })));
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
  dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" })));
  await settle();
  assert.match(container.textContent, /dayrepo/);

  // Switch to week while its response is still pending. The old day board must
  // not be repainted as the "week" board.
  await clickTab("每周");
  assert.doesNotMatch(container.textContent, /dayrepo/, "stale day board must not masquerade as the week board");
  assert.doesNotMatch(container.textContent, /weekrepo/);

  // Once B arrives, only B shows.
  weekDash.resolve(jsonResponse(radarDashboard({ period: "week", marker: "weekrepo" })));
  await settle();
  assert.match(container.textContent, /weekrepo/);
  assert.doesNotMatch(container.textContent, /dayrepo/);
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
  dayDash.resolve(jsonResponse(radarDashboard({ period: "day", marker: "dayrepo" })));
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
