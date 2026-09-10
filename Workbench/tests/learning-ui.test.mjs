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
  gate.resolve();
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

const { createMemoryRouter, RouterProvider, MemoryRouter, Route, Routes } = await import("react-router-dom");

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