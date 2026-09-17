import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer as createViteServer } from "vite";
import { createLearningRepository } from "../server/learning/learning-repository.mjs";
import { createLearningIngestionService } from "../server/learning/learning-ingestion-service.mjs";
import { createLearningVaultCatalog } from "../server/learning/learning-vault-catalog.mjs";
import { createWorkspaceRuntime } from "../server/workspace-state/workspace-runtime.mjs";
import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";
import { createWorkspaceRegistry } from "../server/workspace-state/workspace-registry.mjs";

const commitSha = (char) => char.repeat(40);
const fingerprintOf = (root) => createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex");
const uuid = (char) => char.repeat(8) + "-2222-4333-8444-555555555555";

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

async function request(origin, route, { method = "GET", body, headers, signal } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return { response, body: await response.json() };
}

async function requestWithin(origin, route, options, milliseconds = 5_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await request(origin, route, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

const defaultMission = { goal: "understand-architecture", notes: "Synthetic ingestion study task" };

async function seedLearningWorkspace({ stateRoot, content = true }) {
  const learning = createLearningRepository({ directory: path.join(stateRoot, "learning") });
  const created = await learning.createDraft({
    repositoryId: 101,
    fullName: "synthetic/repo-101",
    sourceUrl: "https://github.com/synthetic/repo-101",
    sourceCommitSha: commitSha("b"),
    mission: defaultMission,
  });
  const workspaceId = created.workspace.workspaceId;
  const binding = { repositoryId: 101, sourceCommitSha: commitSha("b"), sourceUrl: "https://github.com/synthetic/repo-101" };
  if (content) {
    const contentRepo = learning.content;
    const save = async (expected, operation) => {
      await operation(expected);
      const { content: current } = await contentRepo.getContent({ workspaceId });
      return current.revision;
    };
    let revision = await save(undefined, () => contentRepo.savePlan({
      workspaceId,
      plan: { learningGoal: "理解架构", expectedOutcome: "画出模块图", milestones: [], currentMilestone: null },
      binding,
    }));
    revision = await save(revision, (expected) => contentRepo.saveNotes({
      workspaceId,
      notes: { markdownText: "# 学习笔记\n\n关键取舍记录。\n" },
      expectedRevision: expected,
      binding,
    }));
    revision = await save(revision, (expected) => contentRepo.addArtifact({
      workspaceId,
      artifact: { type: "experiment", title: "对比实验", markdownText: "## 实验\n\n结果 A。\n" },
      expectedRevision: expected,
      binding,
    }));
    await save(revision, (expected) => contentRepo.addArtifact({
      workspaceId,
      artifact: { type: "decision", title: "采用判断", markdownText: "## 判断\n\n建议采用。\n" },
      expectedRevision: expected,
      binding,
    }));
  }
  return { workspaceId, learning };
}

async function startFixture(t, {
  configVaults = [],
  probeWritable,
  readOnly = false,
  hosted = false,
  prebind = true,
  seed = async () => {},
} = {}) {
  const stableTempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(stableTempRoot, "workbench-ingest-api-"));
  const vaultRoot = path.join(root, "vault");
  const appDataRoot = path.join(root, "app-data");
  const registryDirectory = path.join(appDataRoot, "PersonalAIWorkbench");
  await mkdir(path.join(vaultRoot, "wiki"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "plan.md"), "# Project plan\n", "utf8");
  const targetVaults = [];
  for (const entry of configVaults) {
    const targetRoot = path.join(root, entry.dir ?? "vault-target");
    await mkdir(targetRoot, { recursive: true });
    targetVaults.push({ name: entry.name, root: targetRoot, dir: entry.dir });
  }
  const configPath = path.join(root, "vaults.local.json");
  await writeFile(configPath, `${JSON.stringify({ version: 1, vaults: targetVaults.map(({ name, root }) => ({ name, root })) }, null, 2)}\n`, "utf8");

  const vite = await createViteServer({
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [workbenchApiPlugin({
      vaultRoot,
      appDataRoot,
      projectDirectory: null,
      readOnly,
      projectReadOnly: readOnly,
      hosted,
      radarOptions: { github: { discovery: true } },
      learningIngestOptions: { configPath, ...(probeWritable ? { probeWritable } : {}) },
    })],
  });
  let boundWorkspaceId = null;
  let boundStateRoot = null;
  let learningWorkspaceId = null;
  if (prebind) {
    const registry = createWorkspaceRegistry({ directory: registryDirectory });
    const workspace = await registry.resolveVault({ fingerprint: fingerprintOf(vaultRoot), label: "Synthetic Ingestion Vault" });
    boundWorkspaceId = workspace.workspaceId;
    boundStateRoot = workspace.storageLayout === "legacy"
      ? path.join(registryDirectory, workspace.workspaceId)
      : path.join(registryDirectory, "workspaces", workspace.workspaceId);
    const seedResult = await seed({ stateRoot: boundStateRoot, workspaceId: boundWorkspaceId, vaultRoot }, t);
    learningWorkspaceId = seedResult?.workspaceId ?? null;
  } else {
    await seed({ stateRoot: null, workspaceId: null, vaultRoot }, t);
  }
  const server = http.createServer(vite.middlewares);
  await listenOnFetchSafePort(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    // Fetch keep-alives would otherwise pin server.close() until every idle
    // socket times out; the repo-wide convention force-closes them instead.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await vite.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    origin, root, vaultRoot, appDataRoot, registryDirectory, stateRoot: boundStateRoot,
    workspaceId: learningWorkspaceId ?? boundWorkspaceId, targetVault: targetVaults[0] ?? null,
    configVaultId: targetVaults[0] ? fingerprintOf(targetVaults[0].root) : null,
    currentVaultId: fingerprintOf(vaultRoot),
    configPath,
  };
}

async function fileExists(root, relativePath) {
  try {
    await lstat(path.join(root, ...relativePath.split("/")));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("unbound ingestion targets and capabilities never create registry or workspace state", async (t) => {
  const { origin, registryDirectory } = await startFixture(t, { prebind: false });
  const capabilities = await request(origin, "/api/learning/capabilities");
  assert.equal(capabilities.response.status, 200);
  await assert.rejects(lstat(registryDirectory), { code: "ENOENT" });
  const targets = await request(origin, `/api/learning/${uuid("9")}/targets`);
  assert.equal(targets.response.status, 404);
  assert.equal(targets.body.error.code, "WORKSPACE_NOT_FOUND");
  await assert.rejects(lstat(registryDirectory), { code: "ENOENT" });
});

test("runtime rejects ingestion mutations rebound during slow Vault discovery without any writes", async (t) => {
  // Stateful workspaces cannot be rebound through the public API. Exercise the
  // service boundary with real stores/runtime and a registry that can change
  // bindings while the external catalog is paused.
  for (const action of ["setTarget", "preview", "confirm"]) {
    await t.test(action, async (t) => {
      const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "workbench-ingest-rebind-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const targetRoot = path.join(root, "vault");
      await mkdir(targetRoot);
      const { learning: oldLearning, workspaceId } = await seedLearningWorkspace({ stateRoot: path.join(root, "old") });
      const newLearning = createLearningRepository({ directory: path.join(root, "new", "learning") });
      const oldWorkspace = { workspaceId: uuid("1"), fingerprint: "a".repeat(64) };
      const newWorkspace = { workspaceId: uuid("2"), fingerprint: "a".repeat(64) };
      let current = oldWorkspace;
      let guarded = false;
      const runtime = createWorkspaceRuntime({
        registry: {
          async resolve() { return current; },
          async capture() { return { fingerprint: current.fingerprint, workspaceId: current.workspaceId }; },
          async runBound({ binding, operation }) {
            if (binding.workspaceId !== current.workspaceId) {
              const error = new Error("binding changed");
              error.code = "WORKSPACE_BINDING_CHANGED";
              throw error;
            }
            guarded = true;
            try { return await operation({ binding, workspace: current }); } finally { guarded = false; }
          },
        },
        repositories: {
          learning: ({ workspace }) => workspace.workspaceId === oldWorkspace.workspaceId ? oldLearning : newLearning,
          ingestion: ({ workspace }) => (workspace.workspaceId === oldWorkspace.workspaceId ? oldLearning : newLearning).ingestion,
          summary: () => null,
          radar: () => null,
        },
        backup: () => null,
      });
      let rebindDuringProbe = false;
      const service = createLearningIngestionService({
        runtime,
        catalog: createLearningVaultCatalog({
          vaultRoot: targetRoot,
          probeWritable: async () => {
            assert.equal(guarded, false, "Vault discovery must finish before the registry guard");
            if (rebindDuringProbe) current = newWorkspace;
            return true;
          },
        }),
        lookupBoundWorkspace: null,
      });
      await service.setTarget({ workspaceId, vaultId: fingerprintOf(targetRoot) });
      const preview = await service.preview({ workspaceId, selectedContentTypes: ["plan", "notes"] });
      const before = await oldLearning.ingestion.exportState();
      rebindDuringProbe = true;
      const operations = {
        setTarget: () => service.setTarget({ workspaceId, vaultId: fingerprintOf(targetRoot) }),
        preview: () => service.preview({ workspaceId, selectedContentTypes: ["notes"] }),
        confirm: () => service.confirm({ token: preview.previewToken }),
      };
      await assert.rejects(operations[action], (error) => error.code === "WORKSPACE_BINDING_CHANGED" && error.status === 409);
      assert.deepEqual(await oldLearning.ingestion.exportState(), before, "the old store must remain unchanged");
      await assert.rejects(lstat(path.join(root, "new")), { code: "ENOENT" });
      await assert.rejects(lstat(path.join(targetRoot, "Wiki")), { code: "ENOENT" });
    });
  }
});

test("lists vault candidates safely: fingerprints, masked names, no absolute roots or user segments", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库", dir: "vault-target" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId, currentVaultId } = fixture;

  const got = await request(origin, `/api/learning/${workspaceId}/targets`);
  assert.equal(got.response.status, 200);
  assert.ok(got.body.targets.length >= 2);
  const serialized = JSON.stringify(got.body);
  assert.ok(!serialized.includes("kevin") && !serialized.includes("C:\\") && !serialized.includes("/Users/"), "no absolute roots or user segments");
  const current = got.body.targets.find((candidate) => candidate.vaultId === currentVaultId);
  const second = got.body.targets.find((candidate) => candidate.vaultId === configVaultId);
  assert.ok(current.isCurrent === true);
  assert.ok(second && second.displayName === "第二知识库" && second.isCurrent === false);
  for (const candidate of got.body.targets) {
    assert.ok(!Object.hasOwn(candidate, "root"));
    assert.match(candidate.maskedPath, /^…\/[^/\\]+$/);
    assert.equal(typeof candidate.writable, "boolean");
    assert.equal(typeof candidate.boundToWorkspace, "boolean");
  }
  // The current vault is bound to the workspace; the config vault is not.
  assert.equal(current.boundToWorkspace, true);
  assert.equal(second.boundToWorkspace, false);
  assert.equal(got.body.current, null, "no selection has been made yet");
});

test("browser-supplied absolute vault paths are rejected and never resolve", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId } = fixture;

  const absolute = await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: "C:\\Users\\someone\\Documents\\Vault" } });
  assert.ok([400, 404].includes(absolute.response.status));

  const posix = await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: "/home/someone/Vault" } });
  assert.ok([400, 404].includes(posix.response.status));

  const unknown = await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: "a".repeat(64) } });
  assert.equal(unknown.response.status, 404);

  // No selection side effects were created.
  const targets = await request(origin, `/api/learning/${workspaceId}/targets`);
  assert.equal(targets.body.current, null);
});

test("target selection binds a stable fingerprint and preview uses the server-resolved vault", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId } = fixture;

  const selected = await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });
  assert.equal(selected.response.status, 200);
  assert.equal(selected.body.target.vaultId, configVaultId);
  assert.equal(selected.body.target.displayName, "第二知识库");

  const preview = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: ["plan", "notes"] },
  });
  assert.equal(preview.body.target.vaultId, configVaultId);

  const targets = await request(origin, `/api/learning/${workspaceId}/targets`);
  assert.equal(targets.body.current.vaultId, configVaultId);
});

test("preview computes correct target relative paths and flags existing files as conflicts", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId, targetVault } = fixture;
  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });

  // Pre-create the plan file so it becomes a conflict.
  const planPath = "Wiki/学习/synthetic-repo-101/学习计划.md";
  await mkdir(path.join(targetVault.root, "Wiki", "学习", "synthetic-repo-101"), { recursive: true });
  await writeFile(path.join(targetVault.root, ...planPath.split("/")), "# 已有计划\n", "utf8");

  const preview = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: ["plan", "notes"] },
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.confirmAvailable, true);
  assert.ok(typeof preview.body.previewToken === "string" && preview.body.previewToken.length >= 32);
  assert.equal(preview.body.sourceCommitSha, commitSha("b"));
  assert.equal(typeof preview.body.contentRevision, "number");
  const planFile = preview.body.files.find((file) => file.kind === "plan");
  const notesFile = preview.body.files.find((file) => file.kind === "notes");
  assert.equal(planFile.relativePath, planPath);
  assert.equal(planFile.conflict, true);
  assert.equal(notesFile.conflict, false);
  assert.equal(notesFile.relativePath, "Wiki/学习/synthetic-repo-101/学习笔记.md");
  assert.match(notesFile.preview, /# 学习笔记/);
});

test("a full multi-file confirm writes plan, notes and each artifact into the target vault", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId, targetVault } = fixture;
  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });

  const list = await request(origin, `/api/learning/${workspaceId}/content`);
  const artifactIds = (list.body.content?.artifacts ?? []).map((artifact) => artifact.artifactId);
  const allTypes = ["plan", "notes", ...artifactIds.map((artifactId) => `artifact:${artifactId}`)];
  const chosen = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: allTypes },
  });
  assert.equal(chosen.body.files.length, 4);

  const confirmed = await request(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST",
    body: { token: chosen.body.previewToken },
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.ingestion.status, "written");
  assert.equal(confirmed.body.ingestion.targetVaultDisplayName, "第二知识库");
  assert.equal(confirmed.body.ingestion.writtenFiles.length, 4);

  const base = path.join(targetVault.root, "Wiki", "学习", "synthetic-repo-101");
  assert.match(await readFile(path.join(base, "学习笔记.md"), "utf8"), /# 学习笔记/);
  assert.match(await readFile(path.join(base, "学习计划.md"), "utf8"), /# 学习计划/);
  const artifactFiles = (await (await import("node:fs/promises")).readdir(base)).filter((name) => name.startsWith("学习产出-"));
  assert.equal(artifactFiles.length, 2);
});

test("real registry ingestion writes complete without re-entering its binding guard", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId } = fixture;

  const selected = await requestWithin(origin, `/api/learning/${workspaceId}/target`, {
    method: "POST",
    body: { vaultId: configVaultId },
  });
  assert.equal(selected.response.status, 200);

  const preview = await requestWithin(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: ["plan", "notes"] },
  });
  assert.equal(preview.response.status, 200);

  const confirmed = await requestWithin(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST",
    body: { token: preview.body.previewToken },
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.ingestion.status, "written");
});

test("the same preview token confirms idempotently without re-writing files", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId, targetVault } = fixture;
  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });
  const preview = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: ["plan", "notes"] },
  });

  const first = await request(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST",
    body: { token: preview.body.previewToken },
  });
  const second = await request(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST",
    body: { token: preview.body.previewToken },
  });
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.ingestion.status, "written");
  assert.equal(second.body.replayed, true);
  assert.deepEqual(second.body.ingestion.writtenFiles, first.body.ingestion.writtenFiles);

  const notesPath = path.join(targetVault.root, "Wiki", "学习", "synthetic-repo-101", "学习笔记.md");
  const once = await readFile(notesPath, "utf8");
  const twice = await readFile(notesPath, "utf8");
  assert.equal(once, twice);

  const list = await request(origin, `/api/learning/${workspaceId}/ingestions`);
  assert.equal(list.body.ingestions.filter((record) => record.status === "written").length, 1);
});

test("content changes after the preview reject the confirm with a stale-preview error", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId, stateRoot } = fixture;
  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });
  const preview = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: ["plan", "notes"] },
  });

  // Bump the content revision through the real content endpoint.
  const current = await request(origin, `/api/learning/${workspaceId}/content`);
  const revision = current.body.content.revision;
  await request(origin, `/api/learning/${workspaceId}/notes`, {
    method: "PATCH",
    body: { expectedRevision: revision, notes: { markdownText: "# 学习笔记\n\n更新后的内容。\n" } },
  });

  const stale = await request(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST",
    body: { token: preview.body.previewToken },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "INGESTION_CONTENT_CHANGED");
  assert.ok(!JSON.stringify(stale.body).includes(stateRoot), "no local paths leak");
});

test("changing the target vault invalidates the old preview token", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId, currentVaultId } = fixture;
  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });
  const preview = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: ["plan", "notes"] },
  });

  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: currentVaultId } });
  const stale = await request(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST",
    body: { token: preview.body.previewToken },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "INGESTION_TARGET_CHANGED");
});

test("conflicts require an explicit resolution and skipping never overwrites existing files", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId, targetVault } = fixture;
  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });

  const planPath = "Wiki/学习/synthetic-repo-101/学习计划.md";
  await mkdir(path.join(targetVault.root, "Wiki", "学习", "synthetic-repo-101"), { recursive: true });
  await writeFile(path.join(targetVault.root, ...planPath.split("/")), "USER KEEPS THIS\n", "utf8");

  const preview = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: ["plan", "notes"] },
  });

  const unresolved = await request(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST",
    body: { token: preview.body.previewToken },
  });
  assert.equal(unresolved.response.status, 409);
  assert.equal(unresolved.body.error.code, "INGESTION_CONFLICT_UNRESOLVED");

  const skipped = await request(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST",
    body: { token: preview.body.previewToken, conflictResolution: "skip" },
  });
  assert.equal(skipped.response.status, 200);
  const file = await readFile(path.join(targetVault.root, ...planPath.split("/")), "utf8");
  assert.equal(file, "USER KEEPS THIS\n");
  const notesPath = path.join(targetVault.root, "Wiki", "学习", "synthetic-repo-101", "学习笔记.md");
  assert.match(await readFile(notesPath, "utf8"), /# 学习笔记/);
  // The written record reflects what was actually written.
  assert.ok(!skipped.body.ingestion.writtenFiles.includes(planPath));
});

test("read-only mode can list targets and preview without a token but never confirms", async (t) => {
  const fixture = await startFixture(t, { readOnly: true, configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId } = fixture;

  const targets = await request(origin, `/api/learning/${workspaceId}/targets`);
  assert.equal(targets.response.status, 200);

  const target = await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });
  assert.equal(target.response.status, 403);

  const preview = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { targetVaultId: configVaultId, selectedContentTypes: ["plan", "notes"] },
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.confirmAvailable, false);
  assert.ok(!Object.hasOwn(preview.body, "previewToken"), "read-only preview must not mint a token");
  assert.ok(preview.body.files.length >= 2);

  const illegal = await request(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST",
    body: { token: "synthetic.invalid" },
  });
  assert.equal(illegal.response.status, 403);
});

test("hosted mode exposes no ingestion surface at all", async (t) => {
  const fixture = await startFixture(t, { hosted: true, seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId } = fixture;
  for (const [route, options] of [
    [`/api/learning/${workspaceId}/targets`, { method: "GET" }],
    [`/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } }],
    [`/api/learning/${workspaceId}/ingestions/preview`, { method: "POST", body: { selectedContentTypes: ["plan"] } }],
    [`/api/learning/${workspaceId}/ingestions/confirm`, { method: "POST", body: { token: "x".repeat(64) } }],
    [`/api/learning/${workspaceId}/ingestions`, { method: "GET" }],
  ]) {
    const got = await request(origin, route, options);
    assert.equal(got.response.status, 404);
  }
});

test("cross-site mutation requests are rejected before reaching any endpoint", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId } = fixture;
  const got = await request(origin, `/api/learning/${workspaceId}/target`, {
    method: "POST",
    body: { vaultId: configVaultId },
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(got.response.status, 403);
  assert.equal(got.body.error.code, "LOCAL_API_ORIGIN_DENIED");
});

test("an unwritable target vault blocks confirmation with a safe 403", async (t) => {
  let writable = true;
  const fixture = await startFixture(t, {
    configVaults: [{ name: "第二知识库" }],
    probeWritable: async () => writable,
    seed: seedLearningWorkspace,
  });
  const { origin, workspaceId, configVaultId } = fixture;
  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });
  const preview = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: ["plan", "notes"] },
  });
  assert.equal(preview.body.confirmAvailable, true);

  writable = false;
  const blocked = await request(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST",
    body: { token: preview.body.previewToken },
  });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.error.code, "VAULT_TARGET_UNWRITABLE");
  assert.ok(!JSON.stringify(blocked.body).includes("kevin"), "no user identity leaks");
});

test("preview without a selected target and ingestions for an unknown workspace are safe 4xx errors", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId } = fixture;

  const unselected = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: ["plan"] },
  });
  assert.equal(unselected.response.status, 409);
  assert.equal(unselected.body.error.code, "INGESTION_TARGET_UNSELECTED");

  const unknownWorkspace = await request(origin, `/api/learning/${uuid("9")}/targets`);
  assert.equal(unknownWorkspace.response.status, 404);

  const records = await request(origin, `/api/learning/${workspaceId}/ingestions`);
  assert.equal(records.response.status, 200);
  assert.deepEqual(records.body.ingestions, []);
});

test("plan, notes and each artifact are independently selectable at the API layer", async (t) => {
  const fixture = await startFixture(t, { configVaults: [{ name: "第二知识库" }], seed: seedLearningWorkspace });
  const { origin, workspaceId, configVaultId } = fixture;
  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });

  const notesOnly = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST",
    body: { selectedContentTypes: ["notes"] },
  });
  assert.deepEqual(notesOnly.body.files.map((file) => file.kind), ["notes"]);
});

test("a target restored during a slow confirm cannot authorize the previously selected Vault", async (t) => {
  let duringProbe = null;
  let learning;
  const fixture = await startFixture(t, {
    configVaults: [{ name: "第二知识库" }],
    probeWritable: async () => {
      const operation = duringProbe;
      duringProbe = null;
      if (operation) await operation();
      return true;
    },
    seed: async (input) => {
      const seeded = await seedLearningWorkspace(input);
      learning = seeded.learning;
      return seeded;
    },
  });
  const { origin, workspaceId, configVaultId, currentVaultId, targetVault, vaultRoot } = fixture;
  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: configVaultId } });
  const preview = await request(origin, `/api/learning/${workspaceId}/ingestions/preview`, {
    method: "POST", body: { selectedContentTypes: ["notes"] },
  });
  const originalSelection = (await learning.ingestion.getSelection(workspaceId)).selection;
  await request(origin, `/api/learning/${workspaceId}/target`, { method: "POST", body: { vaultId: currentVaultId } });
  duringProbe = () => learning.ingestion.setSelection(originalSelection);
  const confirmed = await request(origin, `/api/learning/${workspaceId}/ingestions/confirm`, {
    method: "POST", body: { token: preview.body.previewToken },
  });
  assert.equal(confirmed.response.status, 409);
  assert.equal(confirmed.body.error.code, "INGESTION_TARGET_CHANGED");
  // The fixture already contains a lowercase `wiki` directory. Windows treats
  // that as `Wiki`, so assert the ingestion-specific descendant instead of the
  // case-insensitive root name.
  await assert.rejects(lstat(path.join(targetVault.root, "Wiki", "学习")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(vaultRoot, "Wiki", "学习")), { code: "ENOENT" });
});
