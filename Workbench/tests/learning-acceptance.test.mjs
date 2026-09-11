import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import React from "react";

import { createServer as createViteServer } from "vite";
import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";
import { createWorkspaceRegistry } from "../server/workspace-state/workspace-registry.mjs";
import { createLearningRepository } from "../server/learning/learning-repository.mjs";

const commitSha = (char) => char.repeat(40);

function syntheticRepository(id = 101, patch = {}) {
  return {
    id,
    fullName: `synthetic/repo-${id}`,
    htmlUrl: `https://github.com/synthetic/repo-${id}`,
    description: `Synthetic demo repository ${id}`,
    language: "TypeScript",
    topics: ["agents"],
    focusAreas: ["agent"],
    stars: 900 - id,
    forks: 2,
    openIssues: null,
    archived: false,
    fork: false,
    license: "MIT",
    defaultBranch: "main",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-09-02T06:00:00.000Z",
    pushedAt: null,
    observedAt: "2026-09-02T06:00:00.000Z",
    ...patch,
  };
}

function syntheticGitHub() {
  return {
    calls: [],
    async getHeadCommit({ fullName }) {
      this.calls.push({ fullName });
      return {
        fullName,
        ref: "refs/heads/main",
        sha: commitSha("b"),
        committedAt: "2026-09-01T00:00:00.000Z",
        observedAt: "2026-09-02T06:00:00.000Z",
      };
    },
    async discoverCandidates() {
      return { repositories: [], errors: [], partial: false, retryAt: null, truncated: false };
    },
    async getRepositories() {
      return { repositories: [], errors: [], partial: false, retryAt: null, truncated: false };
    },
  };
}

const fetchForbiddenPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

async function listenOnFetchSafePort(server) {
  for (;;) {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.removeListener("listening", onListening); reject(error); };
      const onListening = () => { server.removeListener("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    if (!fetchForbiddenPorts.has(server.address().port)) return;
    await new Promise((resolve) => server.close(resolve));
  }
}

// Real plugin HTTP service over temp real registry/radar/learning stores and a
// synthetic GitHub adapter, exactly like the S2 HTTP seam. The mounted pages
// talk to this origin with REAL fetch — every mutation lands in the real store.
async function startFixture(t, { readOnly = false, projectReadOnly = false, activeCount = 0 } = {}) {
  const stableTempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(stableTempRoot, "workbench-learning-accept-"));
  assert.equal(root, await realpath(root));
  const vaultRoot = path.join(root, "vault");
  const appDataRoot = path.join(root, "app-data");
  const registryDirectory = path.join(appDataRoot, "PersonalAIWorkbench");
  await mkdir(path.join(vaultRoot, "wiki"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "plan.md"), "# Project plan\n", "utf8");

  // Pre-bind exactly like currentWorkspace({create:true}) dedupes by fingerprint.
  const registry = createWorkspaceRegistry({ directory: registryDirectory });
  const fingerprint = createHash("sha256").update(path.resolve(vaultRoot).toLowerCase()).digest("hex");
  const bound = await registry.resolveVault({ fingerprint, label: "Synthetic Acceptance Vault" });
  const stateRoot = bound.storageLayout === "legacy"
    ? path.join(registryDirectory, bound.workspaceId)
    : path.join(registryDirectory, "workspaces", bound.workspaceId);

  // Seed the radar store with synthetic repositories.
  const radarDirectory = path.join(stateRoot, "ai-radar");
  await mkdir(radarDirectory, { recursive: true });
  const radar = await (async () => {
    const { createRadarRepository } = await import("../server/ai-radar/radar-repository.mjs");
    const item = createRadarRepository({ directory: radarDirectory, timeZone: "UTC" });
    await item.updateSchedule({ time: "11:30" });
    await item.upsertRepositories([101, 102, 103, 104, 105].map((id) => syntheticRepository(id)));
    return item;
  })();

  // Seed N active learning workspaces through the real store.
  const learningDirectory = path.join(stateRoot, "learning");
  const learning = createLearningRepository({ directory: learningDirectory });
  for (let index = 0; index < activeCount; index += 1) {
    const id = 102 + index;
    const draft = await learning.createDraft({
      repositoryId: id,
      fullName: `synthetic/repo-${id}`,
      sourceUrl: `https://github.com/synthetic/repo-${id}`,
      sourceCommitSha: commitSha("a"),
      mission: { goal: "understand-architecture", notes: `Seeded active ${id}` },
    });
    const page = await learning.preview({ workspaceId: draft.workspace.workspaceId });
    const confirmed = await learning.confirm({ token: page.token });
    assert.equal(confirmed.confirmed, "active");
  }

  const github = syntheticGitHub();
  const vite = await createViteServer({
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [workbenchApiPlugin({
      vaultRoot,
      profile: "default",
      appDataRoot,
      projectDirectory: null,
      radarDirectory: null,
      readOnly,
      projectReadOnly,
      hosted: false,
      radarOptions: { github },
    })],
  });
  const server = http.createServer(vite.middlewares);
  await listenOnFetchSafePort(server);
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Pre-warm the cold server paths with plain node fetch (no 12s client abort):
  // the first radar/dashboard GET pays one-time file+lock+AV costs that can
  // spike past the app's own request timeout. Warming them here keeps the
  // mounted app on the warm path, so the real-UI assertions never race a
  // cold-start timeout. GETs only — no mutations, no state change.
  for (const warmPath of [
    "/api/ai-radar/capabilities",
    "/api/ai-radar?period=day&state=all&focus=all&learning=all",
    "/api/ai-radar/preferences",
    "/api/learning",
  ]) {
    const warmed = await fetch(`${origin}${warmPath}`);
    if (!warmed.ok) {
      await warmed.text();
      throw new Error(`fixture warm-up failed for ${warmPath} (${warmed.status})`);
    }
    await warmed.text();
  }

  t.after(async () => {
    // The page keeps fetch keep-alives open; without force-closing them,
    // server.close() would wait out each idle keep-alive timeout and the
    // fixture roots would linger while the next test runs.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await vite.close();
    await rm(root, { recursive: true, force: true });
  });
  return { origin, root, stateRoot, radar, learning, github };
}

// UI bundles ---------------------------------------------------------------

async function compile(target) {
  const name = `./learning-accept-${target}.cjs`;
  const filename = fileURLToPath(new URL(name, import.meta.url));
  const result = await build({
    stdin: {
      contents: `export { ${target} } from "../src/${target === "AiRadarPage" ? "pages/AiRadarPage" : "pages/LearningPage"}.jsx";`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "jsx",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    packages: "external",
    define: { "import.meta.env": "{}" },
    plugins: [{ name: "ignore-css", setup(ctx) { ctx.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" })); } }],
    write: false,
  });
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(fileURLToPath(new URL(".", import.meta.url)));
  compiled.require = createRequire(import.meta.url);
  compiled._compile(result.outputFiles[0].text, filename);
  return compiled.exports;
}

const [radarExports, pageExports] = await Promise.all([compile("AiRadarPage"), compile("LearningPage")]);

const window = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : typeof window[key] === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? window[key].bind(window) : window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router-dom");

async function settle() {
  // One act scope per flush: real-HTTP continuations that arrive during the
  // wait are wrapped in act. A response can physically only resolve on a
  // network macrotask, so a single scope (instead of two scopes with a
  // between-act gap) leaves no unbatched window.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
}

// Polls up to ~40 real-HTTP flush rounds until the container text matches.
// The polling loop itself runs inside ONE act scope, so dashboard/list/detail
// responses that arrive between rounds are wrapped instead of warning.
async function waitText(container, pattern, label) {
  await act(async () => {
    for (let round = 0; round < 40; round += 1) {
      if (pattern.test(container.textContent)) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  });
  assert.match(container.textContent, pattern, label ?? "waiting for text");
}

const button = (container, text) => [...container.querySelectorAll("button")].find((b) => b.textContent.trim().includes(text));

async function waitCardText(container, repoName, badge, label) {
  await act(async () => {
    for (let round = 0; round < 60; round += 1) {
      const card = [...container.querySelectorAll(".radar-card")].find((article) => article.textContent.includes(repoName));
      if (card && card.textContent.includes(badge)) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  });
  const card = [...container.querySelectorAll(".radar-card")].find((article) => article.textContent.includes(repoName));
  assert.ok(card, `expected a radar card for ${repoName}`);
  assert.match(card.textContent, new RegExp(badge), label);
}

async function clickButton(container, text) {
  const target = button(container, text);
  assert.ok(target, `expected a button labelled ${text}`);
  // Click and its network round-trip share one act scope so the response
  // paints inside act.
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

async function mountApp(t, { origin, initialEntries = ["/ai-radar?period=day"] }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options = {}) => originalFetch(`${origin}${String(input)}`, options);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = createMemoryRouter(
    [
      { path: "/ai-radar", element: React.createElement(radarExports.AiRadarPage) },
      { path: "/learning", element: React.createElement(pageExports.LearningPage) },
      { path: "/learning/:workspaceId", element: React.createElement(pageExports.LearningPage) },
    ],
    { initialEntries },
  );
  await act(() => { root.render(React.createElement(RouterProvider, { router })); });
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await settle();
  return { container, router };
}

test("real service: card 加入学习 → draft → preview → confirm → detail works end to end", async (t) => {
  const fixture = await startFixture(t);
  const bound = await fixture.learning.list({ includeArchived: true });
  assert.equal(bound.workspaces.length, 0);
  const { container, router } = await mountApp(t, { origin: fixture.origin });
  await settle();
  await settle();

  // The radar dashboard is real: repositories ranked by the real store.
  await waitText(container, /synthetic\/repo-101/);
  // Established is the deterministic long-tail list; the default rising list is
  // empty without snapshots, so switch to it to see the real cards.
  await clickButton(container, "长期热门");
  await waitText(container, /加入学习/, "join button expected on a real card");
  const joinButton = button(container, "加入学习");
  await act(() => joinButton.click());
  await settle();

  // The draft dialog creates a REAL workspace: server pins the fixed commit.
  await waitText(container, /synthetic\/repo-101/);
  await waitText(container, /预览确认/, "the draft dialog must reach the editing phase");
  await clickButton(container, "预览确认");
  // The preview page shows the server-returned pinned commit and full mission.
  await waitText(container, new RegExp(commitSha("b")), "preview must show the pinned commit");
  await clickButton(container, "确认加入学习");

  // The radar card refreshes with the real learning overlay only after the
  // confirm lands: wait for the active badge on the joined card.
  await waitCardText(container, "synthetic/repo-101", "学习中", "the card must show the active overlay after a real confirm");
  const card101 = [...container.querySelectorAll(".radar-card")].find((article) => article.textContent.includes("synthetic/repo-101"));
  assert.equal([...card101.querySelectorAll("button")].some((b) => b.textContent.trim() === "加入学习"), false, "the joined card must stop offering 加入学习");

  // The server store really holds an active workspace now.
  const after = await fixture.learning.list({ includeArchived: true });
  const joined = after.workspaces.find((item) => item.repositoryId === 101);
  assert.equal(joined.state, "active");
  assert.equal(joined.sourceCommitSha, commitSha("b"));
  assert.equal(joined.fullName, "synthetic/repo-101");;

  // 查看学习 navigates to the real detail page.
  await clickButton(container, "查看学习");
  await waitText(container, /synthetic\/repo-101/, "detail page shows the workspace");
  await waitText(container, new RegExp(commitSha("b")), "detail shows the fixed commit");
  await waitText(container, /学习中/, "detail shows the current state");
  assert.equal(router.state.location.pathname.startsWith("/learning/"), true, "the router really navigated to the detail route");
  await waitText(container, /理解架构/, "detail shows the goal label");
  assert.match(container.textContent, /学习任务工作区/);
});

test("real service: AiRadarPage passes real learning capabilities into the join dialog", async (t) => {
  const fixture = await startFixture(t);
  const { container } = await mountApp(t, { origin: fixture.origin });
  await settle();
  await settle();

  await waitText(container, /synthetic\/repo-101/);
  await clickButton(container, "长期热门");
  // The join button renders only after the real capabilities object arrived.
  await waitText(container, /加入学习/, "join must appear once real learn caps arrive");
  await act(() => button(container, "加入学习").click());
  await settle();

  // Strict dialog gating means the editing phase is reachable ONLY if the page
  // handed its real capabilities object to the dialog; a missing capabilities
  // prop would strand it on creating (no mutation is whitelisted by default).
  await waitText(container, /预览确认/, "the real page must pass capabilities into the dialog");
  const after = await fixture.learning.list({ includeArchived: true });
  const draft = after.workspaces.find((item) => item.repositoryId === 101);
  assert.equal(draft?.state, "draft", "the create request must land through the real server");

  // Closing the dialog never depends on capabilities.
  await clickButton(container, "关闭");
  assert.equal(container.querySelector(".learning-dialog"), null, "close must dismiss the dialog");
});

test("real service: the fourth workspace queues, stays queued at capacity and activates after a slot frees", async (t) => {
  const fixture = await startFixture(t, { activeCount: 3 });
  const pre = await fixture.learning.list({ includeArchived: true });
  assert.equal(pre.workspaces.filter((item) => item.state === "active").length, 3);
  const { container, router } = await mountApp(t, { origin: fixture.origin });
  await settle();
  await settle();

  // Join a fourth repository through the real UI + server.
  await waitText(container, /synthetic\/repo-101/);
  await clickButton(container, "长期热门");
  await waitText(container, /加入学习/);
  await act(() => button(container, "加入学习").click());
  await settle();
  await waitText(container, /预览确认/);
  await clickButton(container, "预览确认");
  await waitText(container, new RegExp(commitSha("b")));
  await clickButton(container, "确认加入学习");

  // The radar card refreshed with the queue overlay only after the confirm
  // lands ("学习中（排队）").
  await waitCardText(container, "synthetic/repo-101", "学习中（排队）", "the 4th confirm must enter the queue with explicit card feedback");

  const after = await fixture.learning.list({ includeArchived: true });
  const joined = after.workspaces.find((item) => item.repositoryId === 101);
  assert.equal(joined.state, "queued");
  assert.equal(joined.sourceCommitSha, commitSha("b"));

  // The learning list groups the queued workspace honestly.
  await act(() => router.navigate("/learning"));
  await settle();
  await waitText(container, /排队中/, "the queue section must render");
  await waitText(container, /synthetic\/repo-101/);

  // Activating at capacity keeps it queued with an explicit reason.
  const queueRow = [...container.querySelectorAll(".learning-item")].find((li) => li.textContent.includes("synthetic/repo-101"));
  assert.ok(queueRow, "the queued row must be visible");
  await act(() => [...queueRow.querySelectorAll("button")].find((b) => b.textContent.trim() === "激活").click());
  await settle();
  await waitText(container, /3 个活跃学习项目上限/, "ACTIVE_LIMIT_REACHED must be surfaced");

  // Free a slot by archiving one active workspace, then activate the queued one.
  const activeRow = [...container.querySelectorAll(".learning-item")].find((li) => li.textContent.includes("synthetic/repo-102"));
  await act(() => [...activeRow.querySelectorAll("button")].find((b) => b.textContent.trim() === "归档学习").click());
  await settle();
  await waitText(container, /学习任务已归档/, "archive notice must confirm");
  const archived = await fixture.learning.list({ includeArchived: true });
  assert.equal(archived.workspaces.find((item) => item.repositoryId === 102).state, "archived");

  await waitText(container, /排队中/);
  const queuedRowAgain = [...container.querySelectorAll(".learning-item")].find((li) => li.textContent.includes("synthetic/repo-101"));
  await act(() => [...queuedRowAgain.querySelectorAll("button")].find((b) => b.textContent.trim() === "激活").click());
  await settle();
  await waitText(container, /已激活，该任务进入学习中/, "activation must succeed once a slot frees");

  const finalState = await fixture.learning.list({ includeArchived: true });
  assert.equal(finalState.workspaces.filter((item) => item.state === "active").length, 3);
  assert.equal(finalState.workspaces.find((item) => item.repositoryId === 101).state, "active");
});

test("real service: read-only vault keeps learning reads and disables every mutation", async (t) => {
  const fixture = await startFixture(t, { projectReadOnly: true, activeCount: 1 });
  const { container, router } = await mountApp(t, { origin: fixture.origin });
  await settle();
  await settle();

  await waitText(container, /synthetic\/repo-101/);
  await clickButton(container, "长期热门");
  await waitText(container, /synthetic\/repo-101/);
  // 加入学习 must be absent: learning create capability is off.
  assert.equal([...container.querySelectorAll("button")].some((b) => b.textContent.trim() === "加入学习"), false, "read-only vault never offers 加入学习");

  // The learning page still reads and renders, with mutations hidden.
  await act(() => router.navigate("/learning"));
  await settle();
  await waitText(container, /synthetic\/repo-102/, "read-only still lists real workspaces");
  await waitText(container, /学习中/);
  assert.equal([...container.querySelectorAll("button")].some((b) => b.textContent.trim() === "编辑任务"), false, "draft editing is hidden");
  assert.equal([...container.querySelectorAll("button")].some((b) => b.textContent.trim() === "激活"), false, "activation is hidden");
  assert.equal([...container.querySelectorAll("button")].some((b) => b.textContent.trim() === "归档学习"), false, "archiving is hidden");
});

test("narrow-screen markup: every core control stays reachable and responsive styles exist", async (t) => {
  const fixture = await startFixture(t);
  const { container, router } = await mountApp(t, { origin: fixture.origin });
  await settle();
  await settle();
  await waitText(container, /synthetic\/repo-101/);
  await clickButton(container, "长期热门");
  await act(() => button(container, "加入学习").click());
  await settle();

  // The editing phase exposes the real five-goal select and editable notes.
  await waitText(container, /预览确认/);
  const goal = container.querySelector("select[name='goal']");
  assert.ok(goal, "the five-goal select must be present");
  assert.equal(goal.options.length, 5);
  const notes = container.querySelector("textarea[name='notes']");
  assert.ok(notes, "the editable notes textarea must be present");
  assert.equal(notes.getAttribute("maxlength"), "4000");

  // The preview phase keeps every confirm control reachable with real labels.
  await clickButton(container, "预览确认");
  await waitText(container, /确认加入学习/);
  const labels = [...container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || b.textContent.trim()).filter(Boolean);
  assert.ok(labels.some((label) => label.includes("返回编辑")));
  assert.ok(labels.some((label) => label.includes("确认加入学习")));

  // Responsive styles for the narrow-screen learning surfaces exist.
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(fileURLToPath(new URL("../src/components/learning/learning.css", import.meta.url)), "utf8");
  assert.match(css, /@media\(max-width:560px\)/, "the dialog has a narrow-screen layout");
  assert.match(css, /@media\(max-width:720px\)/, "the learning page has a narrow-screen layout");
  const radarCss = await readFile(fileURLToPath(new URL("../src/components/ai-radar/ai-radar.css", import.meta.url)), "utf8");
  assert.match(radarCss, /@media\(max-width:720px\)/, "radar cards narrow-screen layout exists");
});