import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer as createViteServer } from "vite";
import { createRadarRepository } from "../server/ai-radar/radar-repository.mjs";
import { createLearningRepository } from "../server/learning/learning-repository.mjs";
import { createLearningRoutes } from "../server/learning/learning-routes.mjs";
import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";
import { createWorkspaceRegistry } from "../server/workspace-state/workspace-registry.mjs";

const commitSha = (char) => char.repeat(40);

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
  const calls = [];
  let failNext = false;
  return {
    calls,
    failNextHead() { failNext = true; },
    async getHeadCommit({ fullName }) {
      calls.push({ fullName });
      if (failNext) {
        failNext = false;
        const error = new Error("synthetic GitHub network failure");
        error.code = "GITHUB_UNAVAILABLE";
        throw error;
      }
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

// Mirrors project-api.test.mjs startFixture but always uses the workspace
// registry (projectDirectory = null) and injects a synthetic GitHub client at
// the external adapter seam. A caller-supplied seed hook runs inside
// beforeStart after the workspace binding is created, so it can write real
// radar/learning stores into the deterministic bound-workspace stateRoot.
async function startFixture(t, { readOnly = false, profile = "default", projectReadOnly, hosted = false, github = syntheticGitHub, seed = async () => {} } = {}) {
  const stableTempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(stableTempRoot, "workbench-learning-api-"));
  assert.equal(root, await realpath(root));
  const vaultRoot = path.join(root, "vault");
  const appDataRoot = path.join(root, "app-data");
  const registryDirectory = path.join(appDataRoot, "PersonalAIWorkbench");
  await mkdir(path.join(vaultRoot, "wiki"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "plan.md"), "# Project plan\n", "utf8");
  let boundStateRoot = null;
  let boundWorkspaceId = null;
  const client = github();
  const vite = await createViteServer({
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [workbenchApiPlugin({
      vaultRoot,
      profile,
      appDataRoot,
      projectDirectory: null,
      readOnly,
      projectReadOnly,
      hosted,
      radarOptions: { github: client },
    })],
  });
  // Pre-bind the workspace deterministically, exactly as the plugin's
  // currentWorkspace({ create: true }) dedupes by fingerprint.
  {
    const registry = createWorkspaceRegistry({ directory: registryDirectory });
    const fingerprint = createHash("sha256").update(path.resolve(vaultRoot).toLowerCase()).digest("hex");
    const workspace = await registry.resolveVault({ fingerprint, label: "Synthetic Learning Vault" });
    boundWorkspaceId = workspace.workspaceId;
    boundStateRoot = workspace.storageLayout === "legacy"
      ? path.join(registryDirectory, workspace.workspaceId)
      : path.join(registryDirectory, "workspaces", workspace.workspaceId);
  }
  await seed({ vaultRoot, appDataRoot, registryDirectory, stateRoot: boundStateRoot, workspaceId: boundWorkspaceId, createRadarRepository });
  const server = http.createServer(vite.middlewares);
  await listenOnFetchSafePort(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await vite.close();
    await rm(root, { recursive: true, force: true });
  });
  return { origin, root, vaultRoot, appDataRoot, stateRoot: boundStateRoot, workspaceId: boundWorkspaceId, github: client };
}

function seedRadar(repos) {
  return async ({ stateRoot }) => {
    const radar = createRadarRepository({ directory: path.join(stateRoot, "ai-radar"), timeZone: "UTC" });
    await radar.updateSchedule({ time: "11:30" });
    if (repos?.length) await radar.upsertRepositories(repos);
  };
}

const seedRepos = [syntheticRepository(101, { stars: 700 }), syntheticRepository(102), syntheticRepository(103), syntheticRepository(104), syntheticRepository(105)];

test("capabilities reflect runtime gates and never touch GitHub or a store", async (t) => {
  const writable = await startFixture(t);
  const caps = await request(writable.origin, "/api/learning/capabilities");
  assert.equal(caps.response.status, 200);
  assert.deepEqual(caps.body.capabilities, {
    read: true, create: true, edit: true, preview: true, confirm: true, activate: true, archive: true,
  });
  assert.equal(writable.github.calls.length, 0);

  const readOnly = await startFixture(t, { projectReadOnly: true });
  const roCaps = await request(readOnly.origin, "/api/learning/capabilities");
  assert.deepEqual(roCaps.body.capabilities, {
    read: true, create: false, edit: false, preview: false, confirm: false, activate: false, archive: false,
  });

  const hosted = await startFixture(t, { hosted: true });
  const hCaps = await request(hosted.origin, "/api/learning/capabilities");
  assert.deepEqual(hCaps.body.capabilities, {
    read: false, create: false, edit: false, preview: false, confirm: false, activate: false, archive: false,
  });
});

test("runs the full no-model flow through the real plugin HTTP service", async (t) => {
  const { origin } = await startFixture(t, { seed: seedRadar([syntheticRepository(102)]) });

  const created = await request(origin, "/api/learning/drafts", {
    method: "POST",
    body: { repositoryId: 102, mission: { goal: "understand-architecture", notes: "Synthetic study task" } },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.workspace.repositoryId, 102);
  assert.equal(created.body.workspace.state, "draft");
  assert.equal(created.body.workspace.sourceCommitSha, commitSha("b")); // pinned from synthetic GitHub HEAD
  assert.equal(created.body.workspace.sourceUrl, "https://github.com/synthetic/repository-102");
  assert.equal(created.body.workspace.fullName, "synthetic/repository-102");
  const workspaceId = created.body.workspace.workspaceId;

  const got = await request(origin, `/api/learning/${workspaceId}`);
  assert.equal(got.response.status, 200);
  assert.equal(got.body.workspace.workspaceId, workspaceId);

  const preview = await request(origin, `/api/learning/${workspaceId}/preview`, { method: "POST", body: {} });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.draftRevision, 1);
  assert.equal(preview.body.sourceCommitSha, commitSha("b"));
  assert.equal(preview.body.repositoryId, 102);
  assert.equal(preview.body.fullName, "synthetic/repository-102");
  assert.equal(preview.body.sourceUrl, "https://github.com/synthetic/repository-102");
  assert.equal(preview.body.mission.goal, "understand-architecture");
  assert.ok(typeof preview.body.token === "string" && preview.body.token.length >= 32);
  assert.ok(Date.parse(preview.body.expiresAt) > Date.now());

  const confirmed = await request(origin, "/api/learning/confirm", { method: "POST", body: { token: preview.body.token } });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.confirmed, "active");
  assert.equal(confirmed.body.workspace.state, "active");

  const listed = await request(origin, "/api/learning?includeArchived=1");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.workspaces.length, 1);
  assert.equal(listed.body.workspaces[0].state, "active");
});

test("creating a draft is idempotent and never re-reads GitHub even when GitHub fails", async (t) => {
  const { origin, github } = await startFixture(t, { seed: seedRadar([syntheticRepository(101)]) });
  const mission = { goal: "learn-usage", notes: "Synthetic idempotent task" };
  const first = await request(origin, "/api/learning/drafts", { method: "POST", body: { repositoryId: 101, mission } });
  assert.equal(first.response.status, 201);

  const headCallsBefore = github.calls.length;
  github.failNextHead();

  const second = await request(origin, "/api/learning/drafts", { method: "POST", body: { repositoryId: 101, mission } });
  assert.equal(second.response.status, 201);
  assert.equal(second.body.workspace.workspaceId, first.body.workspace.workspaceId);
  assert.equal(second.body.workspace.mission.goal, mission.goal);
  // The idempotent path returned the existing workspace without a GitHub call.
  assert.equal(github.calls.length, headCallsBefore);
  assert.equal((await request(origin, "/api/learning")).body.workspaces.length, 1);
});

test("draft creation surfaces safe errors for unknown repos and GitHub failures", async (t) => {
  const { origin, github } = await startFixture(t, { seed: seedRadar([syntheticRepository(101)]) });

  const missing = await request(origin, "/api/learning/drafts", {
    method: "POST",
    body: { repositoryId: 9999, mission: { goal: "adoption-decision", notes: "synthetic" } },
  });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, "LEARNING_REPOSITORY_NOT_FOUND");

  github.failNextHead();
  const ghFailure = await request(origin, "/api/learning/drafts", {
    method: "POST",
    body: { repositoryId: 101, mission: { goal: "reproduce-capability", notes: "synthetic" } },
  });
  assert.equal(ghFailure.response.status, 503);
  assert.equal(ghFailure.body.error.code, "LEARNING_GITHUB_UNAVAILABLE");
});

test("editing a draft bumps the revision and invalidates the old preview token", async (t) => {
  const { origin } = await startFixture(t, { seed: seedRadar([syntheticRepository(101)]) });
  const created = await request(origin, "/api/learning/drafts", {
    method: "POST",
    body: { repositoryId: 101, mission: { goal: "understand-architecture", notes: "v1" } },
  });
  const workspaceId = created.body.workspace.workspaceId;
  const preview = await request(origin, `/api/learning/${workspaceId}/preview`, { method: "POST", body: {} });

  // Editing at the current revision succeeds and bumps the revision.
  const edited = await request(origin, `/api/learning/${workspaceId}/draft`, {
    method: "PATCH",
    body: { expectedRevision: 1, mission: { goal: "analyze-design", notes: "v2" } },
  });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.workspace.draftRevision, 2);
  assert.equal(edited.body.workspace.mission.notes, "v2");

  // Editing with a stale revision conflicts.
  const conflict = await request(origin, `/api/learning/${workspaceId}/draft`, {
    method: "PATCH",
    body: { expectedRevision: 1, mission: { goal: "learn-usage", notes: "stale" } },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "REVISION_CONFLICT");

  // The old preview token is invalid because the mission/revision drifted.
  const badConfirm = await request(origin, "/api/learning/confirm", { method: "POST", body: { token: preview.body.token } });
  assert.equal(badConfirm.response.status, 409);
  assert.equal(badConfirm.body.error.code, "CONFIRM_TOKEN_INVALID");

  // A fresh preview reflects the new revision and confirms cleanly.
  const fresh = await request(origin, `/api/learning/${workspaceId}/preview`, { method: "POST", body: {} });
  assert.equal(fresh.body.draftRevision, 2);
  const confirmed = await request(origin, "/api/learning/confirm", { method: "POST", body: { token: fresh.body.token } });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.confirmed, "active");
});

test("replaying a consumed token returns the same receipt without undoing a later archive", async (t) => {
  const { origin } = await startFixture(t, { seed: seedRadar([syntheticRepository(101)]) });
  const created = await request(origin, "/api/learning/drafts", {
    method: "POST",
    body: { repositoryId: 101, mission: { goal: "learn-usage", notes: "synthetic" } },
  });
  const workspaceId = created.body.workspace.workspaceId;
  const preview = await request(origin, `/api/learning/${workspaceId}/preview`, { method: "POST", body: {} });

  const first = await request(origin, "/api/learning/confirm", { method: "POST", body: { token: preview.body.token } });
  assert.equal(first.body.confirmed, "active");

  const replay = await request(origin, "/api/learning/confirm", { method: "POST", body: { token: preview.body.token } });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.confirmed, "active");
  assert.equal(replay.body.workspace.workspaceId, workspaceId);

  const archived = await request(origin, `/api/learning/${workspaceId}/archive`, { method: "POST", body: {} });
  assert.equal(archived.response.status, 200);
  assert.equal(archived.body.workspace.state, "archived");

  // Replaying after archive returns the original outcome and keeps the archive.
  const replayAfterArchive = await request(origin, "/api/learning/confirm", { method: "POST", body: { token: preview.body.token } });
  assert.equal(replayAfterArchive.response.status, 200);
  assert.equal(replayAfterArchive.body.confirmed, "active");
  assert.equal(replayAfterArchive.body.workspace.state, "archived");
});

test("the fourth confirm queues and activation frees the slot once an active is archived", async (t) => {
  const { origin } = await startFixture(t, { seed: seedRadar(seedRepos) });
  const states = [];
  for (const repositoryId of [101, 102, 103, 104]) {
    const created = await request(origin, "/api/learning/drafts", {
      method: "POST",
      body: { repositoryId, mission: { goal: "understand-architecture", notes: "capacity synthetic" } },
    });
    const preview = await request(origin, `/api/learning/${created.body.workspace.workspaceId}/preview`, { method: "POST", body: {} });
    const confirmed = await request(origin, "/api/learning/confirm", { method: "POST", body: { token: preview.body.token } });
    states.push({ workspace: created.body.workspace, confirmed: confirmed.body.confirmed });
  }
  assert.deepEqual(states.map((s) => s.confirmed), ["active", "active", "active", "queued"]);

  // Wrong revision on a queued workspace conflicts before any state change.
  const queued = states[3];
  const badActivate = await request(origin, `/api/learning/${queued.workspace.workspaceId}/activate`, {
    method: "POST",
    body: { expectedRevision: 2 },
  });
  assert.equal(badActivate.response.status, 409);
  assert.equal(badActivate.body.error.code, "REVISION_CONFLICT");

  // Activating while at the 3-active limit returns ACTIVE_LIMIT_REACHED (200).
  const limited = await request(origin, `/api/learning/${queued.workspace.workspaceId}/activate`, {
    method: "POST",
    body: { expectedRevision: 1 },
  });
  assert.equal(limited.response.status, 200);
  assert.equal(limited.body.outcome, "ACTIVE_LIMIT_REACHED");
  assert.equal(limited.body.workspace.state, "queued");

  // Archive one active repo, then the queued one promotes.
  const archived = await request(origin, `/api/learning/${states[0].workspace.workspaceId}/archive`, { method: "POST", body: {} });
  assert.equal(archived.body.workspace.state, "archived");
  const promoted = await request(origin, `/api/learning/${queued.workspace.workspaceId}/activate`, {
    method: "POST",
    body: { expectedRevision: 1 },
  });
  assert.equal(promoted.response.status, 200);
  assert.equal(promoted.body.outcome, "active");
  assert.equal(promoted.body.workspace.state, "active");
  const again = await request(origin, `/api/learning/${queued.workspace.workspaceId}/activate`, {
    method: "POST",
    body: { expectedRevision: 1 },
  });
  assert.equal(again.body.outcome, "already-active");
});

test("a corrupt learning store is surfaced as unavailable and never leaks raw errors", async (t) => {
  const { origin } = await startFixture(t, {
    seed: async ({ stateRoot }) => {
      const radar = createRadarRepository({ directory: path.join(stateRoot, "ai-radar"), timeZone: "UTC" });
      await radar.updateSchedule({ time: "11:30" });
      await radar.upsertRepositories([syntheticRepository(101, { stars: 700 })]);
      await mkdir(path.join(stateRoot, "learning"), { recursive: true });
      await writeFile(path.join(stateRoot, "learning", "learning.json"), "<not-json>%corrupt%", "utf8");
    },
  });

  const listed = await request(origin, "/api/learning");
  assert.equal(listed.response.status, 500);
  assert.equal(listed.body.error.code, "LEARNING_STORAGE_CORRUPT");

  // The radar dashboard base read still renders with learningStatus unavailable.
  const base = await request(origin, "/api/ai-radar");
  assert.equal(base.response.status, 200);
  assert.equal(base.body.learningStatus, "unavailable");
  assert.equal(base.body.lists.established.length, 1);
  assert.equal(base.body.lists.established[0].learning, null);

  // A learning-filtered radar read refuses to pretend there are no learning projects.
  const filtered = await request(origin, "/api/ai-radar?learning=active");
  assert.equal(filtered.response.status, 503);
  assert.equal(filtered.body.error.code, "RADAR_LEARNING_UNAVAILABLE");
});

test("cross-site mutations are rejected before reaching the learning routes", async (t) => {
  const { origin } = await startFixture(t, { seed: seedRadar([syntheticRepository(101)]) });
  const response = await fetch(`${origin}/api/learning/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
    body: JSON.stringify({ repositoryId: 101, mission: { goal: "learn-usage", notes: "synthetic" } }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "LOCAL_API_ORIGIN_DENIED");
});

test("read-only vaults allow reads and reject every mutation before touching the store", async (t) => {
  const { origin } = await startFixture(t, { projectReadOnly: true, seed: seedRadar([syntheticRepository(101)]) });

  assert.equal((await request(origin, "/api/learning")).response.status, 200);
  assert.equal((await request(origin, `/api/learning/${randomUUID()}`)).body.error.code, "WORKSPACE_NOT_FOUND");

  for (const [method, route, body] of [
    ["POST", "/api/learning/drafts", { repositoryId: 101, mission: { goal: "learn-usage", notes: "x" } }],
    ["POST", "/api/learning/confirm", { token: "synthetic" }],
  ]) {
    const result = await request(origin, route, { method, body });
    assert.equal(result.response.status, 403, `${method} ${route}`);
    assert.equal(result.body.error.code, "LEARNING_READ_ONLY");
  }
});

test("hosted mode hides all learning data and mutations", async (t) => {
  const { origin } = await startFixture(t, { hosted: true, seed: seedRadar([syntheticRepository(101)]) });
  const listed = await request(origin, "/api/learning");
  assert.equal(listed.response.status, 404);
  assert.equal(listed.body.error.code, "LEARNING_UNAVAILABLE");
  const drafted = await request(origin, "/api/learning/drafts", {
    method: "POST",
    body: { repositoryId: 101, mission: { goal: "learn-usage", notes: "x" } },
  });
  assert.equal(drafted.response.status, 404);
  assert.equal(drafted.body.error.code, "LEARNING_UNAVAILABLE");
});

test("unknown exceptions map to a generic internal error without leaking raw details", async () => {
  const hostileService = {
    capabilities() { return {}; },
    async list() {
      const hostile = new Error("raw ghp_abcdefghijklmnopqrstuvwxyz at C:\\Users\\owner\\AppData leaked");
      hostile.code = "LEARNING_STORAGE_CORRUPT";
      hostile.status = 400;
      hostile.headers = { authorization: "Bearer ghp_secret", "x-ratelimit-reset": "1700000000" };
      throw hostile;
    },
  };
  const routes = createLearningRoutes({ service: hostileService });
  const req = { method: "GET", url: "/api/learning", headers: {}, async *[Symbol.asyncIterator]() {} };
  let status = 0;
  let payload = null;
  const res = {
    writeHead(value) { status = value; },
    end(value) { payload = value; },
  };
  await routes.handle(req, res, new URL(`/api/learning`, "http://127.0.0.1"));
  const body = JSON.parse(payload);
  assert.equal(status, 500);
  assert.deepEqual(body.error, { code: "LEARNING_INTERNAL_ERROR", message: "学习服务暂时不可用。" });
  assert.equal(JSON.stringify(body).includes("ghp_"), false);
  assert.equal(JSON.stringify(body).includes("authorization"), false);
  assert.equal(JSON.stringify(body).includes("x-ratelimit"), false);
  assert.equal(JSON.stringify(body).includes("AppData"), false);
  assert.equal(JSON.stringify(body).includes("C:\\"), false);
});

test("formal backup restore round-trips learning and invalidates old confirm tokens", async (t) => {
  let preRestoreToken;
  const { origin } = await startFixture(t, {
    seed: async ({ stateRoot }) => {
      const radar = createRadarRepository({ directory: path.join(stateRoot, "ai-radar"), timeZone: "UTC" });
      await radar.updateSchedule({ time: "11:30" });
      await radar.upsertRepositories([syntheticRepository(101, { stars: 700 }), syntheticRepository(102)]);
      const learning = createLearningRepository({ directory: path.join(stateRoot, "learning") });
      const created = await learning.createDraft({
        repositoryId: 101,
        fullName: "synthetic/repository-101",
        sourceUrl: "https://github.com/synthetic/repository-101",
        sourceCommitSha: commitSha("a"),
        mission: { goal: "understand-architecture", notes: "pre-backup synthetic" },
      });
      const page = await learning.preview({ workspaceId: created.workspace.workspaceId });
      const confirmed = await learning.confirm({ token: page.token }); // active + receipt
      assert.equal(confirmed.confirmed, "active");
      preRestoreToken = page.token;
    },
  });

  const backupResponse = await request(origin, "/api/workspace/backup");
  assert.equal(backupResponse.response.status, 200);
  const bundle = backupResponse.body;
  assert.ok(Object.keys(bundle.providers).includes("learning"), "learning must be a first-class backup provider");
  // The exported learning provider never leaks raw confirm tokens or digests.
  assert.equal(JSON.stringify(bundle).includes(preRestoreToken), false);
  assert.equal(JSON.stringify(bundle).includes("tokenDigest"), false);

  // A later workspace appears after the snapshot so the restore changes state.
  await request(origin, "/api/learning/drafts", {
    method: "POST",
    body: { repositoryId: 102, mission: { goal: "learn-usage", notes: "later now-dropped" } },
  });
  assert.equal((await request(origin, "/api/learning")).body.workspaces.length, 2);

  const previewRestore = await request(origin, "/api/workspace/restore/preview", { method: "POST", body: bundle });
  assert.equal(previewRestore.response.status, 200);
  assert.deepEqual(previewRestore.body.providers.map(({ id }) => id).sort(), ["ai-radar", "learning", "projects"]);
  const restored = await request(origin, "/api/workspace/restore/confirm", {
    method: "POST",
    body: { token: previewRestore.body.token },
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.restored, true);

  const after = (await request(origin, "/api/learning")).body.workspaces;
  assert.equal(after.length, 1);
  assert.equal(after[0].mission.notes, "pre-backup synthetic");

  // After the token-free restore the old confirm token is invalid (fresh preview required).
  const oldToken = await request(origin, "/api/learning/confirm", { method: "POST", body: { token: preRestoreToken } });
  assert.equal(oldToken.response.status, 409);
  assert.equal(oldToken.body.error.code, "CONFIRM_TOKEN_INVALID");
});

test("read-only export of an absent learning store never creates its directory", async (t) => {
  let stateRoot;
  const { origin } = await startFixture(t, {
    projectReadOnly: true,
    seed: async ({ stateRoot: sr }) => {
      stateRoot = sr;
      const radar = createRadarRepository({ directory: path.join(sr, "ai-radar"), timeZone: "UTC" });
      await radar.updateSchedule({ time: "11:30" });
    },
  });
  const backup = await request(origin, "/api/workspace/backup");
  assert.equal(backup.response.status, 200);
  assert.equal(backup.body.providers.learning.data.workspaces.length, 0);
  // Reading/exporting an absent learning store must not create the directory.
  await assert.rejects(access(path.join(stateRoot, "learning")), { code: "ENOENT" });
});
