import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceRuntime } from "../server/workspace-state/workspace-runtime.mjs";

function binding(workspaceId = "workspace-a") {
  return { fingerprint: "a".repeat(64), workspaceId };
}

function fixture({ readWorkspace = null, repositoryFactories = {} } = {}) {
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
      return mode === "read" ? readWorkspace : current;
    },
    async capture() {
      calls.capture += 1;
      return current;
    },
    async runBound({ binding: expected, operation }) {
      calls.runBound += 1;
      if (expected.workspaceId !== current.workspaceId || expected.fingerprint !== current.fingerprint) {
        const error = new Error("工作区绑定已改变，请重新加载后重试。");
        error.code = "WORKSPACE_BINDING_CHANGED";
        throw error;
      }
      return operation();
    },
    rebind() {
      current = binding("workspace-b");
    },
  };
  const repositories = Object.fromEntries(
    ["learning", "summary", "ingestion", "radar"].map((name) => [name, repositoryFactories[name] ?? (async ({ workspace, mode }) => {
      calls[name] += 1;
      return { name, workspace, mode };
    })]),
  );
  const backup = async ({ workspace, mode }) => {
    calls.backup += 1;
    return { name: "backup", workspace, mode };
  };

  return { registry, repositories, backup, calls };
}

function hasCode(code) {
  return (error) => error?.code === code;
}

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
  assert.equal(fx.calls.write, 0);
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
  assert.equal(fx.calls.write, 0);
});

test("invalid modes are rejected as stable domain errors", async () => {
  const runtime = createWorkspaceRuntime(fixture());

  await assert.rejects(
    () => runtime.radar({ mode: "preview" }),
    hasCode("WORKSPACE_RUNTIME_INVALID_MODE"),
  );
});
