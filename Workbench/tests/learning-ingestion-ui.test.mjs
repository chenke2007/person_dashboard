import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import React from "react";

const filename = fileURLToPath(new URL("./learning-ingestion-ui.cjs", import.meta.url));
const result = await build({
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
const { createMemoryRouter, RouterProvider } = await import("react-router-dom");

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const VAULT_A = "a".repeat(64);
const VAULT_B = "b".repeat(64);
const ARTIFACT_ID = "99999999-2222-4333-8444-555555555555";
const SHA = "c".repeat(40);
const PLAN_PATH = "Wiki/学习/synthetic-repo-201/学习计划.md";
const NOTES_PATH = "Wiki/学习/synthetic-repo-201/学习笔记.md";

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

const workspace = {
  workspaceId: WORKSPACE_ID,
  repositoryId: 201,
  fullName: "synthetic/repo-201",
  sourceUrl: "https://github.com/synthetic/repo-201",
  sourceCommitSha: SHA,
  mission: { goal: "learn-usage", notes: "Synthetic learning notes" },
  state: "active",
  draftRevision: 1,
  createdAt: "2026-09-02T01:00:00.000Z",
  updatedAt: "2026-09-02T01:00:00.000Z",
};

const writableCaps = {
  read: true, create: true, edit: true, preview: true, confirm: true, activate: true, archive: true,
  ingest: { read: true, select: true, preview: true, confirm: true },
};
const readOnlyCaps = {
  read: true, create: false, edit: false, preview: false, confirm: false, activate: false, archive: false,
  ingest: { read: true, select: false, preview: true, confirm: false },
};

const vaultA = { vaultId: VAULT_A, displayName: "知识库·甲", maskedPath: "…/知识库·甲", writable: true, isCurrent: false, boundToWorkspace: false, selected: false };
const vaultB = { vaultId: VAULT_B, displayName: "知识库·乙", maskedPath: "…/知识库·乙", writable: true, isCurrent: true, boundToWorkspace: false, selected: false };
const readOnlyVault = { ...vaultA, writable: false };

function defaultPreview(body, overrides = {}) {
  const target = body.targetVaultId === VAULT_A
    ? { vaultId: VAULT_A, displayName: "知识库·甲", maskedPath: "…/知识库·甲", writable: true, isCurrent: false }
    : { vaultId: VAULT_B, displayName: "知识库·乙", maskedPath: "…/知识库·乙", writable: true, isCurrent: true };
  return {
    previewRevision: 1,
    confirmAvailable: true,
    previewToken: "ingestion.preview.token.1",
    expiresAt: "2026-09-02T06:10:00.000Z",
    target,
    sourceCommitSha: SHA,
    contentRevision: 3,
    selectedContentTypes: body.selectedContentTypes,
    files: [
      { relativePath: PLAN_PATH, kind: "plan", artifactId: null, conflict: false, mode: "create", preview: "# 学习计划\n\n合成计划正文……" },
      { relativePath: NOTES_PATH, kind: "notes", artifactId: null, conflict: false, mode: "create", preview: "# 学习笔记\n\n合成笔记正文……" },
    ],
    conflicts: [],
    ...overrides,
  };
}

function defaultConfirm() {
  return {
    replayed: false,
    ingestion: {
      ingestionId: "22222222-2222-4333-8444-555555555555",
      workspaceId: WORKSPACE_ID,
      status: "written",
      resolution: null,
      writtenFiles: [PLAN_PATH, NOTES_PATH],
      writtenAt: "2026-09-02T06:05:00.000Z",
    },
    receipt: { status: "written", writtenFiles: [PLAN_PATH, NOTES_PATH] },
  };
}

// Builds a per-test fetch handler map. `onTarget`, `onPreview` and `onConfirm`
// sit on top of the default responses so individual tests can defer or fail a
// single action while everything else keeps working.
function anchorsFor({ caps = writableCaps, targets = null, artifacts = [], onTarget = null, onPreview = null, onConfirm = null } = {}) {
  const calls = { target: [], preview: [], confirm: [] };
  const state = { selection: null };
  const candidateList = targets ?? [vaultA, vaultB];
  return {
    calls,
    state,
    handlers: {
      "/api/learning/capabilities": () => jsonResponse({ capabilities: caps }),
      "/api/learning": () => jsonResponse({ workspaces: [] }),
      [`/api/learning/${WORKSPACE_ID}`]: () => jsonResponse({ workspace }),
      [`/api/learning/${WORKSPACE_ID}/content`]: () => jsonResponse({ content: null }),
      [`/api/learning/${WORKSPACE_ID}/artifacts`]: () => jsonResponse({ artifacts }),
      [`/api/learning/${WORKSPACE_ID}/targets`]: () => {
        const current = state.selection
          ? { vaultId: state.selection, displayName: state.selection === VAULT_A ? "知识库·甲" : "知识库·乙", maskedPath: "…", writable: true }
          : null;
        return jsonResponse({ targets: candidateList, current, warnings: [] });
      },
      [`/api/learning/${WORKSPACE_ID}/target`]: ({ options }) => {
        const body = JSON.parse(options.body);
        calls.target.push(body);
        state.selection = body.vaultId;
        if (onTarget) return onTarget(body);
        return jsonResponse({ target: { vaultId: body.vaultId, displayName: body.vaultId === VAULT_A ? "知识库·甲" : "知识库·乙", maskedPath: "…", writable: true, isCurrent: false, selectedAt: "2026-09-02T06:02:00.000Z" } });
      },
      [`/api/learning/${WORKSPACE_ID}/ingestions/preview`]: ({ options }) => {
        const body = JSON.parse(options.body);
        calls.preview.push(body);
        return onPreview ? onPreview(body) : jsonResponse(defaultPreview(body));
      },
      [`/api/learning/${WORKSPACE_ID}/ingestions/confirm`]: ({ options }) => {
        const body = JSON.parse(options.body);
        calls.confirm.push(body);
        return onConfirm ? onConfirm(body) : jsonResponse(defaultConfirm());
      },
    },
  };
}

async function mountLearningPage(t, { handlers = {} } = {}) {
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
      { path: "/learning", element: React.createElement(compiled.exports.LearningPage) },
      { path: "/learning/:workspaceId", element: React.createElement(compiled.exports.LearningPage) },
    ],
    { initialEntries: [`/learning/${WORKSPACE_ID}`] },
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

const button = (container, text) => [...container.querySelectorAll("button")].find((b) => b.textContent.trim().includes(text));
const labelInput = (container, labelText) => {
  const label = [...container.querySelectorAll("label")].find((entry) => entry.textContent.includes(labelText));
  return label ? label.querySelector("input") : undefined;
};
const selectElement = (container) => container.querySelector("#learning-ingestion-target");

async function changeSelect(container, value) {
  await act(() => {
    const select = selectElement(container);
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await settle();
}

async function toggleCheckbox(input, checked) {
  await act(() => {
    if (input.checked !== checked) input.click();
  });
}

test("selecting a vault, picking content and confirming writes to Obsidian without touching the learning state", async (t) => {
  const artifacts = [{ artifactId: ARTIFACT_ID, type: "总结", title: "架构分析", markdownText: "合成产出正文", createdAt: "2026-09-02T01:00:00.000Z", updatedAt: "2026-09-02T01:00:00.000Z" }];
  const { calls, handlers } = anchorsFor({ artifacts });
  const { container } = await mountLearningPage(t, { handlers });
  await settle();

  // The target selector renders the vault candidates with their display names.
  assert.ok(container.textContent.includes("目标 Obsidian 仓库"));
  const select = selectElement(container);
  assert.ok(select, "a target vault selector must render");
  assert.ok([...select.options].some((option) => option.textContent.includes("知识库·甲")));
  assert.ok([...select.options].some((option) => option.textContent.includes("知识库·乙")));

  // Choosing a target persists the selection through the server.
  await changeSelect(container, VAULT_A);
  assert.equal(calls.target.length, 1);
  assert.deepEqual(calls.target[0], { vaultId: VAULT_A });
  assert.match(container.textContent, /已选择目标仓库：知识库·甲/);

  // Plan and notes are selected by default; a learning artifact is independently selectable.
  assert.ok(labelInput(container, "学习计划"));
  assert.ok(labelInput(container, "学习笔记"));
  const artifactInput = labelInput(container, "架构分析");
  assert.ok(artifactInput, "learning artifacts must be individually selectable");
  await toggleCheckbox(artifactInput, true);

  // Previewing renders target, paths, file count and content snippets.
  await act(() => button(container, "预览写入").click());
  await settle();
  assert.equal(calls.preview.length, 1);
  assert.deepEqual(calls.preview[0].selectedContentTypes, ["plan", "notes", `artifact:${ARTIFACT_ID}`]);
  assert.equal(calls.preview[0].targetVaultId, VAULT_A);
  assert.match(container.textContent, /知识库·甲/);
  assert.ok(container.textContent.includes(PLAN_PATH));
  assert.ok(container.textContent.includes(NOTES_PATH));
  assert.match(container.textContent, /文件数量/);
  assert.match(container.textContent, /合成计划正文/);
  assert.ok(button(container, "确认写入 Obsidian"), "a writable preview must offer confirmation");

  // Confirming posts only the token (no resolution) and shows the written files.
  await act(() => button(container, "确认写入 Obsidian").click());
  await settle();
  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.confirm[0].token, "ingestion.preview.token.1");
  assert.equal(calls.confirm[0].conflictResolution, undefined);
  assert.match(container.textContent, /已写入 Obsidian/);
  assert.ok(container.textContent.includes(PLAN_PATH));
  assert.ok(container.textContent.includes(NOTES_PATH));
  // Ingestion success must never advertise a finished learning state.
  assert.match(container.textContent, /不会改变学习任务状态/);
  assert.doesNotMatch(container.textContent, /已完成学习/);
});

test("conflicts are listed explicitly and never auto-overwritten; resolution is a user decision", async (t) => {
  const { calls, handlers } = anchorsFor({
    onPreview: (body) => jsonResponse(defaultPreview(body, {
      files: [
        { relativePath: PLAN_PATH, kind: "plan", artifactId: null, conflict: true, mode: "create", preview: "# 学习计划" },
        { relativePath: NOTES_PATH, kind: "notes", artifactId: null, conflict: false, mode: "create", preview: "# 学习笔记" },
      ],
      conflicts: [PLAN_PATH],
    })),
    onConfirm: (body) => jsonResponse({
      replayed: false,
      ingestion: {
        ingestionId: "22222222-2222-4333-8444-555555555555",
        workspaceId: WORKSPACE_ID,
        status: "written",
        resolution: body.conflictResolution ?? null,
        writtenFiles: [NOTES_PATH],
        writtenAt: "2026-09-02T06:05:00.000Z",
      },
      receipt: { status: "written", writtenFiles: [NOTES_PATH] },
    }),
  });
  const { container } = await mountLearningPage(t, { handlers });
  await settle();
  await changeSelect(container, VAULT_A);
  await act(() => button(container, "预览写入").click());
  await settle();

  // The conflict path and "已存在" status are visible; no forced-overwrite path exists.
  assert.ok(container.textContent.includes(PLAN_PATH));
  assert.match(container.textContent, /已存在/);
  assert.match(container.textContent, /冲突/);
  assert.equal(button(container, "强制覆盖"), undefined, "a forced-overwrite button must never exist");
  assert.equal(button(container, "确认写入 Obsidian").disabled, true, "confirm must be blocked until a resolution is chosen");

  // Skipping conflicted files writes only the non-conflicted ones.
  const skipRadio = [...container.querySelectorAll('input[type="radio"]')].find((entry) => entry.closest("label").textContent.includes("跳过冲突文件"));
  await toggleCheckbox(skipRadio, true);
  assert.equal(button(container, "确认写入 Obsidian").disabled, false);
  await act(() => button(container, "确认写入 Obsidian").click());
  await settle();
  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.confirm[0].conflictResolution, "skip");
  assert.ok(container.textContent.includes(NOTES_PATH));
  assert.doesNotMatch(container.textContent, /正在写入/);
});

test("a failed write keeps the target selection and offers an idempotent retry", async (t) => {
  let confirmCalls = 0;
  const { calls, handlers } = anchorsFor({
    onConfirm: () => {
      confirmCalls += 1;
      if (confirmCalls === 1) return apiError("INGESTION_WRITE_FAILED", "写入 Obsidian 失败，已回滚本次尝试。", 500);
      return jsonResponse(defaultConfirm());
    },
  });
  const { container } = await mountLearningPage(t, { handlers });
  await settle();
  await changeSelect(container, VAULT_A);
  await act(() => button(container, "预览写入").click());
  await settle();
  await act(() => button(container, "确认写入 Obsidian").click());
  await settle();

  // The failure is visible, the target selection is untouched, and the retry works.
  assert.match(container.textContent, /写入失败|已回滚/);
  assert.equal(selectElement(container).value, VAULT_A, "the target selection must survive a failed write");
  assert.ok(button(container, "重试"), "a retry entry must appear after a failed write");

  await act(() => button(container, "重试").click());
  await settle();
  assert.equal(confirmCalls, 2);
  assert.equal(calls.confirm[0].token, calls.confirm[1].token, "the retry must reuse the same preview token");
  assert.match(container.textContent, /已写入 Obsidian/);
});

test("an old preview response never overrides a newer target selection", async (t) => {
  const oldPreview = deferred();
  let previewMode = "old";
  const { calls, handlers } = anchorsFor({
    onPreview: () => {
      if (previewMode === "old") return oldPreview.promise.then(() => jsonResponse(defaultPreview({ selectedContentTypes: ["plan"], targetVaultId: VAULT_A })));
      return jsonResponse(defaultPreview({ selectedContentTypes: ["plan"], targetVaultId: VAULT_B }));
    },
  });
  const { container } = await mountLearningPage(t, { handlers });
  await settle();

  await changeSelect(container, VAULT_A);
  await act(() => button(container, "预览写入").click());
  assert.equal(calls.preview.length, 1, "the preview for the old target is in flight");

  // The user switches to another vault while the old preview is still pending.
  previewMode = "new";
  await changeSelect(container, VAULT_B);
  assert.equal(calls.target.length, 2);
  assert.deepEqual(calls.target[1], { vaultId: VAULT_B });
  // The stale preview lands after the switch.
  await act(async () => { oldPreview.resolve(); await oldPreview.promise.catch(() => {}); });
  await settle();

  // The panel must not paint the old target's preview: no old paths, no confirm.
  assert.equal(selectElement(container).value, VAULT_B, "the new selection stays selected");
  assert.ok(container.textContent.includes("已选择目标仓库：知识库·乙"));
  assert.doesNotMatch(container.textContent, /合成计划正文/);
  assert.equal(button(container, "确认写入 Obsidian"), undefined, "a stale preview must not enable confirmation");

  // A fresh preview reflects the new target.
  await act(() => button(container, "预览写入").click());
  await settle();
  assert.equal(calls.preview[1].targetVaultId, VAULT_B);
  assert.ok(container.textContent.includes("知识库·乙"));
  assert.ok(button(container, "确认写入 Obsidian"));
});

test("read-only mode previews without minting a token and hides confirmation", async (t) => {
  const { calls, handlers } = anchorsFor({
    caps: readOnlyCaps,
    targets: [readOnlyVault, { ...vaultB, writable: false }],
    onPreview: (body) => jsonResponse({
      previewRevision: null,
      confirmAvailable: false,
      target: { vaultId: body.targetVaultId, displayName: "知识库·甲", maskedPath: "…/知识库·甲", writable: false, isCurrent: true },
      sourceCommitSha: SHA,
      contentRevision: 3,
      selectedContentTypes: body.selectedContentTypes,
      files: [
        { relativePath: PLAN_PATH, kind: "plan", artifactId: null, conflict: false, mode: "create", preview: "# 学习计划" },
      ],
      conflicts: [],
    }),
  });
  const { container } = await mountLearningPage(t, { handlers });
  await settle();

  // Read-only rendering lists the vault status and hides confirmation.
  assert.match(container.textContent, /只读/);
  assert.ok(selectElement(container), "read-only mode still renders the target selector for previewing");

  // Choosing a vault does not persist a mutation.
  await changeSelect(container, VAULT_A);
  assert.equal(calls.target.length, 0, "read-only mode must never call the target mutation");

  await act(() => button(container, "预览写入").click());
  await settle();
  assert.equal(calls.preview.length, 1);
  assert.equal(calls.preview[0].targetVaultId, VAULT_A);
  assert.ok(container.textContent.includes(PLAN_PATH));
  assert.equal(button(container, "确认写入 Obsidian"), undefined, "confirmation must be hidden in read-only mode");
});

test("no vault candidates render an explicit empty state and disable previewing", async (t) => {
  const { handlers } = anchorsFor({ targets: [] });
  const { container } = await mountLearningPage(t, { handlers });
  await settle();

  assert.match(container.textContent, /未发现可用的 Obsidian 仓库候选/);
  assert.equal(selectElement(container), null);
  assert.equal(button(container, "预览写入").disabled, true, "previewing without a target must be disabled");
});

test("changing the target after a preview invalidates the local preview until re-previewed", async (t) => {
  const { calls, handlers } = anchorsFor({});
  const { container } = await mountLearningPage(t, { handlers });
  await settle();
  await changeSelect(container, VAULT_A);
  await act(() => button(container, "预览写入").click());
  await settle();
  assert.equal(calls.preview.length, 1);
  assert.ok(button(container, "确认写入 Obsidian"));

  // Switching targets clears the stale preview before any new preview request.
  await changeSelect(container, VAULT_B);
  assert.equal(calls.preview.length, 1, "no preview is fetched for the switch itself");
  assert.equal(button(container, "确认写入 Obsidian"), undefined, "the old preview must not stay confirmable");
  assert.doesNotMatch(container.textContent, /合成计划正文/);
});