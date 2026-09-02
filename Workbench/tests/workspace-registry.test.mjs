import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  WorkspaceRegistryError,
  createWorkspaceRegistry,
} from "../server/workspace-state/workspace-registry.mjs";

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

async function makeStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-workspaces-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function sequenceIds(...ids) {
  let index = 0;
  return () => ids[index++] ?? `workspace-${index}`;
}

function mutableClock(initial = "2026-09-02T00:00:00.000Z") {
  let value = new Date(initial);
  return {
    now: () => new Date(value),
    advance(milliseconds) {
      value = new Date(value.getTime() + milliseconds);
    },
  };
}

async function readRegistry(directory) {
  return JSON.parse(await readFile(path.join(directory, "workspace-registry.json"), "utf8"));
}

async function startLockOwner(t, directory, { exitAfterLock = false } = {}) {
  const lockPath = path.join(directory, "workspace-registry.lock");
  const childSource = `
    import { open } from "node:fs/promises";
    import { once } from "node:events";
    import { randomBytes } from "node:crypto";
    const lockPath = process.argv.at(-2);
    const exitAfterLock = process.argv.at(-1) === "exit";
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({
      version: 1,
      pid: process.pid,
      token: randomBytes(32).toString("hex"),
      status: "held",
    }) + "\\n", "utf8");
    await handle.sync();
    process.stdout.write("locked\\n");
    if (exitAfterLock) {
      await handle.close();
    } else {
      await once(process.stdin, "data");
      await handle.close();
    }
  `;
  const holder = spawn(
    process.execPath,
    ["--input-type=module", "-e", childSource, lockPath, exitAfterLock ? "exit" : "hold"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(holder, "exit");
  t.after(() => {
    if (holder.exitCode == null) holder.kill();
  });
  const [ready] = await once(holder.stdout, "data");
  assert.equal(ready.toString("utf8"), "locked\n");
  return { holder, lockPath, exited };
}

test("keeps a stable workspace id and requires confirmation to rebind", async (t) => {
  const clock = mutableClock();
  const registry = createWorkspaceRegistry({
    directory: await makeStore(t),
    makeId: sequenceIds("workspace-1", "workspace-2"),
    now: clock.now,
  });
  const first = await registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault" });
  const preview = await registry.previewRebind({ currentFingerprint: FINGERPRINT_B, workspaceId: first.workspaceId });

  assert.equal(preview.requiresConfirmation, true);
  assert.equal((await registry.resolveVault({ fingerprint: FINGERPRINT_B, label: "Moved Vault" })).workspaceId === first.workspaceId, false);
  await registry.confirmRebind({ token: preview.token });
  assert.equal((await registry.resolveVault({ fingerprint: FINGERPRINT_B, label: "Moved Vault" })).workspaceId, first.workspaceId);
});

test("persists only safe registry metadata and hashes confirmation tokens", async (t) => {
  const directory = await makeStore(t);
  const registry = createWorkspaceRegistry({ directory, makeId: sequenceIds("workspace-1") });
  const workspace = await registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault" });
  const preview = await registry.previewRebind({ currentFingerprint: FINGERPRINT_B, workspaceId: workspace.workspaceId });
  const storedText = await readFile(path.join(directory, "workspace-registry.json"), "utf8");
  const stored = JSON.parse(storedText);

  assert.deepEqual(Object.keys(stored).sort(), ["pendingRebinds", "revision", "updatedAt", "version", "workspaces"]);
  assert.deepEqual(Object.keys(stored.workspaces[0]).sort(), ["createdAt", "fingerprint", "label", "updatedAt", "workspaceId"]);
  assert.equal(storedText.includes(directory), false);
  assert.equal(storedText.includes(preview.token), false);
  assert.match(stored.pendingRebinds[0].confirmationHash, /^[a-f0-9]{64}$/);
});

test("rejects expired and altered rebind previews without changing workspace ownership", async (t) => {
  const clock = mutableClock();
  const directory = await makeStore(t);
  const registry = createWorkspaceRegistry({ directory, makeId: sequenceIds("workspace-1"), now: clock.now });
  const workspace = await registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault" });
  const expired = await registry.previewRebind({ currentFingerprint: FINGERPRINT_B, workspaceId: workspace.workspaceId });
  clock.advance(15 * 60 * 1000 + 1);

  await assert.rejects(
    registry.confirmRebind({ token: expired.token }),
    (error) => error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_REBIND_PREVIEW_EXPIRED",
  );

  const fresh = await registry.previewRebind({ currentFingerprint: FINGERPRINT_B, workspaceId: workspace.workspaceId });
  const stored = await readRegistry(directory);
  stored.pendingRebinds[0].fingerprint = "c".repeat(64);
  await writeFile(path.join(directory, "workspace-registry.json"), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  await assert.rejects(
    registry.confirmRebind({ token: fresh.token }),
    (error) => error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_REBIND_PREVIEW_INVALID",
  );

  assert.equal((await registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault" })).workspaceId, workspace.workspaceId);
});

test("does not discard unrelated state created after a rebind preview", async (t) => {
  const directory = await makeStore(t);
  const registry = createWorkspaceRegistry({ directory, makeId: sequenceIds("workspace-1", "workspace-2") });
  const first = await registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault A" });
  const preview = await registry.previewRebind({ currentFingerprint: FINGERPRINT_B, workspaceId: first.workspaceId });
  const second = await registry.resolveVault({ fingerprint: FINGERPRINT_B, label: "Synthetic Vault B" });
  await writeFile(
    path.join(directory, "workspaces", second.workspaceId, "projects.json"),
    "synthetic unrelated state",
    "utf8",
  );

  await assert.rejects(
    registry.confirmRebind({ token: preview.token }),
    (error) => error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_REBIND_CONFLICT",
  );
  const workspaces = await registry.listWorkspaces();
  assert.equal(workspaces.find((item) => item.fingerprint === FINGERPRINT_A).workspaceId, first.workspaceId);
  assert.equal(workspaces.find((item) => item.fingerprint === FINGERPRINT_B).workspaceId, second.workspaceId);
});

test("removes pending previews owned by a provisional workspace removed during confirmation", async (t) => {
  const directory = await makeStore(t);
  const registry = createWorkspaceRegistry({
    directory,
    makeId: sequenceIds("workspace-1", "workspace-2"),
  });
  const first = await registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault A" });
  const firstPreview = await registry.previewRebind({
    currentFingerprint: FINGERPRINT_B,
    workspaceId: first.workspaceId,
  });
  const provisional = await registry.resolveVault({ fingerprint: FINGERPRINT_B, label: "Synthetic Vault B" });
  const overlappingPreview = await registry.previewRebind({
    currentFingerprint: "c".repeat(64),
    workspaceId: provisional.workspaceId,
  });

  await registry.confirmRebind({ token: firstPreview.token });

  await assert.rejects(
    registry.confirmRebind({ token: overlappingPreview.token }),
    (error) => error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_REBIND_PREVIEW_INVALID",
  );
  const stored = await readRegistry(directory);
  assert.equal(stored.pendingRebinds.length, 0);
  assert.equal(stored.workspaces.some((item) => item.workspaceId === provisional.workspaceId), false);
});

test("waits for a cross-process lock and re-reads before writing", async (t) => {
  const directory = await makeStore(t);
  const lockPath = path.join(directory, "workspace-registry.lock");
  const childSource = `
    import { open, unlink } from "node:fs/promises";
    import { once } from "node:events";
    const lockPath = process.argv.at(-1);
    const handle = await open(lockPath, "wx", 0o600);
    process.stdout.write("locked\\n");
    await once(process.stdin, "data");
    await handle.close();
    await unlink(lockPath);
  `;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", childSource, lockPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (!holder.killed) holder.kill();
  });
  const [ready] = await once(holder.stdout, "data");
  assert.equal(ready.toString("utf8"), "locked\n");

  const registry = createWorkspaceRegistry({ directory, makeId: sequenceIds("workspace-1") });
  const pending = registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault" });
  await delay(75);
  const target = path.join(directory, "workspace-registry.json");
  const newer = `${JSON.stringify({ version: 99, sentinel: "newer-state" })}\n`;
  await writeFile(target, newer, "utf8");
  holder.stdin.end("release\n");
  await once(holder, "exit");

  await assert.rejects(
    pending,
    (error) => error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_REGISTRY_VERSION_UNSUPPORTED",
  );
  assert.equal(await readFile(target, "utf8"), newer);
});

test("reclaims a lock after its child-process owner exits abruptly", async (t) => {
  const directory = await makeStore(t);
  const { lockPath, exited } = await startLockOwner(t, directory, { exitAfterLock: true });
  await exited;
  const registry = createWorkspaceRegistry({
    directory,
    makeId: sequenceIds("workspace-1"),
    lockTimeoutMs: 250,
  });

  const workspace = await registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault" });

  assert.equal(workspace.workspaceId, "workspace-1");
  await assert.rejects(access(lockPath), (error) => error?.code === "ENOENT");
});

test("never steals a lock from a live child-process owner", async (t) => {
  const directory = await makeStore(t);
  const { holder, lockPath, exited } = await startLockOwner(t, directory);
  const registry = createWorkspaceRegistry({
    directory,
    makeId: sequenceIds("workspace-1"),
    lockTimeoutMs: 100,
  });

  await assert.rejects(
    registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault" }),
    (error) => error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_REGISTRY_BUSY",
  );
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, holder.pid);
  holder.stdin.end("release\n");
  await exited;
  await unlink(lockPath);
});

test("does not replace a committed result when lock cleanup fails and recovers later", async (t) => {
  const directory = await makeStore(t);
  const lockPath = path.join(directory, "workspace-registry.lock");
  let failCleanup = true;
  const registry = createWorkspaceRegistry({
    directory,
    makeId: sequenceIds("workspace-1", "workspace-2"),
    async removeLock(candidate) {
      if (failCleanup) {
        failCleanup = false;
        const error = new Error("synthetic cleanup denial");
        error.code = "EACCES";
        throw error;
      }
      await unlink(candidate);
    },
  });

  const first = await registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault A" });

  assert.equal(first.workspaceId, "workspace-1");
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).status, "released");
  const second = await registry.resolveVault({ fingerprint: FINGERPRINT_B, label: "Synthetic Vault B" });
  assert.equal(second.workspaceId, "workspace-2");
  assert.equal((await registry.listWorkspaces()).length, 2);
  await assert.rejects(access(lockPath), (error) => error?.code === "ENOENT");
});

test("refuses unknown and corrupt schema versions without overwriting them", async (t) => {
  for (const [name, contents, code] of [
    ["unknown", { version: 99, sentinel: "keep-me" }, "WORKSPACE_REGISTRY_VERSION_UNSUPPORTED"],
    ["corrupt", { version: 1, workspaces: "invalid", sentinel: "keep-me" }, "WORKSPACE_REGISTRY_CORRUPT"],
  ]) {
    await t.test(name, async () => {
      const directory = await makeStore(t);
      const target = path.join(directory, "workspace-registry.json");
      const original = `${JSON.stringify(contents)}\n`;
      await writeFile(target, original, "utf8");
      const registry = createWorkspaceRegistry({ directory });

      await assert.rejects(
        registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault" }),
        (error) => error instanceof WorkspaceRegistryError && error.code === code,
      );
      assert.equal(await readFile(target, "utf8"), original);
    });
  }
});

test("adopts an existing hashed state directory without moving its projects", async (t) => {
  const directory = await makeStore(t);
  const legacyWorkspaceId = FINGERPRINT_A.slice(0, 24);
  const legacyProjects = path.join(directory, legacyWorkspaceId, "projects");
  await mkdir(legacyProjects, { recursive: true });
  await writeFile(path.join(legacyProjects, "marker.txt"), "synthetic project state", "utf8");
  const registry = createWorkspaceRegistry({ directory, makeId: sequenceIds("new-workspace") });

  const workspace = await registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault" });

  assert.equal(workspace.workspaceId, legacyWorkspaceId);
  assert.equal(workspace.storageLayout, "legacy");
  assert.equal(await readFile(path.join(legacyProjects, "marker.txt"), "utf8"), "synthetic project state");
});

test("rejects a junction used as the registry directory", async (t) => {
  const root = await makeStore(t);
  const outside = path.join(root, "outside");
  const junction = path.join(root, "registry-link");
  await mkdir(outside);
  await symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
  const registry = createWorkspaceRegistry({ directory: junction });

  await assert.rejects(
    registry.listWorkspaces(),
    (error) => error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_REGISTRY_PATH_UNSAFE",
  );
});

test("rejects a junction used as the versioned workspace parent", async (t) => {
  const directory = await makeStore(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "workbench-workspaces-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(directory, "workspaces"), process.platform === "win32" ? "junction" : "dir");
  const registry = createWorkspaceRegistry({ directory, makeId: sequenceIds("workspace-1") });

  await assert.rejects(
    registry.resolveVault({ fingerprint: FINGERPRINT_A, label: "Synthetic Vault" }),
    (error) => error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_STATE_PATH_UNSAFE",
  );
});
