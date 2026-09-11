import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import React from "react";

const filename = fileURLToPath(new URL("./learning-ui-dialog.cjs", import.meta.url));
const result = await build({
  stdin: {
    contents: `
      export { LearningDraftDialog } from "../src/components/learning/LearningDraftDialog.jsx";
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

const window = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : typeof window[key] === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? window[key].bind(window) : window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const commitSha = (char) => char.repeat(40);
const uuid = (char) => char.repeat(8) + "-2222-4333-8444-555555555555";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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

function apiError(code, message, status) {
  return jsonResponse({ error: { code, message, status } }, status);
}

function draftWorkspace(overrides = {}) {
  return {
    workspaceId: uuid("1"),
    repositoryId: 101,
    fullName: "synthetic/repo-101",
    sourceUrl: "https://github.com/synthetic/repo-101",
    sourceCommitSha: commitSha("b"),
    mission: { goal: "learn-usage", notes: "Synthetic study task" },
    state: "draft",
    draftRevision: 1,
    createdAt: "2026-09-02T01:00:00.000Z",
    updatedAt: "2026-09-02T01:00:00.000Z",
    ...overrides,
  };
}

function previewPage(overrides = {}) {
  return {
    token: "synthetic.preview.token",
    expiresAt: "2026-09-03T01:00:00.000Z",
    draftRevision: 1,
    sourceCommitSha: commitSha("b"),
    mission: { goal: "learn-usage", notes: "Synthetic study task" },
    repositoryId: 101,
    fullName: "synthetic/repo-101",
    sourceUrl: "https://github.com/synthetic/repo-101",
    ...overrides,
  };
}

const repository = {
  repositoryId: 101,
  fullName: "synthetic/repo-101",
  htmlUrl: "https://github.com/synthetic/repo-101",
  description: "Synthetic demo repository",
  language: "JavaScript",
  license: "MIT",
};

// Writable server capability set. Declared before the top-level await imports
// below: node:test may start already-registered cases while a top-level import
// is still pending, so anything a case touches at runtime must already be a
// bound const before the first test() call.
const fullCaps = { read: true, create: true, edit: true, preview: true, confirm: true, activate: true, archive: true };

// Mounts LearningDraftDialog with a controllable fetch. `handlers` maps a
// path (without query) to a handler returning a Response-like object; every
// call is recorded for ordering assertions.
async function mountDialog(t, { props = {}, handlers = {} } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options = {}) => {
    const path = String(input).split("?")[0];
    calls.push({ method: options.method || "GET", path, body: options.body ? JSON.parse(options.body) : undefined });
    const handler = handlers[path] ?? handlers["*"];
    if (!handler) return Promise.reject(new Error(`unhandled fetch ${options.method} ${path}`));
    return Promise.resolve(handler({ path, method: options.method || "GET", options }));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => {
    root.render(React.createElement(compiled.exports.LearningDraftDialog, {
      repository,
      onClose: () => {},
      onDraftSaved: () => {},
      onConfirmed: () => {},
      onOpenWorkspace: () => {},
      // Default to a writable server capability set so existing tests keep
      // exercising the permitted path; capability-focused tests override it.
      capabilities: fullCaps,
      ...props,
    }));
  });
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  return { container, calls, root };
}

const button = (container, text) => [...container.querySelectorAll("button")].find((b) => b.textContent.trim().includes(text));
const selectGoal = async (container, value) => {
  const select = container.querySelector("select[name='goal']");
  await act(() => { select.value = value; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
};
const setNotes = async (container, notes) => {
  const textarea = container.querySelector("textarea[name='notes']");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(() => { setter.call(textarea, notes); textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
};

test("join flow creates the draft on open and edits go through the real PATCH contract", async (t) => {
  let created = false;
  const { container, calls } = await mountDialog(t, {
    handlers: {
      "/api/learning/drafts": () => { created = true; return jsonResponse({ workspace: draftWorkspace() }); },
      "/api/learning/1/revision": () => { throw new Error("must not be called"); },
      "/api/learning/11111111-2222-4333-8444-555555555555/draft": ({ options }) => {
        const body = JSON.parse(options.body);
        return jsonResponse({ workspace: draftWorkspace({ mission: body.mission, draftRevision: 2, updatedAt: "2026-09-02T01:05:00.000Z" }) });
      },
    },
  });
  await settle();
  // Create happened on open, exactly once, with the repository id.
  assert.deepEqual(calls[0], {
    method: "POST",
    path: "/api/learning/drafts",
    body: { repositoryId: 101, mission: { goal: "understand-architecture", notes: "" } },
  });
  assert.equal(created, true);

  await selectGoal(container, "analyze-design");
  await setNotes(container, "Focus on the retriever pipeline.");
  await act(() => button(container, "保存修改").click());
  await settle();

  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.path, "/api/learning/11111111-2222-4333-8444-555555555555/draft");
  assert.deepEqual(patch.body, { expectedRevision: 1, mission: { goal: "analyze-design", notes: "Focus on the retriever pipeline." } });
});

test("preview renders the server-returned source URL, fixed commit and full mission", async (t) => {
  const { container } = await mountDialog(t, {
    handlers: {
      "/api/learning/drafts": () => jsonResponse({ workspace: draftWorkspace() }),
      "/api/learning/11111111-2222-4333-8444-555555555555/preview": () => jsonResponse(previewPage()),
    },
  });
  await settle();
  await act(() => button(container, "预览确认").click());
  await settle();

  assert.match(container.textContent, /synthetic\/repo-101/);
  const sourceLink = container.querySelector(".learning-dialog__preview a");
  assert.equal(sourceLink?.getAttribute("href"), "https://github.com/synthetic/repo-101");
  assert.match(container.textContent, new RegExp("b".repeat(40)));
  assert.match(container.textContent, /学会使用/);
  assert.match(container.textContent, /Synthetic study task/);
  assert.ok(button(container, "确认加入学习"));
});

test("any edit after a preview invalidates confirm until a fresh preview", async (t) => {
  const previews = [];
  let savedMission = { goal: "learn-usage", notes: "Synthetic study task" };
  const { container, calls } = await mountDialog(t, {
    handlers: {
      "/api/learning/drafts": () => jsonResponse({ workspace: draftWorkspace() }),
      "/api/learning/11111111-2222-4333-8444-555555555555/draft": ({ options }) => {
        const body = JSON.parse(options.body);
        savedMission = body.mission;
        return jsonResponse({ workspace: draftWorkspace({ draftRevision: body.expectedRevision + 1, mission: body.mission }) });
      },
      "/api/learning/11111111-2222-4333-8444-555555555555/preview": () => {
        previews.push(previews.length + 1);
        return jsonResponse(previewPage({ token: `token.${previews.length}`, mission: savedMission }));
      },
    },
  });
  await settle();
  await act(() => button(container, "预览确认").click());
  await settle();
  // Confirm is enabled right after a fresh preview.
  assert.equal(button(container, "确认加入学习").disabled, false);

  // Editing the notes after preview must disable confirm: the old token is stale.
  await act(() => button(container, "返回编辑").click());
  await setNotes(container, "changed after preview");
  assert.equal(button(container, "确认加入学习"), undefined);
  assert.match(container.textContent, /需重新预览/);

  // A fresh preview re-enables confirm and uses the new token.
  await act(() => button(container, "预览确认").click());
  await settle();
  assert.equal(button(container, "确认加入学习").disabled, false);
  const confirms = calls.filter((call) => call.method === "POST" && call.path === "/api/learning/confirm");
  assert.equal(confirms.length, 0);
  assert.equal(previews.length, 2);
});

test("confirm disables the button while pending, then reports the outcome once", async (t) => {
  const gate = deferred();
  const confirmed = [];
  const { container, calls } = await mountDialog(t, {
    props: { onConfirmed: (workspace, outcome) => confirmed.push({ workspace, outcome }) },
    handlers: {
      "/api/learning/drafts": () => jsonResponse({ workspace: draftWorkspace() }),
      "/api/learning/11111111-2222-4333-8444-555555555555/preview": () => jsonResponse(previewPage()),
      "/api/learning/confirm": () => gate.promise.then(() => jsonResponse({ confirmed: "active", workspace: draftWorkspace({ state: "active" }) })),
    },
  });
  await settle();
  await act(() => button(container, "预览确认").click());
  await settle();

  const confirmButton = button(container, "确认加入学习");
  await act(() => confirmButton.click());
  // While pending the button is disabled so a double click cannot fire twice.
  const pending = [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === "确认中…");
  assert.ok(pending, "confirm button should show 确认中… while pending");
  assert.equal(pending.disabled, true);
  await act(async () => { gate.resolve(); await gate.promise.catch(() => {}); });
  await settle();

  assert.equal(calls.filter((call) => call.path === "/api/learning/confirm").length, 1);
  assert.deepEqual(confirmed, [{ workspace: draftWorkspace({ state: "active" }), outcome: "active" }]);
  assert.match(container.textContent, /已加入学习/);
});

test("a lost confirm response recovers idempotently without creating duplicates", async (t) => {
  let first = true;
  const created = [];
  const { container, calls } = await mountDialog(t, {
    handlers: {
      "/api/learning/drafts": ({ options }) => { created.push(JSON.parse(options.body)); return jsonResponse({ workspace: draftWorkspace() }); },
      "/api/learning/11111111-2222-4333-8444-555555555555/preview": () => jsonResponse(previewPage()),
      "/api/learning/confirm": () => jsonResponse({ confirmed: "active", workspace: draftWorkspace({ state: "active" }) }, first ? 0 : 200),
    },
  });
  await settle();
  await act(() => button(container, "预览确认").click());
  await settle();
  await act(() => button(container, "确认加入学习").click());
  await settle();

  // The first confirm response was lost (non-JSON error): the dialog must not
  // claim success or create anything new; it offers an idempotent retry.
  assert.match(container.textContent, /结果未收到|无法确认/);
  first = false;
  await act(() => button(container, "重试确认").click());
  await settle();

  assert.equal(calls.filter((call) => call.path === "/api/learning/confirm").length, 2);
  assert.equal(created.length, 1);
  assert.match(container.textContent, /已加入学习/);
});

test("editing an existing draft skips creation and patches from its revision", async (t) => {
  const existing = draftWorkspace({ draftRevision: 3, mission: { goal: "understand-architecture", notes: "existing" } });
  const { container, calls } = await mountDialog(t, {
    props: { workspace: existing },
    handlers: {
      "/api/learning/11111111-2222-4333-8444-555555555555/draft": ({ options }) => {
        const body = JSON.parse(options.body);
        return jsonResponse({ workspace: draftWorkspace({ draftRevision: body.expectedRevision + 1, mission: body.mission }) });
      },
    },
  });
  await settle();
  // No create call happened for an existing draft.
  assert.equal(calls.some((call) => call.path === "/api/learning/drafts"), false);
  assert.match(container.textContent, /understand-architecture|理解架构/);
  await setNotes(container, "updated notes");
  await act(() => button(container, "保存修改").click());
  await settle();
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body, { expectedRevision: 3, mission: { goal: "understand-architecture", notes: "updated notes" } });
});

test("a failed create keeps the dialog recoverable with retry and never fabricates a workspace", async (t) => {
  let attempts = 0;
  const { container, calls } = await mountDialog(t, {
    handlers: {
      "*": () => {
        attempts += 1;
        if (attempts === 1) return apiError("LEARNING_GITHUB_UNAVAILABLE", "无法读取仓库最新提交，请稍后重试。", 503);
        return jsonResponse({ workspace: draftWorkspace() });
      },
    },
  });
  await settle();
  assert.match(container.textContent, /无法读取仓库最新提交/);
  assert.match(container.textContent, /重试/);
  await act(() => button(container, "重试").click());
  await settle();
  assert.equal(calls.filter((call) => call.path === "/api/learning/drafts").length, 2);
  assert.ok(button(container, "预览确认"));
});

// LearningPage harness --------------------------------------------------------

const pageFilename = fileURLToPath(new URL("./learning-ui-page.cjs", import.meta.url));
const pageBuild = await build({
  stdin: {
    contents: `
      export { LearningPage } from "../src/pages/LearningPage.jsx";
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

const { createMemoryRouter, RouterProvider, MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");

function learningWorkspace(overrides = {}) {
  const id = overrides.workspaceId ?? uuid("7");
  const repositoryId = overrides.repositoryId ?? 201;
  return {
    workspaceId: id,
    repositoryId,
    fullName: `synthetic/repo-${repositoryId}`,
    sourceUrl: `https://github.com/synthetic/repo-${repositoryId}`,
    sourceCommitSha: commitSha("c"),
    mission: { goal: "learn-usage", notes: "Synthetic learning notes" },
    state: "draft",
    draftRevision: 1,
    createdAt: "2026-09-02T01:00:00.000Z",
    updatedAt: "2026-09-02T01:00:00.000Z",
    ...overrides,
  };
}

const learningCaps = { read: true, create: true, edit: true, preview: true, confirm: true, activate: true, archive: true };

async function mountLearningPage(t, { initialEntries = ["/learning"], handlers = {} } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options = {}) => {
    const path = String(input).split("?")[0];
    calls.push({ method: options.method || "GET", path, body: options.body ? JSON.parse(options.body) : undefined });
    const handler = handlers[path] ?? handlers["*"];
    if (!handler) return Promise.reject(new Error(`unhandled fetch ${options.method} ${path}`));
    return Promise.resolve(handler({ path, method: options.method || "GET", options }));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = createMemoryRouter(
    [
      { path: "/learning", element: React.createElement(pageCompiled.exports.LearningPage) },
      { path: "/learning/:workspaceId", element: React.createElement(pageCompiled.exports.LearningPage) },
    ],
    { initialEntries },
  );
  await act(() => {
    root.render(React.createElement(RouterProvider, { router }));
  });
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  return { container, calls, root, router };
}

test("the learning page groups workspaces by state, never clips entries and states the scope honestly", async (t) => {
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({
      workspaces: [
        learningWorkspace({ workspaceId: uuid("1"), state: "draft", repositoryId: 201 }),
        learningWorkspace({ workspaceId: uuid("2"), state: "queued", repositoryId: 202 }),
        learningWorkspace({ workspaceId: uuid("3"), state: "active", repositoryId: 203 }),
        learningWorkspace({ workspaceId: uuid("4"), state: "archived", repositoryId: 204, mission: { goal: "adoption-decision", notes: "archived notes" } }),
      ],
    }),
  };
  const { container } = await mountLearningPage(t, { handlers: anchors });
  await settle();

  assert.match(container.textContent, /任务草稿/);
  assert.match(container.textContent, /排队中/);
  assert.match(container.textContent, /学习中/);
  assert.match(container.textContent, /学习已归档/);
  // Every returned workspace is visible: no clipping.
  assert.ok(container.textContent.includes("synthetic/repo-201"));
  assert.ok(container.textContent.includes("synthetic/repo-202"));
  assert.ok(container.textContent.includes("synthetic/repo-203"));
  assert.ok(container.textContent.includes("synthetic/repo-204"));
  // Scope honesty: it is a learning-task workspace without course/completion UI.
  assert.match(container.textContent, /学习任务工作区|尚无课程|学习任务/);
  assert.doesNotMatch(container.textContent, /进度%/);
  const buttons = [...container.querySelectorAll("button")].map((entry) => entry.textContent);
  assert.equal(buttons.some((text) => /课程|测验|完成学习/.test(text)), false);
});

test("more than three active workspaces render fully with a data-anomaly notice", async (t) => {
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({
      workspaces: [1, 2, 3, 4].map((index) => learningWorkspace({ workspaceId: uuid(String(index)), state: "active", repositoryId: 200 + index })),
    }),
  };
  const { container } = await mountLearningPage(t, { handlers: anchors });
  await settle();

  assert.match(container.textContent, /服务端.*3 个活跃/);
  for (const index of [1, 2, 3, 4]) {
    assert.ok(container.textContent.includes(`synthetic/repo-${200 + index}`), `repo 20${index} must stay visible`);
  }
});

test("activating at full capacity surfaces ACTIVE_LIMIT_REACHED and keeps the queued entry", async (t) => {
  const activateCalls = [];
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({
      workspaces: [
        learningWorkspace({ workspaceId: uuid("1"), state: "active", repositoryId: 201 }),
        learningWorkspace({ workspaceId: uuid("2"), state: "active", repositoryId: 202 }),
        learningWorkspace({ workspaceId: uuid("3"), state: "active", repositoryId: 203 }),
        learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208, draftRevision: 4 }),
      ],
    }),
    "/api/learning/88888888-2222-4333-8444-555555555555/activate": ({ options }) => {
      activateCalls.push(JSON.parse(options.body));
      // The server keeps the workspace queued and returns the explicit outcome.
      return jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208, draftRevision: 4 }), outcome: "ACTIVE_LIMIT_REACHED" });
    },
  };
  const { container } = await mountLearningPage(t, { handlers: anchors });
  await settle();

  await act(() => button(container, "激活").click());
  await settle();

  assert.deepEqual(activateCalls, [{ expectedRevision: 4 }]);
  assert.match(container.textContent, /3 个活跃/);
  assert.ok(container.textContent.includes("synthetic/repo-208"));
  // The queued entry stays in the queue section with its activate action.
  assert.ok(button(container, "激活"));
});

test("archive sends the idempotent call and refreshes the list", async (t) => {
  let state = "active";
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({
      workspaces: [learningWorkspace({ workspaceId: uuid("3"), state, repositoryId: 203 })],
    }),
    "/api/learning/33333333-2222-4333-8444-555555555555/archive": () => {
      state = "archived";
      return jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("3"), state: "archived", repositoryId: 203 }) });
    },
  };
  const { container, calls } = await mountLearningPage(t, { handlers: anchors });
  await settle();

  await act(() => button(container, "归档").click());
  await settle();

  assert.equal(calls.some((call) => call.method === "POST" && call.path === "/api/learning/33333333-2222-4333-8444-555555555555/archive"), true);
  assert.match(container.textContent, /学习已归档/);
  assert.match(container.textContent, /已归档/);
});

test("mutation success followed by a refresh failure keeps data and never reports the action failed", async (t) => {
  let activateDone = false;
  let refreshFail = false;
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => {
      if (refreshFail) return Promise.reject(new TypeError("network down"));
      if (!activateDone) {
        return jsonResponse({ workspaces: [learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208 })] });
      }
      return jsonResponse({ workspaces: [learningWorkspace({ workspaceId: uuid("8"), state: "active", repositoryId: 208 })] });
    },
    "/api/learning/88888888-2222-4333-8444-555555555555/activate": () => {
      activateDone = true;
      return jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state: "active", repositoryId: 208 }), outcome: "active" });
    },
  };
  const { container } = await mountLearningPage(t, { handlers: anchors });
  await settle();

  // The refresh for this activation will fail even though the mutation succeeds.
  refreshFail = true;
  await act(() => button(container, "激活").click());
  await settle();

  // The success notice rendered; the page keeps the last good list and marks
  // it stale instead of reporting the activated action itself as failed.
  assert.match(container.textContent, /已激活/);
  assert.match(container.textContent, /上次成功数据|刷新失败|可能不是最新/);
  assert.doesNotMatch(container.textContent, /激活失败/);
});

test("the detail page shows source, fixed commit, goal, notes, state and allowed actions", async (t) => {
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [] }),
    "/api/learning/22222222-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("2"), state: "draft", repositoryId: 202, mission: { goal: "analyze-design", notes: "Understand the retriever tradeoffs." }, draftRevision: 3 }),
    }),
  };
  const { container } = await mountLearningPage(t, { initialEntries: ["/learning/22222222-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();

  assert.match(container.textContent, /synthetic\/repo-202/);
  assert.match(container.textContent, new RegExp(commitSha("c")));
  assert.match(container.textContent, /分析设计/);
  assert.match(container.textContent, /Understand the retriever tradeoffs\./);
  assert.match(container.textContent, /草稿/);
  assert.ok(button(container, "编辑任务"));
  assert.ok(button(container, "归档"));

  // A queued workspace offers activation instead of editing.
  const queued = await mountLearningPage(t, { initialEntries: ["/learning/33333333-2222-4333-8444-555555555555"], handlers: {
    ...anchors,
    "/api/learning/33333333-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("3"), state: "queued", repositoryId: 203 }),
    }),
  } });
  await settle();
  assert.ok(button(queued.container, "激活"));
  assert.equal(button(queued.container, "编辑任务"), undefined);
});

test("navigating to another workspace never shows the previous workspace's data", async (t) => {
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [] }),
    "/api/learning/44444444-2222-4333-8444-555555555555": () => jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("4"), repositoryId: 204, fullName: "synthetic/repo-204" }) }),
    "/api/learning/55555555-2222-4333-8444-555555555555": () => jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("5"), repositoryId: 205, fullName: "synthetic/repo-205" }) }),
  };
  const { container, router } = await mountLearningPage(t, { initialEntries: ["/learning/44444444-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();
  assert.ok(container.textContent.includes("synthetic/repo-204"));

  // Navigate to another workspace in the same mounted router: the previous
  // workspace's content must not leak into the new view.
  await act(() => router.navigate("/learning/55555555-2222-4333-8444-555555555555"));
  await settle();
  assert.ok(container.textContent.includes("synthetic/repo-205"));
  assert.doesNotMatch(container.textContent, /repo-204/);
});

// Step 16 regressions: detail-page operation errors, shared mutex, request
// ordering, capability fields, confirm recovery and unmount safety. Each test
// targets a real defect found while hardening the S3 UI ----------------------

test("detail activation failure is visible with retry and the queued entry stays", async (t) => {
  let state = "queued";
  const activateCalls = [];
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [] }),
    "/api/learning/88888888-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("8"), state, repositoryId: 208, draftRevision: 4 }),
    }),
    "/api/learning/88888888-2222-4333-8444-555555555555/activate": ({ options }) => {
      activateCalls.push(JSON.parse(options.body));
      if (!state || state === "queued" && activateCalls.length === 1) {
        // First attempt fails at the server; the workspace stays queued.
        return apiError("LEARNING_INTERNAL_ERROR", "学习服务暂时不可用，请稍后重试。", 500);
      }
      state = "active";
      return jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state: "active", repositoryId: 208 }), outcome: "active" });
    },
  };
  const { container } = await mountLearningPage(t, { initialEntries: ["/learning/88888888-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();
  assert.ok(button(container, "激活"));

  await act(() => button(container, "激活").click());
  await settle();

  // The failure is visible on the detail page and the workspace stays queued
  // with its original data and a retry entry.
  assert.match(container.textContent, /学习服务暂时不可用/);
  assert.match(container.textContent, /排队/);
  assert.ok(button(container, "重试激活"), "a retry entry must appear after a failed activation");
  assert.ok(button(container, "归档"), "the queued entry keeps its other actions");

  await act(() => button(container, "重试激活").click());
  await settle();

  // The retry succeeded: the old error is gone, the notice reflects success
  // and the detail shows the active state.
  assert.equal(activateCalls.length, 2);
  assert.doesNotMatch(container.textContent, /学习服务暂时不可用|激活失败/);
  assert.match(container.textContent, /已激活/);
  assert.match(container.textContent, /学习中/);
});

test("detail archive failure is visible and the original content stays", async (t) => {
  let state = "active";
  const archiveCalls = [];
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [] }),
    "/api/learning/33333333-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("3"), state, repositoryId: 203, mission: { goal: "analyze-design", notes: "Original notes that must survive a failed archive." } }),
    }),
    "/api/learning/33333333-2222-4333-8444-555555555555/archive": () => {
      archiveCalls.push(1);
      if (archiveCalls.length === 1) return apiError("LEARNING_STORAGE_CORRUPT", "学习存储异常，归档未执行。", 500);
      state = "archived";
      return jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("3"), state: "archived", repositoryId: 203, mission: { goal: "analyze-design", notes: "Original notes that must survive a failed archive." } }) });
    },
  };
  const { container } = await mountLearningPage(t, { initialEntries: ["/learning/33333333-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();
  assert.ok(button(container, "归档学习"));

  await act(() => button(container, "归档学习").click());
  await settle();

  // Failure visible; the original workspace content and state are retained.
  assert.match(container.textContent, /学习存储异常/);
  assert.ok(container.textContent.includes("Original notes that must survive a failed archive."));
  assert.ok(container.textContent.includes(commitSha("c")));
  assert.match(container.textContent, /学习中/);
  assert.ok(button(container, "重试归档"), "a retry entry must appear after a failed archive");

  await act(() => button(container, "重试归档").click());
  await settle();
  assert.equal(archiveCalls.length, 2);
  assert.match(container.textContent, /学习已归档/);
  assert.doesNotMatch(container.textContent, /学习存储异常/);
});

test("rapid repeated clicks on activate never produce duplicate requests", async (t) => {
  const gate = deferred();
  const calls = [];
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [] }),
    "/api/learning/88888888-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208, draftRevision: 4 }),
    }),
    "/api/learning/88888888-2222-4333-8444-555555555555/activate": () => {
      calls.push(1);
      return gate.promise.then(() => jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state: "active", repositoryId: 208 }), outcome: "active" }));
    },
  };
  const { container } = await mountLearningPage(t, { initialEntries: ["/learning/88888888-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();

  // Two clicks land in the same act, before any re-render can disable the
  // button: the handler itself must reject the duplicate submission.
  await act(() => {
    button(container, "激活").click();
    button(container, "激活").click();
  });
  assert.equal(calls.length, 1, "the second click must not fire a second request");
  await act(async () => { gate.resolve(); await gate.promise.catch(() => {}); });
  await settle();
  assert.equal(calls.length, 1);
  assert.match(container.textContent, /已激活/);
});

test("activation and archiving share the mutex on the detail page", async (t) => {
  const gate = deferred();
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [] }),
    "/api/learning/88888888-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208, draftRevision: 4 }),
    }),
    "/api/learning/88888888-2222-4333-8444-555555555555/activate": () => gate.promise.then(() => jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state: "active", repositoryId: 208 }), outcome: "active" })),
    "/api/learning/88888888-2222-4333-8444-555555555555/archive": () => jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state: "archived", repositoryId: 208 }) }),
  };
  const { container } = await mountLearningPage(t, { initialEntries: ["/learning/88888888-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();

  // While activation is pending the archive action is disabled (conflict).
  await act(() => button(container, "激活").click());
  assert.ok([...container.querySelectorAll("button")].find((b) => b.textContent.trim() === "激活中…"));
  assert.equal(button(container, "归档（退出队列）").disabled, true, "archive must be disabled while activation is pending");
  await act(async () => { gate.resolve(); await gate.promise.catch(() => {}); });
  await settle();
  assert.equal(button(container, "归档（退出队列）").disabled, false);

  // And the reverse: while archiving is pending activation is disabled.
  const gate2 = deferred();
  const anchors2 = {
    ...anchors,
    "/api/learning/88888888-2222-4333-8444-555555555555/archive": () => gate2.promise.then(() => jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state: "archived", repositoryId: 208 }) })),
  };
  const { container: container2 } = await mountLearningPage(t, { initialEntries: ["/learning/88888888-2222-4333-8444-555555555555"], handlers: anchors2 });
  await settle();
  await act(() => button(container2, "归档（退出队列）").click());
  assert.equal(button(container2, "激活").disabled, true, "activate must be disabled while archiving is pending");
  await act(async () => { gate2.resolve(); await gate2.promise.catch(() => {}); });
  await settle();
});

test("detail mutation success followed by a refresh failure stays distinguishable from the action failing", async (t) => {
  let detailCalls = 0;
  let refreshFail = false;
  let state = "queued";
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => {
      if (refreshFail) return Promise.reject(new TypeError("network down"));
      return jsonResponse({ workspaces: [] });
    },
    "/api/learning/88888888-2222-4333-8444-555555555555": () => {
      detailCalls += 1;
      if (refreshFail && detailCalls > 1) return Promise.reject(new TypeError("network down"));
      return jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state, repositoryId: 208, draftRevision: 4 }) });
    },
    "/api/learning/88888888-2222-4333-8444-555555555555/activate": () => {
      state = "active";
      return jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state: "active", repositoryId: 208 }), outcome: "active" });
    },
  };
  const { container } = await mountLearningPage(t, { initialEntries: ["/learning/88888888-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();

  refreshFail = true;
  await act(() => button(container, "激活").click());
  await settle();

  // The action succeeded; the failed refresh is surfaced separately: success
  // notice plus a stale/refresh marker, never "激活失败".
  assert.match(container.textContent, /已激活/);
  assert.match(container.textContent, /刷新失败|上次成功数据/);
  assert.doesNotMatch(container.textContent, /激活失败/);
});
// Part 2: request ordering and lifecycle invalidation --------------------------

function RemountingLearningPage() {
  const location = useLocation();
  // The real app renders <Routes key={pathname:revision}>, so every pathname
  // change unmounts and remounts the page. Emulate that per-path remount so a
  // route switch really creates a fresh component instance.
  return React.createElement(pageCompiled.exports.LearningPage, { key: `${location.pathname}` });
}

test("same detail: an older GET arriving last never overwrites the refreshed state", async (t) => {
  let detailCalls = 0;
  const firstGet = deferred();
  const secondGet = deferred();
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [] }),
    "/api/learning/88888888-2222-4333-8444-555555555555": () => {
      detailCalls += 1;
      if (detailCalls === 1) {
        return firstGet.promise.then(() => jsonResponse({
          workspace: learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208, mission: { goal: "learn-usage", notes: "old payload" } }),
        }));
      }
      return secondGet.promise.then(() => jsonResponse({
        workspace: learningWorkspace({ workspaceId: uuid("8"), state: "active", repositoryId: 208, mission: { goal: "learn-usage", notes: "fresh payload" } }),
      }));
    },
  };
  const { container, router } = await mountLearningPage(t, { initialEntries: ["/learning/88888888-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();
  // The first GET is still in flight: no content yet.
  assert.match(container.textContent, /正在读取/);

  // A second GET for the SAME id (leave the detail, come back) resolves first.
  await act(() => router.navigate("/learning"));
  await settle();
  await act(() => router.navigate("/learning/88888888-2222-4333-8444-555555555555"));
  await settle();
  await act(async () => { secondGet.resolve(); await secondGet.promise.catch(() => {}); });
  await settle();
  assert.match(container.textContent, /fresh payload/);
  assert.match(container.textContent, /学习中/);

  // The OLD response arrives last: it must not overwrite the fresh state.
  await act(async () => { firstGet.resolve(); await firstGet.promise.catch(() => {}); });
  await settle();
  assert.match(container.textContent, /fresh payload/);
  assert.match(container.textContent, /学习中/);
  assert.doesNotMatch(container.textContent, /old payload|排队/);
});

test("navigating A to B and back to A keeps the second A request authoritative over a late first-A response", async (t) => {
  let aCalls = 0;
  const firstAGet = deferred();
  const secondAGet = deferred();
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [] }),
    "/api/learning/88888888-2222-4333-8444-555555555555": () => {
      aCalls += 1;
      if (aCalls === 1) {
        return firstAGet.promise.then(() => jsonResponse({
          workspace: learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208, mission: { goal: "learn-usage", notes: "first A payload" } }),
        }));
      }
      return secondAGet.promise.then(() => jsonResponse({
        workspace: learningWorkspace({ workspaceId: uuid("8"), state: "active", repositoryId: 208, mission: { goal: "learn-usage", notes: "second A payload" } }),
      }));
    },
    "/api/learning/55555555-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("5"), state: "draft", repositoryId: 205, mission: { goal: "analyze-design", notes: "workspace B notes" } }),
    }),
  };
  const { container, router } = await mountLearningPage(t, { initialEntries: ["/learning/88888888-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();
  assert.match(container.textContent, /正在读取/);

  await act(() => router.navigate("/learning/55555555-2222-4333-8444-555555555555"));
  await settle();
  assert.match(container.textContent, /workspace B notes/);

  await act(() => router.navigate("/learning/88888888-2222-4333-8444-555555555555"));
  await settle();
  await act(async () => { secondAGet.resolve(); await secondAGet.promise.catch(() => {}); });
  await settle();
  assert.match(container.textContent, /second A payload/);

  // The FIRST A request finishes last: it must not regress the second A state.
  await act(async () => { firstAGet.resolve(); await firstAGet.promise.catch(() => {}); });
  await settle();
  assert.match(container.textContent, /second A payload/);
  assert.match(container.textContent, /学习中/);
  assert.doesNotMatch(container.textContent, /first A payload|排队/);
});

test("two list refreshes arriving out of order keep the latest result", async (t) => {
  let listCalls = 0;
  let listState = "queued";
  const firstList = deferred();
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => {
      listCalls += 1;
      if (listCalls === 1) {
        return firstList.promise.then(() => jsonResponse({ workspaces: [learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208 })] }));
      }
      return jsonResponse({ workspaces: [learningWorkspace({ workspaceId: uuid("8"), state: "archived", repositoryId: 208 })] });
    },
    "/api/learning/88888888-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("8"), state: listState, repositoryId: 208 }),
    }),
    "/api/learning/88888888-2222-4333-8444-555555555555/archive": () => {
      listState = "archived";
      return jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state: "archived", repositoryId: 208 }) });
    },
  };
  const { container, router } = await mountLearningPage(t, { initialEntries: ["/learning"], handlers: anchors });
  await settle();

  // The first list load is still in flight; archive on the detail page
  // triggers a second, fresh list load.
  await act(() => router.navigate("/learning/88888888-2222-4333-8444-555555555555"));
  await settle();
  await act(() => button(container, "归档（退出队列）").click());
  await settle();
  await act(() => router.navigate("/learning"));
  await settle();
  assert.match(container.textContent, /学习已归档/);

  // The OLD list response (queued) arrives last and must be dropped.
  await act(async () => { firstList.resolve(); await firstList.promise.catch(() => {}); });
  await settle();
  assert.match(container.textContent, /学习已归档/);
  assert.equal([...container.querySelectorAll(".learning-section__title")].some((title) => /排队/.test(title.textContent)), false, "the stale queued list must not replace the archived list");
});

test("a pending activation completing after switching to another detail never touches the new workspace", async (t) => {
  const gate = deferred();
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [] }),
    "/api/learning/88888888-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208 }),
    }),
    "/api/learning/55555555-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("5"), state: "draft", repositoryId: 205, mission: { goal: "analyze-design", notes: "workspace B notes" } }),
    }),
    "/api/learning/88888888-2222-4333-8444-555555555555/activate": () => gate.promise.then(() => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("8"), state: "active", repositoryId: 208 }), outcome: "active",
    })),
  };
  const { container, router } = await mountLearningPage(t, { initialEntries: ["/learning/88888888-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();

  await act(() => button(container, "激活").click());
  assert.ok(button(container, "激活中…"));
  // Switch to B while A's activation is still pending.
  await act(() => router.navigate("/learning/55555555-2222-4333-8444-555555555555"));
  await settle();
  assert.match(container.textContent, /workspace B notes/);

  await act(async () => { gate.resolve(); await gate.promise.catch(() => {}); });
  await settle();

  // A's completion must not change B's detail, its loading state or notices.
  assert.match(container.textContent, /workspace B notes/);
  assert.match(container.textContent, /草稿/);
  assert.doesNotMatch(container.textContent, /已激活|激活失败|正在读取/);
});

test("real route remount: leaving the detail unmounts it, so a late response cannot reach the next workspace", async (t) => {
  const firstGet = deferred();
  const aCalls = [];
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options = {}) => {
    const path = String(input).split("?")[0];
    calls.push({ method: options.method || "GET", path });
    const handler = {
      "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
      "/api/learning": () => jsonResponse({ workspaces: [] }),
      "/api/learning/44444444-2222-4333-8444-555555555555": () => {
        aCalls.push(1);
        return firstGet.promise.then(() => jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("4"), repositoryId: 204, fullName: "synthetic/repo-204" }) }));
      },
      "/api/learning/55555555-2222-4333-8444-555555555555": () => jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("5"), repositoryId: 205, fullName: "synthetic/repo-205" }) }),
    }[path];
    if (!handler) return Promise.reject(new Error(`unhandled ${path}`));
    return Promise.resolve(handler({ path, method: options.method || "GET" }));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = createMemoryRouter(
    [
      { path: "/learning", element: React.createElement(RemountingLearningPage) },
      { path: "/learning/:workspaceId", element: React.createElement(RemountingLearningPage) },
    ],
    { initialEntries: ["/learning/44444444-2222-4333-8444-555555555555"] },
  );
  await act(() => { root.render(React.createElement(RouterProvider, { router })); });
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await settle();
  assert.equal(aCalls.length, 1, "the first mount requests the first detail");

  // Navigate to B: the real-app key remount creates a fresh page instance.
  await act(() => router.navigate("/learning/55555555-2222-4333-8444-555555555555"));
  await settle();
  assert.match(container.textContent, /synthetic\/repo-205/);

  // The old mount's response lands after its unmount: it must not reach B.
  await act(async () => { firstGet.resolve(); await firstGet.promise.catch(() => {}); });
  await settle();
  assert.match(container.textContent, /synthetic\/repo-205/);
  assert.doesNotMatch(container.textContent, /repo-204/);
  assert.doesNotMatch(container.textContent, /加载失败|刷新失败/);
});

test("closing the draft dialog while an operation is pending leaves no stale callback on a later dialog", async (t) => {
  const gate = deferred();
  const savedA = [];
  const savedB = [];
  const mountRoot = async (props, handlers) => {
    const calls = [];
    const innerFetch = globalThis.fetch;
    globalThis.fetch = (input, options = {}) => {
      const path = String(input).split("?")[0];
      calls.push({ method: options.method || "GET", path });
      const handler = handlers[path];
      if (!handler) return Promise.reject(new Error(`unhandled ${path}`));
      return Promise.resolve(handler({ path, method: options.method || "GET", options }));
    };
    const el = document.createElement("div");
    document.body.append(el);
    const rootEl = createRoot(el);
    await act(() => { rootEl.render(React.createElement(compiled.exports.LearningDraftDialog, props)); });
    return { container: el, root: rootEl, calls, restore: () => { globalThis.fetch = innerFetch; } };
  };
  const originalFetch = globalThis.fetch;

  const A = await mountRoot(
    {
      repository,
      workspace: draftWorkspace(),
      onClose: () => {},
      onDraftSaved: () => savedA.push(1),
      onConfirmed: () => {},
      onOpenWorkspace: () => {},
    },
    {
      "/api/learning/11111111-2222-4333-8444-555555555555/draft": ({ options }) => gate.promise.then(() => {
        const body = JSON.parse(options.body);
        return jsonResponse({ workspace: draftWorkspace({ draftRevision: body.expectedRevision + 1, mission: body.mission }) });
      }),
    },
  );
  await settle();
  await act(() => button(A.container, "保存修改").click());
  assert.equal(savedA.length, 0);

  // Close/unmount A while its save is pending, then mount a fresh dialog B.
  act(() => A.root.unmount());
  A.container.remove();
  const B = await mountRoot(
    {
      repository: { ...repository, repositoryId: 202, fullName: "synthetic/repo-202", htmlUrl: "https://github.com/synthetic/repo-202" },
      workspace: { ...draftWorkspace(), repositoryId: 202, workspaceId: uuid("2"), fullName: "synthetic/repo-202" },
      onClose: () => {},
      onDraftSaved: () => savedB.push(1),
      onConfirmed: () => {},
      onOpenWorkspace: () => {},
    },
    {
      "/api/learning/22222222-2222-4333-8444-555555555555/draft": ({ options }) => {
        const body = JSON.parse(options.body);
        return jsonResponse({ workspace: draftWorkspace({ workspaceId: uuid("2"), repositoryId: 202, fullName: "synthetic/repo-202", draftRevision: body.expectedRevision + 1, mission: body.mission }) });
      },
    },
  );
  await settle();
  assert.match(B.container.textContent, /synthetic\/repo-202/);

  // A's old save completes now: the disposed dialog must not fire callbacks
  // or touch the new dialog's content.
  await act(async () => { gate.resolve(); await gate.promise.catch(() => {}); });
  await settle();
  assert.equal(savedA.length, 0, "the unmounted dialog must not fire onDraftSaved");
  assert.equal(savedB.length, 0);
  assert.match(B.container.textContent, /synthetic\/repo-202/);
  assert.doesNotMatch(B.container.textContent, /任务已保存/);

  act(() => B.root.unmount());
  B.container.remove();
  A.restore();
  globalThis.fetch = originalFetch;
});

// Part 3: capability fields, close semantics and confirm/revision recovery ---

test("per-field capabilities gate each mutation independently", async (t) => {
  const caps = { read: true, create: true, edit: false, preview: true, confirm: true, activate: true, archive: false };
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: caps }),
    "/api/learning": () => jsonResponse({
      workspaces: [
        learningWorkspace({ workspaceId: uuid("1"), state: "draft", repositoryId: 201 }),
        learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208 }),
      ],
    }),
  };
  const { container } = await mountLearningPage(t, { handlers: anchors });
  await settle();

  // create:true alone must not enable edit or archive; each field controls its
  // own operation. (`assert.ok(!...)` instead of a direct element compare: a
  // failing element-equality assertion makes node inspect the happy-dom node,
  // which explodes instead of failing cleanly.)
  assert.ok(!button(container, "编辑任务"), "edit:false hides 编辑任务");
  assert.ok(button(container, "激活"), "activate:true keeps activation");
  assert.equal([...container.querySelectorAll("button")].some((b) => /归档/.test(b.textContent)), false, "archive:false hides every archive action");

  // The detail page respects the same fields.
  const detail = await mountLearningPage(t, { initialEntries: ["/learning/88888888-2222-4333-8444-555555555555"], handlers: {
    ...anchors,
    "/api/learning/88888888-2222-4333-8444-555555555555": () => jsonResponse({
      workspace: learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208 }),
    }),
  } });
  await settle();
  assert.ok(button(detail.container, "激活"));
  assert.equal([...detail.container.querySelectorAll("button")].some((b) => /归档/.test(b.textContent)), false);
});

test("a failed capability request disables every mutation and keeps the retry", async (t) => {
  const anchors = {
    "/api/learning/capabilities": () => apiError("LEARNING_INTERNAL_ERROR", "学习服务暂时不可用。", 500),
    "/api/learning": () => jsonResponse({
      workspaces: [
        learningWorkspace({ workspaceId: uuid("1"), state: "draft", repositoryId: 201 }),
        learningWorkspace({ workspaceId: uuid("8"), state: "queued", repositoryId: 208 }),
      ],
    }),
  };
  const { container } = await mountLearningPage(t, { handlers: anchors });
  await settle();

  assert.match(container.textContent, /无法确认学习权限/);
  assert.ok(button(container, "重试"), "a retry entry must restore capabilities");
  assert.ok(!button(container, "编辑任务"));
  assert.ok(!button(container, "激活"));
  assert.equal([...container.querySelectorAll("button")].some((b) => /归档/.test(b.textContent)), false);
});

test("capabilities missing keeps every mutation silent and closing available", async (t) => {
  let createCalls = 0;
  const closed = [];
  const { container } = await mountDialog(t, {
    props: { capabilities: null, readOnly: false, onClose: () => closed.push(1) },
    handlers: {
      "/api/learning/drafts": () => { createCalls += 1; return jsonResponse({ workspace: draftWorkspace() }); },
    },
  });
  await settle();
  // Missing (pending or refresh-failed) capabilities must never issue a
  // mutation request, even when readOnly is false.
  assert.equal(createCalls, 0, "no mutation request may fire while capabilities are missing");
  assert.match(container.textContent, /正在等待学习权限/);
  await act(() => container.querySelector(".learning-dialog__close").click());
  assert.equal(closed.length, 1, "closing must stay available while mutations are disabled");
});

test("capabilities arriving after open resume the pending creation exactly once", async (t) => {
  let createCalls = 0;
  const baseProps = {
    repository,
    capabilities: null,
    onClose: () => {},
    onDraftSaved: () => {},
    onConfirmed: () => {},
    onOpenWorkspace: () => {},
  };
  const { container, root } = await mountDialog(t, {
    props: baseProps,
    handlers: {
      "/api/learning/drafts": () => { createCalls += 1; return jsonResponse({ workspace: draftWorkspace() }); },
    },
  });
  await settle();
  assert.equal(createCalls, 0, "pending capabilities must not create the draft");
  assert.match(container.textContent, /正在等待学习权限/);

  // The SAME dialog instance receives capabilities: the creation must resume
  // instead of being stranded in the creating phase forever.
  await act(() => root.render(React.createElement(compiled.exports.LearningDraftDialog, {
    ...baseProps,
    capabilities: fullCaps,
  })));
  await settle();
  assert.equal(createCalls, 1, "the draft must be created exactly once when capabilities arrive");
  assert.ok(button(container, "预览确认"), "the dialog must reach the editing phase");

  // A later identical re-render must not create a second draft.
  await act(() => root.render(React.createElement(compiled.exports.LearningDraftDialog, {
    ...baseProps,
    capabilities: fullCaps,
  })));
  await settle();
  assert.equal(createCalls, 1, "later re-renders must not create a second draft");
});

test("create allowed but confirm denied creates the draft and never confirms", async (t) => {
  let confirmCalls = 0;
  const restrictedCaps = { ...fullCaps, confirm: false };
  const { container, calls } = await mountDialog(t, {
    props: { capabilities: restrictedCaps },
    handlers: {
      "/api/learning/drafts": () => jsonResponse({ workspace: draftWorkspace() }),
      "/api/learning/11111111-2222-4333-8444-555555555555/preview": () => jsonResponse(previewPage()),
      "/api/learning/confirm": () => { confirmCalls += 1; return jsonResponse({ confirmed: "active", workspace: draftWorkspace({ state: "active" }) }); },
    },
  });
  await settle();
  assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/api/learning/drafts").length, 1, "create:true must allow the draft");
  await act(() => button(container, "预览确认").click());
  await settle();
  const confirm = button(container, "确认加入学习");
  assert.ok(confirm, "the confirm button stays rendered for a disabled branch");
  assert.equal(confirm.disabled, true, "confirm:false must disable confirmation");
  await act(() => confirm.click());
  await settle();
  assert.equal(confirmCalls, 0, "a denied confirm branch must never call the server");
});

test("capabilities disappearing after creation disable mutations but keep closing", async (t) => {
  const closed = [];
  const baseProps = {
    repository,
    capabilities: fullCaps,
    onClose: () => closed.push(1),
    onDraftSaved: () => {},
    onConfirmed: () => {},
    onOpenWorkspace: () => {},
  };
  const { container, root } = await mountDialog(t, {
    props: baseProps,
    handlers: {
      "/api/learning/drafts": () => jsonResponse({ workspace: draftWorkspace() }),
    },
  });
  await settle();
  assert.ok(button(container, "保存修改"), "writable capabilities allow editing");

  // A failed capability refresh drops capabilities to null: every mutation
  // branch must stop, but closing the dialog stays available.
  await act(() => root.render(React.createElement(compiled.exports.LearningDraftDialog, {
    ...baseProps,
    capabilities: null,
  })));
  await settle();
  assert.equal(button(container, "保存修改").disabled, true, "save must be disabled without capabilities");
  assert.equal(button(container, "预览确认").disabled, true, "preview must be disabled without capabilities");
  await act(() => button(container, "关闭").click());
  assert.equal(closed.length, 1, "closing must stay available when capabilities are gone");
});

test("a failed capability request keeps reads working and a retry restores the mutations", async (t) => {
  let capsOk = false;
  const anchors = {
    "/api/learning/capabilities": () => capsOk
      ? jsonResponse({ capabilities: learningCaps })
      : apiError("LEARNING_INTERNAL_ERROR", "学习服务暂时不可用。", 500),
    "/api/learning": () => jsonResponse({
      workspaces: [learningWorkspace({ workspaceId: uuid("1"), state: "draft", repositoryId: 201 })],
    }),
  };
  const { container } = await mountLearningPage(t, { handlers: anchors });
  await settle();

  assert.match(container.textContent, /无法确认学习权限/);
  assert.ok(button(container, "重试"), "a retry entry must be available after the failure");
  assert.ok(!button(container, "编辑任务"), "mutations stay disabled");
  assert.match(container.textContent, /synthetic\/repo-201/, "reads keep working");

  capsOk = true;
  await act(() => button(container, "重试").click());
  await settle();
  assert.ok(button(container, "编辑任务"), "the retry restores the writable capability");
  assert.doesNotMatch(container.textContent, /无法确认学习权限/);
});

test("closing the dialog is never blocked by read-only", async (t) => {
  const closed = [];
  const { container } = await mountDialog(t, {
    props: { readOnly: true, workspace: draftWorkspace({ draftRevision: 2 }), onClose: () => closed.push(1) },
    handlers: {},
  });
  await settle();
  // Read-only blocks mutations; it must never block closing the dialog.
  await act(() => button(container, "关闭").click());
  assert.equal(closed.length, 1);
});

test("confirm: network uncertainty keeps the same-token retry", async (t) => {
  const confirmCalls = [];
  let networkFail = true;
  const { container } = await mountDialog(t, {
    handlers: {
      "/api/learning/drafts": () => jsonResponse({ workspace: draftWorkspace() }),
      "/api/learning/11111111-2222-4333-8444-555555555555/preview": () => jsonResponse(previewPage()),
      "/api/learning/confirm": ({ options }) => {
        confirmCalls.push(JSON.parse(options.body).token);
        if (networkFail) return Promise.reject(new TypeError("network down"));
        return jsonResponse({ confirmed: "active", workspace: draftWorkspace({ state: "active" }) });
      },
    },
  });
  await settle();
  await act(() => button(container, "预览确认").click());
  await settle();
  await act(() => button(container, "确认加入学习").click());
  await settle();

  // Network uncertainty: retrying the ORIGINAL token is safe and idempotent.
  assert.match(container.textContent, /结果未收到/);
  assert.ok(button(container, "重试确认"));
  networkFail = false;
  await act(() => button(container, "重试确认").click());
  await settle();
  assert.equal(confirmCalls.length, 2);
  assert.equal(confirmCalls[1], confirmCalls[0], "a network retry reuses the same token");
  assert.match(container.textContent, /已加入学习/);
});

test("confirm: an explicit CONFIRM_TOKEN_INVALID rejection refuses a doomed retry and recovers via a fresh preview that keeps the input", async (t) => {
  const previews = [];
  const confirmCalls = [];
  let notes = "input the user typed";
  const { container } = await mountDialog(t, {
    handlers: {
      "/api/learning/drafts": () => jsonResponse({ workspace: draftWorkspace() }),
      "/api/learning/11111111-2222-4333-8444-555555555555/draft": ({ options }) => {
        const body = JSON.parse(options.body);
        return jsonResponse({ workspace: draftWorkspace({ draftRevision: body.expectedRevision + 1, mission: body.mission }) });
      },
      "/api/learning/11111111-2222-4333-8444-555555555555/preview": () => {
        previews.push(previews.length + 1);
        return jsonResponse(previewPage({ token: `token.${previews.length}`, mission: { goal: "learn-usage", notes } }));
      },
      "/api/learning/confirm": ({ options }) => {
        confirmCalls.push(JSON.parse(options.body).token);
        return apiError("CONFIRM_TOKEN_INVALID", "确认凭证已失效，请重新预览。", 409);
      },
    },
  });
  await settle();
  await setNotes(container, notes);
  await act(() => button(container, "预览确认").click());
  await settle();
  await act(() => button(container, "确认加入学习").click());
  await settle();

  // An explicit business rejection must not offer a doomed same-token retry.
  assert.match(container.textContent, /确认凭证已失效/);
  assert.ok(!button(container, "重试确认"), "no doomed retry for a dead token");
  assert.ok(button(container, "重新预览"));

  // Recovery: a fresh preview keeps the typed input and issues a new token.
  await act(() => button(container, "重新预览").click());
  await settle();
  assert.equal(previews.length, 2);
  assert.match(container.textContent, /input the user typed/);
  assert.ok(button(container, "确认加入学习"));
  await act(() => button(container, "确认加入学习").click());
  await settle();
  assert.notEqual(confirmCalls[confirmCalls.length - 1], confirmCalls[0], "recovery must use a fresh token");
});

test("activate revision conflict refreshes the latest revision so a retry is not doomed", async (t) => {
  // The store is at revision 5 while the client's initial copy is still 4.
  let revision = 5;
  let state = "queued";
  let detailCalls = 0;
  const activateBodies = [];
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [] }),
    "/api/learning/88888888-2222-4333-8444-555555555555": () => {
      detailCalls += 1;
      // The first GET is the stale client copy; the auto-refresh after the
      // conflict sees the store's actual current revision.
      return jsonResponse({
        workspace: learningWorkspace({ workspaceId: uuid("8"), state, repositoryId: 208, draftRevision: detailCalls === 1 ? 4 : revision }),
      });
    },
    "/api/learning/88888888-2222-4333-8444-555555555555/activate": ({ options }) => {
      const body = JSON.parse(options.body);
      activateBodies.push(body);
      if (body.expectedRevision !== revision) {
        return apiError("REVISION_CONFLICT", "任务已发生较新的编辑，请刷新后重试。", 409);
      }
      state = "active";
      return jsonResponse({ workspace: learningWorkspace({ workspaceId: uuid("8"), state: "active", repositoryId: 208, draftRevision: revision }), outcome: "active" });
    },
  };
  const { container } = await mountLearningPage(t, { initialEntries: ["/learning/88888888-2222-4333-8444-555555555555"], handlers: anchors });
  await settle();

  await act(() => button(container, "激活").click());
  await settle();
  assert.match(container.textContent, /较新的编辑/);
  // The page refreshed the detail, so the retry sends the fresh revision.
  await act(() => button(container, "重试激活").click());
  await settle();
  assert.equal(activateBodies.length, 2);
  assert.equal(activateBodies[0].expectedRevision, 4);
  assert.equal(activateBodies[1].expectedRevision, 5, "the retry must use the refreshed revision, not replay the dead one");
  assert.match(container.textContent, /已激活/);
  assert.match(container.textContent, /学习中/);
});

test("editing after a revision conflict keeps the user input and retries against the fresh revision", async (t) => {
  let currentRevision = 2; // the store is ahead of the dialog's copy (revision 1)
  const patches = [];
  const existing = draftWorkspace({ draftRevision: 1 });
  const { container } = await mountDialog(t, {
    props: {
      workspace: existing,
      onRefreshWorkspace: async () => ({ ...draftWorkspace({ draftRevision: currentRevision }) }),
    },
    handlers: {
      "/api/learning/11111111-2222-4333-8444-555555555555/draft": ({ options }) => {
        const body = JSON.parse(options.body);
        patches.push(body);
        if (body.expectedRevision !== currentRevision) {
          return apiError("REVISION_CONFLICT", "任务已发生较新的编辑，请刷新后重试。", 409);
        }
        currentRevision += 1;
        return jsonResponse({ workspace: draftWorkspace({ draftRevision: currentRevision, mission: body.mission }) });
      },
    },
  });
  await settle();
  await setNotes(container, "typed by the user");
  await act(() => button(container, "保存修改").click());
  await settle();

  assert.deepEqual(patches[0], { expectedRevision: 1, mission: { goal: "learn-usage", notes: "typed by the user" } });
  assert.match(container.textContent, /已被其他操作更新|较新的编辑/);
  const textarea = container.querySelector("textarea[name='notes']");
  assert.equal(textarea.value, "typed by the user", "the user input survives a revision conflict");

  await act(() => button(container, "重试").click());
  await settle();
  assert.deepEqual(patches[1], { expectedRevision: 2, mission: { goal: "learn-usage", notes: "typed by the user" } });
  assert.match(container.textContent, /任务已保存/);
});

// The real app mounts under React <StrictMode>, which simulates an
// unmount/remount on first mount. A lifecycle "disposed" marker armed only by
// the cleanup would strand in-flight completions after that simulation; the
// marker must be re-armed by the effect setup. These regressions guard the
// exact defect found in the real-browser acceptance.

test("StrictMode remount must not strand the draft dialog in the creating phase", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options = {}) => {
    const path = String(input).split("?")[0];
    calls.push({ method: options.method || "GET", path });
    if (path === "/api/learning/drafts") return Promise.resolve(jsonResponse({ workspace: draftWorkspace() }));
    return Promise.reject(new Error(`unhandled ${path}`));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => {
    root.render(React.createElement(React.StrictMode, null,
      React.createElement(compiled.exports.LearningDraftDialog, { repository, capabilities: fullCaps, onClose: () => {}, onDraftSaved: () => {}, onConfirmed: () => {}, onOpenWorkspace: () => {} }),
    ));
  });
  t.after(() => { act(() => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
  await settle();
  assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/api/learning/drafts").length, 1);
  assert.ok(button(container, "预览确认"), "the create completion must reach the editing phase under StrictMode");
});

test("StrictMode remount must not drop list/detail loads on the learning page", async (t) => {
  const anchors = {
    "/api/learning/capabilities": () => jsonResponse({ capabilities: learningCaps }),
    "/api/learning": () => jsonResponse({ workspaces: [learningWorkspace({ workspaceId: uuid("3"), state: "active", repositoryId: 203 })] }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options = {}) => {
    const path = String(input).split("?")[0];
    const handler = anchors[path];
    if (!handler) return Promise.reject(new Error(`unhandled ${path}`));
    return Promise.resolve(handler({ path, method: options.method || "GET" }));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = createMemoryRouter(
    [{ path: "/learning", element: React.createElement(React.StrictMode, null, React.createElement(pageCompiled.exports.LearningPage)) }],
    { initialEntries: ["/learning"] },
  );
  await act(() => { root.render(React.createElement(RouterProvider, { router })); });
  t.after(() => { act(() => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
  await settle();
  assert.ok(container.textContent.includes("synthetic/repo-203"), "the list must render under StrictMode");
});
