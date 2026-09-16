import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceRegistry } from "../server/workspace-state/workspace-registry.mjs";
import { createWorkspaceRegistryAdapter, createWorkspaceRuntime } from "../server/workspace-state/workspace-runtime.mjs";

function binding(workspaceId = "workspace-a", fingerprint = "a".repeat(64)) {
  return { fingerprint, workspaceId };
}

function fixture({ readWorkspace = null, repositoryFactories = {}, events = null } = {}) {
  const calls = {
    read: 0,
    write: 0,
    capture: 0,
    runBound: 0,
    learning: 0,
    summary: 0,
    ingestion: 0,
    radar: 0,
    backup: 0,
  };
  let current = binding();
  const registry = {
    async resolve({ mode }) {
      calls[mode] += 1;
      events?.push(`resolve:${mode}`);
      return mode === "read" ? readWorkspace : current;
    },
    async capture() {
      calls.capture += 1;
      events?.push("capture");
      return current;
    },
    async runBound({ binding: expected, operation }) {
      calls.runBound += 1;
      events?.push("runBound");
      if (expected.workspaceId !== current.workspaceId || expected.fingerprint !== current.fingerprint) {
        const error = new Error("工作区绑定已改变，请重新加载后重试。");
        error.code = "WORKSPACE_BINDING_CHANGED";
        throw error;
      }
      return operation();
    },
    rebind() {
      current = binding("workspace-b", "b".repeat(64));
    },
  };
  const repositories = Object.fromEntries(
    ["learning", "summary", "ingestion", "radar"].map((name) => [name, repositoryFactories[name] ?? (async ({ workspace, mode }) => {
      calls[name] += 1;
      events?.push(name);
      return { name, workspace, mode };
    })]),
  );
  const backup = async ({ workspace, mode }) => {
    calls.backup += 1;
    events?.push("backup");
    return { name: "backup", workspace, mode };
  };

  return { registry, repositories, backup, calls };
}

function hasCode(code) {
  return (error) => error?.code === code;
}

function repositoryFactories() {
  return Object.fromEntries(
    ["learning", "summary", "ingestion", "radar"].map((name) => [name, async () => ({ name })]),
  );
}

test("registry adapter maps the concrete registry read, write, capture, and guard operations", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-runtime-"));
  const directory = path.join(root, "registry");
  t.after(() => rm(root, { recursive: true, force: true }));
  const rawRegistry = createWorkspaceRegistry({ directory, makeId: () => "workspace-a" });
  const registry = createWorkspaceRegistryAdapter({
    registry: rawRegistry,
    fingerprint: "a".repeat(64),
    label: "Synthetic Vault",
  });
  const runtime = createWorkspaceRuntime({
    registry,
    repositories: repositoryFactories(),
    backup: async () => ({ name: "backup" }),
  });

  assert.equal(await runtime.resolve({ mode: "read" }), null);
  await assert.rejects(access(directory), { code: "ENOENT" });
  const workspace = await runtime.resolve({ mode: "write" });
  const expected = await runtime.capture();
  const result = await runtime.runBound({ binding: expected, operation: async () => "guarded" });

  assert.equal(workspace.workspaceId, "workspace-a");
  assert.deepEqual(expected, binding());
  assert.equal(result, "guarded");
});

test("read resolution does not create a workspace", async () => {
  const fx = fixture();
  const runtime = createWorkspaceRuntime(fx);

  assert.equal(await runtime.resolve({ mode: "read" }), null);
  assert.equal(fx.calls.write, 0);
  assert.equal(fx.calls.read, 1);
});

test("runBound rejects when the captured binding changes", async () => {
  const fx = fixture();
  const runtime = createWorkspaceRuntime(fx);
  const captured = await runtime.capture();
  fx.registry.rebind();

  await assert.rejects(
    () => runtime.runBound({ binding: captured, operation: async () => "write" }),
    hasCode("WORKSPACE_BINDING_CHANGED"),
  );
});

test("domain repository entries resolve by explicit mode and cache successful instances", async () => {
  const fx = fixture({ readWorkspace: binding() });
  const runtime = createWorkspaceRuntime(fx);

  const first = await runtime.learning({ mode: "read" });
  const second = await runtime.learning({ mode: "write" });

  assert.equal(first, second);
  assert.equal(first.mode, "read");
  assert.equal(fx.calls.learning, 1);
  assert.equal(fx.calls.write, 1);
});

test("a cached repository is not reused after the workspace binding changes", async () => {
  const fx = fixture();
  const runtime = createWorkspaceRuntime(fx);

  const beforeRebind = await runtime.learning({ mode: "write" });
  fx.registry.rebind();
  const afterRebind = await runtime.learning({ mode: "write" });

  assert.notEqual(afterRebind, beforeRebind);
  assert.equal(afterRebind.workspace.workspaceId, "workspace-b");
  assert.equal(fx.calls.learning, 2);
});

test("concurrent first requests share one in-flight repository construction", async () => {
  let attempts = 0;
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const delayed = new Promise((resolve) => { release = resolve; });
  const fx = fixture({
    readWorkspace: binding(),
    repositoryFactories: {
      ingestion: async ({ workspace, mode }) => {
        attempts += 1;
        entered();
        await delayed;
        return { name: "ingestion", workspace, mode };
      },
    },
  });
  const runtime = createWorkspaceRuntime(fx);

  const first = runtime.ingestion({ mode: "read" });
  await started;
  const second = runtime.ingestion({ mode: "read" });
  release();

  assert.equal(await first, await second);
  assert.equal(attempts, 1);
});

test("missing read repositories are not cached before a later write", async () => {
  const fx = fixture();
  const runtime = createWorkspaceRuntime(fx);

  assert.equal(await runtime.summary({ mode: "read" }), null);
  const created = await runtime.summary({ mode: "write" });

  assert.equal(created.name, "summary");
  assert.equal(fx.calls.summary, 1);
  assert.equal(fx.calls.read, 1);
  assert.equal(fx.calls.write, 1);
});

test("failed repository construction is retried instead of cached", async () => {
  let attempts = 0;
  const fx = fixture({
    readWorkspace: binding(),
    repositoryFactories: {
      radar: async ({ workspace, mode }) => {
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic factory failure");
        return { name: "radar", workspace, mode };
      },
    },
  });
  const runtime = createWorkspaceRuntime(fx);

  await assert.rejects(() => runtime.radar({ mode: "read" }), /synthetic factory failure/);
  const retried = await runtime.radar({ mode: "read" });

  assert.equal(retried.name, "radar");
  assert.equal(attempts, 2);
});

test("backup is an explicit factory entry and caches its successful result", async () => {
  const fx = fixture({ readWorkspace: binding() });
  const runtime = createWorkspaceRuntime(fx);

  const first = await runtime.backup({ mode: "read" });
  const second = await runtime.backup({ mode: "write" });

  assert.equal(first, second);
  assert.equal(first.name, "backup");
  assert.equal(fx.calls.backup, 1);
  assert.equal(fx.calls.write, 1);
});

test("a write flow captures before slow work and guards the factory immediately before construction", async () => {
  const events = [];
  const fx = fixture({ events });
  const runtime = createWorkspaceRuntime(fx);

  const expected = await runtime.capture();
  events.push("slow-operation");
  await runtime.runBound({
    binding: expected,
    operation: () => runtime.radar({ mode: "write" }),
  });

  assert.deepEqual(events, ["capture", "slow-operation", "runBound", "resolve:write", "radar"]);
});

test("invalid modes are rejected as stable domain errors", async () => {
  const runtime = createWorkspaceRuntime(fixture());

  await assert.rejects(
    () => runtime.radar({ mode: "preview" }),
    hasCode("WORKSPACE_RUNTIME_INVALID_MODE"),
  );
});
