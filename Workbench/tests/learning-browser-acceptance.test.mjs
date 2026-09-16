// Real-browser acceptance for the S3 learning UI (Step 16).
//
// Unlike learning-acceptance.test.mjs (happy-dom + real HTTP), this suite
// drives a REAL Chromium/Chrome/Edge headless browser over CDP against an
// isolated Vite service with temp real stores and a synthetic GitHub adapter.
// It verifies pixel-level viewport behavior, real clicks, dialog scrolling,
// keyboard focus and focus restoration that no DOM emulation can prove.
//
// The browser tooling is system Chrome/Edge via CDP (no extra dependency:
// Node >= 22 ships a WebSocket client). If no browser binary is available the
// tests skip with an explicit message; screenshots and page dumps land in the
// repository-ignored .superpowers/ directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { before, after } from "node:test";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";

import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";
import { createWorkspaceRegistry } from "../server/workspace-state/workspace-registry.mjs";
import { createLearningRepository } from "../server/learning/learning-repository.mjs";

const commitSha = (char) => char.repeat(40);
const artifactsRoot = process.env.LEARNING_BROWSER_ARTIFACTS_DIR
  ?? fileURLToPath(new URL("../../.superpowers/sdd/2026-09-02-ai-radar-core/browser-qa", import.meta.url));

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
  1, 7, 9, 11, 13, 15, 17, 19, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
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

// Real Vite dev app (index.html -> App.jsx) + real plugin over temp real
// registry/radar/learning stores and a synthetic GitHub adapter. envDir points
// at an empty directory so the machine's Workbench/.env never leaks into the
// isolated app (deterministic local mode regardless of local overrides).
async function startFixture(t, { activeCount = 0 } = {}) {
  const stableTempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(stableTempRoot, "workbench-learning-browser-"));
  const vaultRoot = path.join(root, "vault");
  const appDataRoot = path.join(root, "app-data");
  const registryDirectory = path.join(appDataRoot, "PersonalAIWorkbench");
  const envDir = path.join(root, "empty-env");
  await mkdir(path.join(vaultRoot, "wiki"), { recursive: true });
  await mkdir(envDir, { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "plan.md"), "# Project plan\n", "utf8");

  const registry = createWorkspaceRegistry({ directory: registryDirectory });
  const fingerprint = createHash("sha256").update(path.resolve(vaultRoot).toLowerCase()).digest("hex");
  const bound = await registry.resolveVault({ fingerprint, label: "Synthetic Acceptance Vault" });
  const stateRoot = bound.storageLayout === "legacy"
    ? path.join(registryDirectory, bound.workspaceId)
    : path.join(registryDirectory, "workspaces", bound.workspaceId);

  const radarDirectory = path.join(stateRoot, "ai-radar");
  await mkdir(radarDirectory, { recursive: true });
  const radar = await (async () => {
    const { createRadarRepository } = await import("../server/ai-radar/radar-repository.mjs");
    const item = createRadarRepository({ directory: radarDirectory, timeZone: "UTC" });
    await item.updateSchedule({ time: "11:30" });
    await item.upsertRepositories([101, 102, 103, 104, 105, 106].map((id) => syntheticRepository(id)));
    return item;
  })();

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
    if (index === 0) {
      // The first seeded workspace carries authored content and a stored
      // ingestion target (the current temp vault), so the Obsidian panel on
      // its detail page is in its normal interactive state.
      const workspaceId = draft.workspace.workspaceId;
      const binding = { repositoryId: id, sourceCommitSha: commitSha("a"), sourceUrl: `https://github.com/synthetic/repo-${id}` };
      await learning.content.savePlan({
        workspaceId,
        expectedRevision: null,
        plan: { learningGoal: "理解该仓库的核心架构", expectedOutcome: "能够说明关键取舍并完成小实验", milestones: [], currentMilestone: null },
        binding,
      });
      await learning.content.saveNotes({
        workspaceId,
        expectedRevision: 1,
        notes: { markdownText: "合成学习笔记正文，用于浏览器验收。" },
        binding,
      });
      await learning.ingestion.setSelection({
        workspaceId,
        targetVaultId: fingerprint,
        targetVaultDisplayName: "Synthetic Acceptance Vault",
        targetMaskedPath: "…/vault",
      });
    }
  }

  const github = syntheticGitHub();
  const workbenchRoot = fileURLToPath(new URL("..", import.meta.url));
  const vite = await createViteServer({
    configFile: false,
    root: workbenchRoot,
    logLevel: "silent",
    server: { middlewareMode: true },
    envDir,
    plugins: [react(), workbenchApiPlugin({
      vaultRoot,
      profile: "default",
      appDataRoot,
      projectDirectory: null,
      radarDirectory: null,
      readOnly: false,
      projectReadOnly: false,
      hosted: false,
      radarOptions: { github },
    })],
  });
  const server = http.createServer(vite.middlewares);
  await listenOnFetchSafePort(server);
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Pre-warm cold server paths so the browser's first dashboard read never
  // races the app's 12s request timeout (one-time file/lock costs can spike
  // on a fresh temp fixture). GETs only.
  for (const warmPath of [
    "/api/ai-radar/capabilities",
    "/api/ai-radar?period=day&state=all&focus=all&learning=all",
    "/api/ai-radar/preferences",
    "/api/learning",
  ]) {
    const warmed = await fetch(`${origin}${warmPath}`);
    await warmed.text();
    if (!warmed.ok) throw new Error(`fixture warm-up failed for ${warmPath} (${warmed.status})`);
  }

  t.after(async () => {
    // The page keeps an SSE /api/vault/events connection and fetch keep-alives
    // open; without force-closing them, server.close() would never resolve.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await vite.close();
    await rm(root, { recursive: true, force: true });
  });
  return { origin, root, stateRoot, radar, learning, github };
}

// --- Minimal CDP driver over the Node built-in WebSocket ---------------------

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Set();
    let nextId = 0;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = ++nextId;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() { try { ws.close(); } catch { /* already closed */ } },
    });
    ws.onerror = () => reject(new Error("CDP WebSocket connection failed"));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(`CDP error: ${message.error.message}`));
        else res(message.result);
      } else if (message.method) {
        for (const listener of [...listeners]) listener(message.method, message.params);
      }
    };
  });
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

async function launchChrome() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error(`no Chrome/Edge binary found in ${CHROME_CANDIDATES.join(", ")}`);
  const userDataDir = await mkdtemp(path.join(await realpath(os.tmpdir()), "learning-browser-"));
  const child = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "about:blank",
  ], { stdio: "ignore" });
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  let port = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const content = await readFile(portFile, "utf8");
      const parsed = Number(String(content).split("\n")[0]);
      if (Number.isInteger(parsed) && parsed > 0) { port = parsed; break; }
    } catch { /* not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port) {
    child.kill();
    throw new Error("Chrome did not open the DevTools port");
  }
  return { child, port, userDataDir, chromePath };
}

async function newPage(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`CDP /json/new failed: ${response.status}`);
  const target = await response.json();
  const session = await connectCdp(target.webSocketDebuggerUrl);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  return { session, target };
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`page evaluation failed: ${detail}`);
  }
  return result.result?.value;
}

async function waitFor(session, expression, label, { timeout = 45000, interval = 200 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await evaluate(session, expression);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function clickText(session, text) {
  const clicked = await evaluate(session, `(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(${JSON.stringify(text)}));
    if (!b) return false;
    b.scrollIntoView({ block: "center" });
    b.click();
    return true;
  })()`);
  assert.equal(clicked, true, `expected a clickable control labelled ${text}`);
}

async function setSelect(session, name, value) {
  await evaluate(session, `(() => {
    const s = document.querySelector(${JSON.stringify(`select[name="${name}"]`)});
    s.value = ${JSON.stringify(value)};
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return s.value;
  })()`);
}

async function setText(session, name, value) {
  await evaluate(session, `(() => {
    const el = document.querySelector(${JSON.stringify(`textarea[name="${name}"]`)});
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  })()`);
}

async function screenshot(session, name) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png" });
  await mkdir(artifactsRoot, { recursive: true });
  const file = path.join(artifactsRoot, name);
  await writeFile(file, Buffer.from(data, "base64"));
  return file;
}

// --- Shared browser lifecycle ------------------------------------------------

let chrome = null;
let chromeLaunchError = null;
before(async () => {
  try {
    chrome = await launchChrome();
  } catch (error) {
    chromeLaunchError = error;
  }
});

after(async () => {
  if (chrome) {
    try { chrome.child.kill(); } catch { /* already gone */ }
    // Give the browser a moment to release its profile before removal.
    await Promise.race([
      new Promise((resolve) => chrome.child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(chrome.userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
        return;
      } catch (error) {
        if (attempt === 9) console.error(`browser profile cleanup failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
});

async function openPage(t, origin, pathname, { width = 1280, height = 800 } = {}) {
  if (!chrome) {
    t.skip(`real browser unavailable: ${chromeLaunchError?.message ?? "unknown"}`);
    return null;
  }
  const { session, target } = await newPage(chrome.port, `${origin}${pathname}`);
  await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await session.send("Page.navigate", { url: `${origin}${pathname}` });
  await waitFor(session, "document.readyState === 'complete'", "initial document load");
  t.after(() => { try { session.close(); } catch { /* already closed */ } });
  return { session, target };
}

// --- Scenarios ---------------------------------------------------------------

test("real browser: card 加入学习 → draft → preview → confirm → detail works end to end", async (t) => {
  const fixture = await startFixture(t);
  const page = await openPage(t, fixture.origin, "/ai-radar?period=day");
  if (!page) return;
  const { session } = page;

  // Real dashboard over the real store.
  await waitFor(session, "document.body && document.body.textContent.includes('synthetic/repo-101')", "radar dashboard");
  await clickText(session, "长期热门");
  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('加入学习'))", "join button");
  await clickText(session, "加入学习");

  // The draft dialog really creates a workspace and pins the commit.
  await waitFor(session, "!!document.querySelector('.learning-dialog')", "draft dialog");
  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('预览确认'))", "editing phase");
  await setSelect(session, "goal", "analyze-design");
  await setText(session, "notes", "Real browser review notes.");
  await clickText(session, "预览确认");
  await waitFor(session, `document.body.textContent.includes(${JSON.stringify(commitSha("b"))})`, "pinned commit in preview");
  await screenshot(session, "01-preview.png");

  await clickText(session, "确认加入学习");
  const cardJoined = await waitFor(session, `(() => {
    const card = [...document.querySelectorAll(".radar-card")].find((a) => a.textContent.includes("synthetic/repo-101"));
    return card && card.textContent.includes("学习中");
  })()`, "active badge on the joined card");
  assert.equal(cardJoined, true);

  // The server store really holds an active workspace.
  const after = await fixture.learning.list({ includeArchived: true });
  const joined = after.workspaces.find((item) => item.repositoryId === 101);
  assert.equal(joined.state, "active");
  assert.equal(joined.sourceCommitSha, commitSha("b"));

  // 查看学习 opens the real detail route.
  await clickText(session, "查看学习");
  await waitFor(session, "location.pathname.startsWith('/learning/')", "detail route");
  await waitFor(session, "document.body.textContent.includes('synthetic/repo-101') && document.body.textContent.includes('分析设计')", "detail content");
  await waitFor(session, "document.body.textContent.includes('学习中')", "detail state");
  await screenshot(session, "02-detail.png");
});

test("real browser: the fourth workspace queues, archives free a slot and activation succeeds", async (t) => {
  const fixture = await startFixture(t, { activeCount: 3 });
  const pre = await fixture.learning.list({ includeArchived: true });
  assert.equal(pre.workspaces.filter((item) => item.state === "active").length, 3);
  const page = await openPage(t, fixture.origin, "/ai-radar?period=day");
  if (!page) return;
  const { session } = page;

  // Join a fourth repository through the real UI.
  await waitFor(session, "document.body.textContent.includes('synthetic/repo-101')", "radar dashboard");
  await clickText(session, "长期热门");
  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('加入学习'))", "join button");
  await clickText(session, "加入学习");
  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('预览确认'))", "editing phase");
  await clickText(session, "预览确认");
  await waitFor(session, `document.body.textContent.includes(${JSON.stringify(commitSha("b"))})`, "pinned commit");
  await clickText(session, "确认加入学习");
  await waitFor(session, `(() => {
    const card = [...document.querySelectorAll(".radar-card")].find((a) => a.textContent.includes("synthetic/repo-101"));
    return card && card.textContent.includes("学习中（排队）");
  })()`, "queued badge on the 4th join");
  await screenshot(session, "03-queued-badge.png");

  const queuedAfter = await fixture.learning.list({ includeArchived: true });
  const joined = queuedAfter.workspaces.find((item) => item.repositoryId === 101);
  assert.equal(joined.state, "queued");

  // The learning list groups the queued workspace honestly; activating at
  // capacity keeps it queued with an explicit reason.
  await evaluate(session, "location.href = '/learning'");
  await waitFor(session, "document.readyState === 'complete'", "reload to list");
  await waitFor(session, "[...document.querySelectorAll('.learning-section__title')].some((x) => x.textContent.includes('排队'))", "queue section");
  await waitFor(session, `(() => { const li = [...document.querySelectorAll('.learning-item')].find((x) => x.textContent.includes('synthetic/repo-101')); return li && [...li.querySelectorAll('button')].some((b) => b.textContent.trim() === '激活'); })()`, "queued row activate");
  await evaluate(session, `(() => { const li = [...document.querySelectorAll('.learning-item')].find((x) => x.textContent.includes('synthetic/repo-101')); [...li.querySelectorAll('button')].find((b) => b.textContent.trim() === '激活').click(); return true; })()`);
  await waitFor(session, "document.body.textContent.includes('已达 3 个活跃学习项目上限')", "capacity limit notice");

  // Archive one active workspace to free a slot, then activate the queued one.
  await evaluate(session, `(() => { const li = [...document.querySelectorAll('.learning-item')].find((x) => x.textContent.includes('synthetic/repo-102')); [...li.querySelectorAll('button')].find((b) => b.textContent.trim() === '归档学习').click(); return true; })()`);
  await waitFor(session, "document.body.textContent.includes('学习任务已归档')", "archive notice");
  await waitFor(session, `(() => {
    const li = [...document.querySelectorAll('.learning-item')].find((x) => x.textContent.includes('synthetic/repo-101'));
    if (!li) return false;
    const b = [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === '激活');
    return Boolean(b && !b.disabled);
  })()`, "re-activate button enabled");
  await evaluate(session, `(() => { const li = [...document.querySelectorAll('.learning-item')].find((x) => x.textContent.includes('synthetic/repo-101')); [...li.querySelectorAll('button')].find((b) => b.textContent.trim() === '激活').click(); return true; })()`);
  await waitFor(session, "document.body.textContent.includes('已激活，该任务进入学习中')", "activation success notice");
  await screenshot(session, "04-activated.png");

  const finalState = await fixture.learning.list({ includeArchived: true });
  assert.equal(finalState.workspaces.find((item) => item.repositoryId === 101).state, "active");
  assert.equal(finalState.workspaces.find((item) => item.repositoryId === 102).state, "archived");
});

test("real browser: a detail activation failure is visible and retry succeeds", async (t) => {
  const fixture = await startFixture(t, { activeCount: 3 });
  // The 4th confirm queues; then free a slot so the retry can succeed.
  const seeded = await fixture.learning.list({ includeArchived: true });
  const queuedDraft = await fixture.learning.createDraft({
    repositoryId: 106,
    fullName: "synthetic/repo-106",
    sourceUrl: "https://github.com/synthetic/repo-106",
    sourceCommitSha: commitSha("a"),
    mission: { goal: "learn-usage", notes: "Queued for failure retry scenario" },
  });
  const queuedPage = await fixture.learning.preview({ workspaceId: queuedDraft.workspace.workspaceId });
  const queuedConfirm = await fixture.learning.confirm({ token: queuedPage.token });
  assert.equal(queuedConfirm.confirmed, "queued");
  await fixture.learning.archive(seeded.workspaces.find((item) => item.repositoryId === 102).workspaceId);
  const queued = (await fixture.learning.list({ includeArchived: true })).workspaces.find((item) => item.repositoryId === 106);
  assert.equal(queued.state, "queued");

  const page = await openPage(t, fixture.origin, `/learning/${encodeURIComponent(queued.workspaceId)}`);
  if (!page) return;
  const { session } = page;
  await waitFor(session, "document.body.textContent.includes('排队')", "queued detail");
  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '激活')", "activate button");

  // Intercept the activate request at the network layer and fail it once.
  let intercepted = 0;
  const unsubscribe = session.subscribe((method, params) => {
    if (method !== "Fetch.requestPaused") return;
    intercepted += 1;
    if (intercepted === 1) {
      const body = JSON.stringify({ error: { code: "LEARNING_STORAGE_CORRUPT", message: "学习存储异常，激活未执行，请重试。" } });
      session.send("Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: 500,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: Buffer.from(body).toString("base64"),
      }).catch(() => {});
    } else {
      session.send("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
    }
  });
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "*activat*", requestStage: "Request" }] });
  await clickText(session, "激活");
  await waitFor(session, "document.body.textContent.includes('激活失败') && document.body.textContent.includes('学习存储异常')", "injected activation failure");
  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('重试激活'))", "retry entry");
  assert.ok(intercepted >= 1, "the activate request must have been intercepted");
  await screenshot(session, "05-detail-failure.png");

  // Let the real request through and retry: it must succeed now.
  await session.send("Fetch.disable");
  unsubscribe();
  await clickText(session, "重试激活");
  await waitFor(session, "document.body.textContent.includes('已激活') && document.body.textContent.includes('学习中')", "successful retry");
  await screenshot(session, "06-detail-retry.png");

  const final = (await fixture.learning.list({ includeArchived: true })).workspaces.find((item) => item.repositoryId === 106);
  assert.equal(final.state, "active");
});

test("real browser: desktop and narrow viewports keep controls visible, clickable and inside the viewport with no horizontal overflow", async (t) => {
  const fixture = await startFixture(t, { activeCount: 1 });
  // Seed one draft to exercise editing on the list page.
  const draftSeed = await fixture.learning.createDraft({
    repositoryId: 105,
    fullName: "synthetic/repo-105",
    sourceUrl: "https://github.com/synthetic/repo-105",
    sourceCommitSha: commitSha("a"),
    mission: { goal: "adoption-decision", notes: "Draft for narrow layout check" },
  });
  void draftSeed;

  const viewportChecks = async (session, label) => {
    const result = await evaluate(session, `(() => {
      const root = document.documentElement;
      const bad = [];
      for (const b of document.querySelectorAll("button")) {
        // App chrome (sidebar / mobile header) slides offscreen at narrow
        // widths by design; the learning feature's own controls are the
        // acceptance surface.
        if (b.closest(".sidebar, .mobile-header")) continue;
        const r = b.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const cs = getComputedStyle(b);
        let rect = r;
        let visible = rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
        // A form-style detail page legitimately scrolls: reach each control
        // the way a user would before calling it broken.
        if (!visible) {
          b.scrollIntoView({ block: "center", inline: "nearest" });
          rect = b.getBoundingClientRect();
          visible = rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
        }
        const actionable = visible && cs.pointerEvents !== "none" && !b.disabled;
        if (!actionable) bad.push({ text: b.textContent.trim().slice(0, 24), disabled: b.disabled, left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) });
      }
      return {
        overflow: root.scrollWidth > root.clientWidth + 1,
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        innerWidth,
        innerHeight,
        bad,
      };
    })()`);
    assert.equal(result.overflow, false, `${label}: horizontal overflow (scrollWidth ${result.scrollWidth} > clientWidth ${result.clientWidth})`);
    assert.deepEqual(result.bad, [], `${label}: buttons outside the viewport or not actionable: ${JSON.stringify(result.bad)}`);
  };

  // Desktop list page.
  const desktop = await openPage(t, fixture.origin, "/learning", { width: 1280, height: 800 });
  if (!desktop) return;
  await waitFor(desktop.session, "document.body.textContent.includes('synthetic/repo-102')", "desktop list");
  await viewportChecks(desktop.session, "desktop /learning");
  await screenshot(desktop.session, "07-desktop-list.png");

  // Narrow list + detail + dialog.
  const narrowList = await openPage(t, fixture.origin, "/learning", { width: 390, height: 844 });
  if (!narrowList) return;
  await waitFor(narrowList.session, "document.body.textContent.includes('synthetic/repo-102')", "narrow list");
  await viewportChecks(narrowList.session, "narrow /learning");
  await screenshot(narrowList.session, "08-narrow-list.png");

  const seededList = await fixture.learning.list({ includeArchived: true });
  const workspaceTarget = seededList.workspaces.find((item) => item.repositoryId === 102) ?? seededList.workspaces[0];

  const detail = await openPage(t, fixture.origin, "/learning", { width: 390, height: 844 });
  if (!detail) return;
  await detail.session.send("Page.navigate", { url: `${fixture.origin}/learning/${encodeURIComponent(workspaceTarget.workspaceId)}` });
  await waitFor(detail.session, "document.body.textContent.includes('synthetic/repo-102')", "narrow detail");
  await waitFor(detail.session, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '归档学习')", "detail archive button");
  // The Obsidian panel resolves its target vault asynchronously; until
  // loadTargets() returns, the 预览写入 button is disabled (no selected
  // vault). Wait on the real DOM state before asserting every control is
  // actionable — never relax the disabled check in viewportChecks.
  await waitFor(detail.session, `(() => {
    const target = document.querySelector("#learning-ingestion-target");
    const preview = document.querySelector(".learning-ingestion__preview");
    return Boolean(target && !target.disabled && preview && !preview.disabled);
  })()`, "ingestion targets loaded and preview writable");
  await viewportChecks(detail.session, "narrow detail");
  await screenshot(detail.session, "09-narrow-detail.png");

  // The draft dialog at narrow width: the goal select + notes + actions stay
  // reachable and the dialog is the scrolling container.
  const dialog = await openPage(t, fixture.origin, "/ai-radar?period=day", { width: 390, height: 844 });
  if (!dialog) return;
  await waitFor(dialog.session, "document.body.textContent.includes('synthetic/repo-101')", "radar dashboard");
  await clickText(dialog.session, "长期热门");
  await waitFor(dialog.session, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('加入学习'))", "join button");
  await clickText(dialog.session, "加入学习");
  await waitFor(dialog.session, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('预览确认'))", "dialog editing");
  const narrowDialog = await evaluate(dialog.session, `(() => {
    const d = document.querySelector(".learning-dialog");
    const s = document.querySelector("select[name='goal']");
    const t = document.querySelector("textarea[name='notes']");
    const sr = s.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    return {
      goalVisible: sr.left >= 0 && sr.top >= 0 && sr.right <= innerWidth && sr.bottom <= innerHeight,
      notesVisible: tr.left >= 0 && tr.top >= 0 && tr.right <= innerWidth,
      scrollable: d.scrollHeight > d.clientHeight,
      dialogHeight: d.clientHeight,
      bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  assert.equal(narrowDialog.goalVisible, true, "goal select reachable at narrow width");
  assert.equal(narrowDialog.notesVisible, true, "notes textarea reachable at narrow width");
  assert.equal(narrowDialog.bodyOverflow, false, "no horizontal overflow with the dialog open");
  await screenshot(dialog.session, "10-narrow-dialog.png");
});

test("real browser: dialog scrolls, receives keyboard focus and restores focus after close", async (t) => {
  const fixture = await startFixture(t);
  // A draft workspace on the learning list gives a stable trigger: the 编辑任务
  // button keeps its DOM node across list refreshes (keyed reconciliation), so
  // focus restoration is deterministic.
  await fixture.learning.createDraft({
    repositoryId: 105,
    fullName: "synthetic/repo-105",
    sourceUrl: "https://github.com/synthetic/repo-105",
    sourceCommitSha: commitSha("a"),
    mission: { goal: "understand-architecture", notes: "Draft for focus acceptance" },
  });
  const page = await openPage(t, fixture.origin, "/learning", { width: 1280, height: 800 });
  if (!page) return;
  const { session } = page;

  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '编辑任务')", "edit button on the draft");

  // Focus the trigger, then open the dialog: focus must move into the dialog.
  await evaluate(session, `(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "编辑任务");
    window.__learningTrigger = b;
    b.focus();
    b.click();
    return true;
  })()`);
  await waitFor(session, "!!document.querySelector('.learning-dialog')", "dialog open");
  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('预览确认'))", "editing phase");
  const focusInside = await evaluate(session, "document.querySelector('.learning-dialog').contains(document.activeElement)");
  assert.equal(focusInside, true, "focus must land inside the dialog on open");

  // A real Tab key keeps focus inside the dialog's controls.
  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  const tabFocused = await evaluate(session, `(() => {
    const active = document.activeElement;
    return { inside: document.querySelector('.learning-dialog')?.contains(active) ?? false, tag: active?.tagName, name: active?.getAttribute('name') ?? active?.getAttribute('aria-label') ?? '' };
  })()`);
  assert.equal(tabFocused.inside, true, "Tab must cycle within the dialog");

  // Long notes (with newlines) overflow the dialog box in the preview phase:
  // the preview renders them with pre-wrap, so the dialog becomes its own
  // scrolling container (the notes textarea itself scrolls internally and is
  // not a proxy for dialog scrolling).
  await setText(session, "notes", "学习任务笔记行\n".repeat(160) + "end");
  const notesInfo = await evaluate(session, `(function () {
    const t = document.querySelector("textarea[name='notes']");
    return { valueLength: t.value.length };
  })()`);
  assert.equal(notesInfo.valueLength, 160 * 8 + 3, `the notes field must hold the typed value (got ${notesInfo.valueLength})`);
  await clickText(session, "预览确认");
  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('确认加入学习'))", "preview phase");
  const scrollState = await evaluate(session, `(function () {
    const d = document.querySelector(".learning-dialog");
    d.scrollTop = d.scrollHeight;
    return { scrollTop: d.scrollTop, scrollHeight: d.scrollHeight, clientHeight: d.clientHeight };
  })()`);
  assert.ok(scrollState.scrollHeight > scrollState.clientHeight, `dialog content must overflow its box (scrollHeight ${scrollState.scrollHeight} <= clientHeight ${scrollState.clientHeight})`);
  assert.ok(scrollState.scrollTop > 0, "dialog must actually scroll");

  // Back to editing, then closing restores focus to the trigger button.
  await clickText(session, "返回编辑");
  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '关闭')", "editing close button");
  await evaluate(session, `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '关闭'); b.click(); return true; })()`);
  await waitFor(session, "!document.querySelector('.learning-dialog')", "dialog closed");
  const restored = await evaluate(session, "document.activeElement === window.__learningTrigger && !!window.__learningTrigger");
  assert.equal(restored, true, "focus must return to the trigger after close");
  await screenshot(session, "11-focus-restored.png");
});

test("real browser: the Obsidian panel previews into the selected vault and confirm writes real files", async (t) => {
  const fixture = await startFixture(t, { activeCount: 1 });
  const seededList = await fixture.learning.list({ includeArchived: true });
  const workspaceTarget = seededList.workspaces.find((item) => item.repositoryId === 102);
  assert.ok(workspaceTarget, "the seeded active workspace must exist for the ingestion flow");

  const page = await openPage(t, fixture.origin, `/learning/${workspaceTarget.workspaceId}`);
  if (!page) return;
  const { session } = page;

  // The panel renders with the seeded target vault selected (the current temp
  // vault) and the writable candidate marked with its vault status.
  await waitFor(session, "!!document.querySelector('#learning-ingestion-target')", "ingestion target selector");
  await waitFor(session, "[...document.querySelectorAll('#learning-ingestion-target option')].some((o) => o.textContent.includes('当前'))", "current-vault candidate");
  await waitFor(session, "document.querySelector('#learning-ingestion-target').value.length === 64", "seeded target selected");
  assert.equal(await evaluate(session, "document.querySelector('#learning-ingestion-target').value"), createHash("sha256").update(path.resolve(fixture.root, "vault").toLowerCase()).digest("hex"));

  // Preview surfaces the plan/notes files with relative paths and content.
  await clickText(session, "预览写入");
  await waitFor(session, "document.body.textContent.includes('Wiki/学习/synthetic-repo-102/学习计划.md')", "plan preview path");
  await waitFor(session, "document.body.textContent.includes('Wiki/学习/synthetic-repo-102/学习笔记.md')", "notes preview path");
  await waitFor(session, "document.body.textContent.includes('理解该仓库的核心架构')", "plan content preview");
  await waitFor(session, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('确认写入 Obsidian'))", "confirm button");
  await screenshot(session, "12-ingestion-preview.png");

  // Confirming writes the real files into the target vault and records the write.
  await clickText(session, "确认写入 Obsidian");
  await waitFor(session, "document.body.textContent.includes('已写入 Obsidian')", "write success");
  await waitFor(session, "document.body.textContent.includes('synthetic-repo-102/学习计划.md')", "written file listed");
  await screenshot(session, "13-ingestion-written.png");

  const planFile = path.join(fixture.root, "vault", "Wiki", "学习", "synthetic-repo-102", "学习计划.md");
  const notesFile = path.join(fixture.root, "vault", "Wiki", "学习", "synthetic-repo-102", "学习笔记.md");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(planFile) && existsSync(notesFile)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(existsSync(planFile), "学习计划.md must land in the target vault");
  assert.ok(existsSync(notesFile), "学习笔记.md must land in the target vault");
  assert.match(await readFile(planFile, "utf8"), /理解该仓库的核心架构/);
  assert.match(await readFile(notesFile, "utf8"), /合成学习笔记/);

  // The success never flips the learning workspace state: it stays active and
  // the ingestion history records a written entry.
  assert.equal((await fixture.learning.get(workspaceTarget.workspaceId)).workspace.state, "active");
  const records = await fixture.learning.ingestion.listRecords(workspaceTarget.workspaceId);
  assert.equal(records.records[0].status, "written");
  assert.deepEqual(records.records[0].writtenFiles.map((file) => file.replace(/\\/g, "/")), [
    "Wiki/学习/synthetic-repo-102/学习计划.md",
    "Wiki/学习/synthetic-repo-102/学习笔记.md",
  ]);
});