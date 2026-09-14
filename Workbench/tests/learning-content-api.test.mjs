import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer as createViteServer } from "vite";
import { createRadarRepository } from "../server/ai-radar/radar-repository.mjs";
import { createLearningRepository, LearningWorkspaceError } from "../server/learning/learning-repository.mjs";
import { createLearningService } from "../server/learning/learning-service.mjs";
import { createSummaryRepository } from "../server/summaries/summary-repository.mjs";
import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";
import { createWorkspaceRegistry } from "../server/workspace-state/workspace-registry.mjs";

const commitSha = (char) => char.repeat(40);
const isService = (code) => (error) => error instanceof LearningWorkspaceError && error.code === code;

function syntheticRepository(id = 101, patch = {}) {
  return {
    id,
    fullName: `synthetic/repository-${id}`,
    htmlUrl: `https://github.com/synthetic/repository-${id}`,
    description: "Synthetic demo repository",
    language: "JavaScript",
    topics: ["agents"],
    focusAreas: ["agent"],
    stars: 100,
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

async function request(origin, route, { method = "GET", body, headers } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

// Mirrors the sibling learning-api fixture: real Vite plugin server, temp
// appDataRoot (never the real AppData), deterministic pre-bound workspace,
// synthetic GitHub at the external seam. radarDirectory may host the radar
// store outside the bound workspace so the race tests can rebind.
async function startFixture(t, { projectReadOnly = false, readOnly = false, profile = "default", hosted = false, radarDirectory = null, seed = async () => {} } = {}) {
  const stableTempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(stableTempRoot, "workbench-learning-content-api-"));
  const vaultRoot = path.join(root, "vault");
  const appDataRoot = path.join(root, "app-data");
  const registryDirectory = path.join(appDataRoot, "PersonalAIWorkbench");
  await mkdir(path.join(vaultRoot, "wiki"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "plan.md"), "# Project plan\n", "utf8");
  let boundStateRoot = null;
  let boundWorkspaceId = null;
  const github = syntheticGitHub();
  const resolvedRadarDirectory = radarDirectory
    ? (path.isAbsolute(radarDirectory) ? radarDirectory : path.join(root, radarDirectory))
    : null;
  const vite = await createViteServer({
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [workbenchApiPlugin({
      vaultRoot,
      profile,
      appDataRoot,
      projectDirectory: null,
      radarDirectory: resolvedRadarDirectory,
      readOnly,
      projectReadOnly,
      hosted,
      radarOptions: { github },
    })],
  });
  const registry = createWorkspaceRegistry({ directory: registryDirectory });
    const fingerprint = createHash("sha256").update(path.resolve(vaultRoot).toLowerCase()).digest("hex");
    const workspace = await registry.resolveVault({ fingerprint, label: "Synthetic Learning Content Vault" });
    boundWorkspaceId = workspace.workspaceId;
    boundStateRoot = workspace.storageLayout === "legacy"
      ? path.join(registryDirectory, workspace.workspaceId)
      : path.join(registryDirectory, "workspaces", workspace.workspaceId);
  await seed({ vaultRoot, appDataRoot, registryDirectory, stateRoot: boundStateRoot, workspaceId: boundWorkspaceId, radarDirectory: resolvedRadarDirectory });
  const server = http.createServer(vite.middlewares);
  await listenOnFetchSafePort(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await vite.close();
    await rm(root, { recursive: true, force: true });
  });
  return { origin, root, vaultRoot, appDataRoot, registryDirectory, stateRoot: boundStateRoot, workspaceId: boundWorkspaceId, github };
}

function seedRadar(repos) {
  return async ({ stateRoot }) => {
    const radar = createRadarRepository({ directory: path.join(stateRoot, "ai-radar"), timeZone: "UTC" });
    await radar.updateSchedule({ time: "11:30" });
    if (repos?.length) await radar.upsertRepositories(repos);
  };
}

function summarySections(patch = {}) {
  return {
    problemSolved: "为个人 AI 工作流提供可解释的本地雷达。",
    coreCapabilities: "候选发现、本地涨星观察、三榜单。",
    techStack: "Node.js ESM、React 19、Vite 6。",
    keyModules: "radar-repository、learning-repository。",
    suitableUseCases: "想快速了解 AI 仓库的人",
    unsuitableUseCases: "不适合把 Trending 抓取当核心数据源。",
    learningGoalCandidates: "理解雷达的确定性排名设计",
    risksAndBoundaries: "不自动执行仓库脚本。",
    ...patch,
  };
}

function seedSummaryAt(stateRoot, { repositoryId = 101, sourceCommitSha = commitSha("b"), sections = summarySections() } = {}) {
  return async () => {
    const summaries = createSummaryRepository({ directory: path.join(stateRoot, "summaries") });
    await summaries.persistSummary({
      repositoryId,
      fullName: "synthetic/repository-101",
      sourceUrl: "https://github.com/synthetic/repository-101",
      sourceCommitSha,
      readmeSha: null,
      readmeRef: null,
      readmePath: null,
      sections,
      model: { providerId: "synthetic", modelId: "demo" },
      workflowVersion: 1,
    });
  };
}

function plan(patch = {}) {
  return {
    learningGoal: "理解该仓库的核心架构",
    expectedOutcome: "能够说明关键取舍并完成小实验",
    milestones: [],
    currentMilestone: null,
    ...patch,
  };
}

function notes(text = "这里是合成学习笔记正文") {
  return { markdownText: text };
}

function artifact(patch = {}) {
  return {
    type: "总结",
    title: "架构分析",
    markdownText: "合成产出正文，无真实内容。",
    ...patch,
  };
}

async function createWorkspace(origin, repositoryId = 101) {
  const created = await request(origin, "/api/learning/drafts", {
    method: "POST",
    body: { repositoryId, mission: { goal: "understand-architecture", notes: "Synthetic study task" } },
  });
  assert.equal(created.response.status, 201);
  return created.body.workspace;
}

test("content starts empty, then plan/notes/artifacts write bound content through the real plugin", async (t) => {
  const { origin } = await startFixture(t, { seed: seedRadar([syntheticRepository(101)]) });
  const workspace = await createWorkspace(origin);

  const empty = await request(origin, `/api/learning/${workspace.workspaceId}/content`);
  assert.equal(empty.response.status, 200);
  assert.equal(empty.body.content, null);

  const savedPlan = await request(origin, `/api/learning/${workspace.workspaceId}/plan`, {
    method: "PATCH",
    body: { expectedRevision: null, plan: plan() },
  });
  assert.equal(savedPlan.response.status, 200);
  assert.equal(savedPlan.body.content.revision, 1);
  // The persisted content is bound to the workspace's fixed source, not to any
  // browser-supplied identity.
  assert.equal(savedPlan.body.content.repositoryId, workspace.repositoryId);
  assert.equal(savedPlan.body.content.sourceCommitSha, workspace.sourceCommitSha);
  assert.equal(savedPlan.body.content.sourceUrl, `https://github.com/synthetic/repository-101`);
  assert.equal(savedPlan.body.content.learningPlan.learningGoal, "理解该仓库的核心架构");

  const savedNotes = await request(origin, `/api/learning/${workspace.workspaceId}/notes`, {
    method: "PATCH",
    body: { expectedRevision: 1, notes: notes() },
  });
  assert.equal(savedNotes.response.status, 200);
  assert.equal(savedNotes.body.content.revision, 2);
  assert.equal(savedNotes.body.content.notes.markdownText, "这里是合成学习笔记正文");

  const added = await request(origin, `/api/learning/${workspace.workspaceId}/artifacts`, {
    method: "POST",
    body: { expectedRevision: 2, artifact: artifact() },
  });
  assert.equal(added.response.status, 200);
  assert.equal(added.body.content.revision, 3);
  assert.equal(added.body.content.artifacts.length, 1);

  const artifacts = await request(origin, `/api/learning/${workspace.workspaceId}/artifacts`);
  assert.equal(artifacts.response.status, 200);
  assert.equal(artifacts.body.artifacts.length, 1);
  assert.equal(artifacts.body.artifacts[0].title, "架构分析");

  const content = await request(origin, `/api/learning/${workspace.workspaceId}/content`);
  assert.equal(content.body.content.revision, 3);
  assert.equal(content.body.content.notes.markdownText, "这里是合成学习笔记正文");
  assert.ok(typeof content.body.content.notes.updatedAt === "string" && content.body.content.notes.updatedAt.length > 0);
});

test("revision conflicts return 409 and never overwrite newer content", async (t) => {
  const { origin } = await startFixture(t, { seed: seedRadar([syntheticRepository(101)]) });
  const workspace = await createWorkspace(origin);
  const savedPlan = await request(origin, `/api/learning/${workspace.workspaceId}/plan`, {
    method: "PATCH",
    body: { expectedRevision: null, plan: plan() },
  });
  assert.equal(savedPlan.body.content.revision, 1);
  const savedNotes = await request(origin, `/api/learning/${workspace.workspaceId}/notes`, {
    method: "PATCH",
    body: { expectedRevision: 1, notes: notes("v2") },
  });
  assert.equal(savedNotes.body.content.revision, 2);

  // Now the plan revision is 2; a write that still believes revision 1 is stale.
  const stale = await request(origin, `/api/learning/${workspace.workspaceId}/plan`, {
    method: "PATCH",
    body: { expectedRevision: 1, plan: plan({ learningGoal: "旧请求想覆盖" }) },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "REVISION_CONFLICT");

  const staleNote = await request(origin, `/api/learning/${workspace.workspaceId}/notes`, {
    method: "PATCH",
    body: { expectedRevision: 1, notes: notes("v3 应该被拒绝") },
  });
  assert.equal(staleNote.response.status, 409);
  assert.equal(staleNote.body.error.code, "REVISION_CONFLICT");

  const content = await request(origin, `/api/learning/${workspace.workspaceId}/content`);
  assert.equal(content.body.content.revision, 2);
  assert.equal(content.body.content.learningPlan.learningGoal, "理解该仓库的核心架构");
  assert.equal(content.body.content.notes.markdownText, "v2");

  const next = await request(origin, `/api/learning/${workspace.workspaceId}/notes`, {
    method: "PATCH",
    body: { expectedRevision: 2, notes: notes("v4") },
  });
  assert.equal(next.response.status, 200);
  assert.equal(next.body.content.revision, 3);
  assert.equal(next.body.content.notes.markdownText, "v4");
});

test("hosted hides content data and mutations; read-only allows reads but rejects writes", async (t) => {
  const hosted = await startFixture(t, { hosted: true, seed: seedRadar([syntheticRepository(101)]) });
  const hGet = await request(hosted.origin, `/api/learning/${randomUUID()}/content`);
  assert.equal(hGet.response.status, 404);
  assert.equal(hGet.body.error.code, "LEARNING_UNAVAILABLE");
  const hPatch = await request(hosted.origin, `/api/learning/${randomUUID()}/plan`, {
    method: "PATCH",
    body: { expectedRevision: null, plan: plan() },
  });
  assert.equal(hPatch.response.status, 404);
  assert.equal(hPatch.body.error.code, "LEARNING_UNAVAILABLE");

  const readOnly = await startFixture(t, { projectReadOnly: true, seed: seedRadar([syntheticRepository(101)]) });
  const roRead = await request(readOnly.origin, `/api/learning/${randomUUID()}/content`);
  assert.equal(roRead.response.status, 404);
  assert.equal(roRead.body.error.code, "WORKSPACE_NOT_FOUND"); // reads work, workspace just missing
  const roPatch = await request(readOnly.origin, `/api/learning/${randomUUID()}/plan`, {
    method: "PATCH",
    body: { expectedRevision: null, plan: plan() },
  });
  assert.equal(roPatch.response.status, 403);
  assert.equal(roPatch.body.error.code, "LEARNING_READ_ONLY");
});

test("cross-site content writes are rejected before reaching the routes", async (t) => {
  const { origin } = await startFixture(t, { seed: seedRadar([syntheticRepository(101)]) });
  const workspace = await createWorkspace(origin);
  const response = await fetch(`${origin}/api/learning/${workspace.workspaceId}/plan`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
    body: JSON.stringify({ expectedRevision: null, plan: plan() }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "LOCAL_API_ORIGIN_DENIED");
});

test("invalid content input returns a safe 400 and unknown workspaces a 404", async (t) => {
  const { origin } = await startFixture(t, { seed: seedRadar([syntheticRepository(101)]) });
  const workspace = await createWorkspace(origin);

  const invalid = await request(origin, `/api/learning/${workspace.workspaceId}/plan`, {
    method: "PATCH",
    body: { expectedRevision: null, plan: plan({ learningGoal: "C:\\Users\\someone\\secret" }) },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, "LEARNING_CONTENT_INVALID_INPUT");
  assert.ok(!JSON.stringify(invalid.body).includes("C:\\Users"));

  const badNotes = await request(origin, `/api/learning/${workspace.workspaceId}/notes`, {
    method: "PATCH",
    body: { expectedRevision: null, notes: notes("token=ghp_abcdefghijklmnopqrstuvwxyz012345") },
  });
  assert.equal(badNotes.response.status, 400);
  assert.equal(badNotes.body.error.code, "LEARNING_CONTENT_INVALID_INPUT");

  const unknown = await request(origin, `/api/learning/${randomUUID()}/content`);
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error.code, "WORKSPACE_NOT_FOUND");

  const artifacts = await request(origin, `/api/learning/${randomUUID()}/artifacts`);
  assert.equal(artifacts.response.status, 404);
  assert.equal(artifacts.body.error.code, "WORKSPACE_NOT_FOUND");
});

test("the summaries API returns the summary pinned to the workspace commit for plan drafting", async (t) => {
  const { origin } = await startFixture(t, {
    seed: async (options) => {
      await seedRadar([syntheticRepository(101)])(options);
      await seedSummaryAt(options.stateRoot)(options);
    },
  });
  const workspace = await createWorkspace(origin, 101);

  const pinned = await request(origin, `/api/summaries/repository/101?sourceCommitSha=${workspace.sourceCommitSha}`);
  assert.equal(pinned.response.status, 200);
  assert.equal(pinned.body.summary.sourceCommitSha, workspace.sourceCommitSha);
  assert.equal(pinned.body.summary.sections.learningGoalCandidates, "理解雷达的确定性排名设计");

  const drifted = await request(origin, `/api/summaries/repository/101?sourceCommitSha=${commitSha("f")}`);
  assert.equal(drifted.response.status, 200);
  assert.equal(drifted.body.summary, null);
});

test("a request captured against the old binding is rejected and never writes new workspace content", async (t) => {
  // The registry deliberately forbids rebinding AWAY from a stateful workspace,
  // so the cross-workspace overwrite scenario can only be demonstrated at the
  // service seam where the binding guard composes the write: the injected
  // guard behaves like the real rebind window (withBoundWorkspace re-verifies
  // and then reports WORKSPACE_BINDING_CHANGED), and the service must refuse
  // the write so neither store's content is touched.
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-learning-content-rebind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldStore = createLearningRepository({ directory: path.join(root, "old") });
  const newStore = createLearningRepository({ directory: path.join(root, "new") });
  const { workspace } = await oldStore.createDraft({
    repositoryId: 101,
    fullName: "synthetic/repository-101",
    sourceUrl: "https://github.com/synthetic/repository-101",
    sourceCommitSha: commitSha("a"),
    mission: { goal: "learn-usage", notes: "owned by the old workspace" },
  });
  const binding = { repositoryId: workspace.repositoryId, sourceCommitSha: workspace.sourceCommitSha, sourceUrl: workspace.sourceUrl };
  await oldStore.content.savePlan({ workspaceId: workspace.workspaceId, expectedRevision: null, plan: plan(), binding });

  let refused = false;
  const service = createLearningService({
    learning: oldStore,
    bound: async (_binding, operation) => {
      // First call composes normally; the retried stale save hits a rebind
      // window and the guard refuses it exactly like withBoundWorkspace does.
      if (refused) {
        throw new LearningWorkspaceError("WORKSPACE_BINDING_CHANGED", "工作区绑定已改变，请重新加载后重试。", 409);
      }
      return operation();
    },
    readable: true,
    mutatable: true,
    hosted: false,
  });
  await service.savePlan({ workspaceId: workspace.workspaceId, expectedRevision: 1, plan: plan({ learningGoal: "正常保存" }) });
  assert.equal((await oldStore.content.getContent({ workspaceId: workspace.workspaceId })).content.revision, 2);

  refused = true;
  await assert.rejects(
    service.savePlan({ workspaceId: workspace.workspaceId, expectedRevision: 2, plan: plan({ learningGoal: "旧请求不能覆盖新证据" }) }),
    isService("WORKSPACE_BINDING_CHANGED"),
  );
  // The rejected stale save left every store untouched: old content versioned,
  // new workspace never received a cross-workspace write.
  assert.equal((await oldStore.content.getContent({ workspaceId: workspace.workspaceId })).content.revision, 2);
  assert.equal((await oldStore.content.getContent({ workspaceId: workspace.workspaceId })).content.learningPlan.learningGoal, "正常保存");
  assert.deepEqual((await newStore.content.getContent({ workspaceId: workspace.workspaceId })).content, null);
});

test("an A-targeted request after the vault moved to B resolves against B and finds nothing", async (t) => {
  let boundStateRoot;
  let registryDirectory;
  let targetWorkspaceId;
  const { origin } = await startFixture(t, {
    radarDirectory: "shared-radar",
    seed: async ({ stateRoot, registryDirectory: rd, radarDirectory }) => {
      boundStateRoot = stateRoot;
      registryDirectory = rd;
      const radar = createRadarRepository({ directory: radarDirectory, timeZone: "UTC" });
      await radar.updateSchedule({ time: "11:30" });
      await radar.upsertRepositories([syntheticRepository(101)]);
      const registry = createWorkspaceRegistry({ directory: rd });
      const target = await registry.resolveVault({ fingerprint: "b".repeat(64), label: "Target Workspace B" });
      targetWorkspaceId = target.workspaceId;
    },
  });

  // The vault owns an empty workspace A; move it to B while A is stateless.
  const preview = await request(origin, "/api/workspace/rebind/preview", { method: "POST", body: { workspaceId: targetWorkspaceId } });
  assert.equal(preview.response.status, 200);
  const confirmed = await request(origin, "/api/workspace/rebind/confirm", { method: "POST", body: { token: preview.body.token } });
  assert.equal(confirmed.response.status, 200);

  // A-targeted stale requests now resolve against B and can never create
  // content there: no workspace owns the stale id, so every path 404s.
  for (const [method, action, body] of [
    ["PATCH", "plan", { expectedRevision: null, plan: plan() }],
    ["PATCH", "notes", { expectedRevision: null, notes: notes("旧笔记") }],
    ["POST", "artifacts", { expectedRevision: null, artifact: artifact() }],
  ]) {
    const stale = await request(origin, `/api/learning/${randomUUID()}/${action}`, { method, body });
    assert.equal(stale.response.status, 404, `${method} ${action}`);
    assert.equal(stale.body.error.code, "WORKSPACE_NOT_FOUND");
  }

  // B's learning store was never created to hold the stale payloads.
  await assert.rejects(
    lstat(path.join(boundStateRoot, "learning")),
    (error) => error.code === "ENOENT",
  );
});