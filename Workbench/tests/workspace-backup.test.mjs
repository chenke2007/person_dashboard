import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectRepository } from "../server/projects/project-repository.mjs";
import { createWorkspaceBackup, WorkspaceBackupError } from "../server/workspace-state/workspace-backup.mjs";

const WORKSPACE_ID = "workspace-synthetic";
const SECRET = Buffer.alloc(32, 7);

function mutableClock() {
  let value = new Date("2026-09-02T08:00:00.000Z");
  return {
    now: () => new Date(value),
    advance(milliseconds) { value = new Date(value.getTime() + milliseconds); },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkedBundle(data, { providerId = "projects", providerVersion = 1 } = {}) {
  const unsigned = {
    format: "personal-ai-workbench-backup",
    version: 1,
    workspaceId: "workspace-source",
    createdAt: "2026-09-02T07:00:00.000Z",
    providers: { [providerId]: { version: providerVersion, data } },
  };
  return {
    ...unsigned,
    checksum: createHash("sha256").update(canonicalJson(unsigned)).digest("hex"),
  };
}

function providerFixture({
  id = "projects",
  schemaVersion = 1,
  state = { version: 1, projects: [] },
  onReplace = () => {},
  stageImport,
} = {}) {
  return {
    id,
    schemaVersion,
    async exportState() { return structuredClone(state); },
    async validateImport(value) { return structuredClone(value); },
    async replaceState(value) { onReplace(structuredClone(value)); },
    ...(stageImport ? { stageImport } : {}),
  };
}

test("exports provider data, previews without mutation, and requires its token before replacement", async () => {
  let replaced;
  const provider = providerFixture({ onReplace(value) { replaced = value; } });
  const backup = createWorkspaceBackup({ providers: [provider], now: mutableClock().now, secret: SECRET });

  const bundle = await backup.exportBundle();
  assert.deepEqual(Object.keys(bundle.providers), ["projects"]);
  assert.equal(bundle.workspaceId, "local-workspace");
  const preview = await backup.previewImport(bundle);

  assert.equal(replaced, undefined);
  assert.deepEqual(preview.providers, [{ id: "projects", version: 1, count: 0 }]);
  assert.equal("data" in preview, false);
  assert.equal(JSON.stringify(preview).includes("projects\":[]"), false);
  await backup.confirmImport(preview.token);
  assert.deepEqual(replaced, bundle.providers.projects.data);
});

test("rejects unknown providers and provider versions before mutating state", async () => {
  let replaced;
  const target = createWorkspaceBackup({
    providers: [providerFixture({ onReplace(value) { replaced = value; } })],
    now: mutableClock().now,
    secret: SECRET,
    workspaceId: WORKSPACE_ID,
  });
  const newer = createWorkspaceBackup({
    providers: [providerFixture({ schemaVersion: 2 })],
    now: mutableClock().now,
    secret: SECRET,
    workspaceId: "workspace-newer",
  });

  await assert.rejects(
    target.previewImport(await newer.exportBundle()),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_BACKUP_PROVIDER_VERSION_UNSUPPORTED",
  );
  await assert.rejects(
    target.previewImport(checkedBundle({ version: 1 }, { providerId: "unknown-provider" })),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_BACKUP_PROVIDER_UNKNOWN",
  );
  const targetWithTwoProviders = createWorkspaceBackup({
    providers: [providerFixture(), providerFixture({ id: "ai-radar" })],
    now: mutableClock().now,
    secret: SECRET,
    workspaceId: WORKSPACE_ID,
  });
  await assert.rejects(
    targetWithTwoProviders.previewImport(await target.exportBundle()),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_BACKUP_PROVIDER_MISSING",
  );
  assert.equal(replaced, undefined);
});

test("rejects altered bundles and expired confirmation tokens without replacement", async () => {
  const clock = mutableClock();
  let replaced;
  const backup = createWorkspaceBackup({
    providers: [providerFixture({ onReplace(value) { replaced = value; } })],
    now: clock.now,
    secret: SECRET,
    workspaceId: WORKSPACE_ID,
  });
  const altered = await backup.exportBundle();
  altered.providers.projects.data.projects.push({ id: "synthetic-alteration" });

  await assert.rejects(
    backup.previewImport(altered),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_BACKUP_CHECKSUM_INVALID",
  );

  const preview = await backup.previewImport(await backup.exportBundle());
  clock.advance(15 * 60 * 1000 + 1);
  await assert.rejects(
    backup.confirmImport(preview.token),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_RESTORE_PREVIEW_EXPIRED",
  );
  assert.equal(replaced, undefined);
});

test("rejects credentials, caches, absolute paths, Vault bodies, and oversized payloads", async (t) => {
  const backup = createWorkspaceBackup({
    providers: [providerFixture()],
    now: mutableClock().now,
    secret: SECRET,
    workspaceId: WORKSPACE_ID,
  });
  const unsafe = [
    ["credential", { version: 1, credentials: { apiToken: "synthetic-secret" } }, "WORKSPACE_BACKUP_SENSITIVE_DATA"],
    ["cache", { version: 1, cache: { etag: "synthetic" } }, "WORKSPACE_BACKUP_SENSITIVE_DATA"],
    ["Windows drive absolute path", { version: 1, sourcePath: "C:\\synthetic-vault\\note.md" }, "WORKSPACE_BACKUP_ABSOLUTE_PATH"],
    ["Windows rooted absolute path", { version: 1, sourcePath: "\\synthetic-vault\\note.md" }, "WORKSPACE_BACKUP_ABSOLUTE_PATH"],
    ["POSIX rooted absolute path", { version: 1, sourcePath: "/synthetic-vault/note.md" }, "WORKSPACE_BACKUP_ABSOLUTE_PATH"],
    ["Vault body", { version: 1, vaultBody: "synthetic private body" }, "WORKSPACE_BACKUP_VAULT_BODY"],
    ["oversized", { version: 1, projects: [], padding: "x".repeat(33 * 1024 * 1024) }, "WORKSPACE_BACKUP_TOO_LARGE"],
  ];

  for (const [name, data, code] of unsafe) {
    await t.test(name, async () => {
      await assert.rejects(
        backup.previewImport(checkedBundle(data)),
        (error) => error instanceof WorkspaceBackupError && error.code === code,
      );
    });
  }
});

test("sanitizes unknown provider export failures", async () => {
  const provider = providerFixture();
  provider.exportState = async () => {
    throw new Error("could not open C:\\synthetic-user\\private-token.txt");
  };
  const backup = createWorkspaceBackup({
    providers: [provider],
    now: mutableClock().now,
    secret: SECRET,
    workspaceId: WORKSPACE_ID,
  });

  await assert.rejects(
    backup.exportBundle(),
    (error) => {
      assert.equal(error instanceof WorkspaceBackupError, true);
      assert.equal(error.code, "WORKSPACE_BACKUP_EXPORT_FAILED");
      assert.equal(error.status, 500);
      assert.equal(error.message, "工作区状态导出失败。");
      assert.equal(error.message.includes("synthetic-user"), false);
      assert.equal(error.message.includes("private-token"), false);
      return true;
    },
  );
});

test("bounds pending restore previews by count and evicts expired and oldest tokens", async () => {
  const clock = mutableClock();
  const backup = createWorkspaceBackup({
    providers: [providerFixture()],
    now: clock.now,
    secret: SECRET,
    workspaceId: WORKSPACE_ID,
  });
  const bundle = await backup.exportBundle();
  const expired = await backup.previewImport(bundle);
  clock.advance(15 * 60 * 1000 + 1);
  const previews = [];
  for (let index = 0; index < 5; index += 1) {
    previews.push(await backup.previewImport(bundle));
  }

  await assert.rejects(
    backup.confirmImport(expired.token),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_RESTORE_PREVIEW_INVALID",
  );
  await assert.rejects(
    backup.confirmImport(previews[0].token),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_RESTORE_PREVIEW_INVALID",
  );
  await assert.doesNotReject(backup.confirmImport(previews.at(-1).token));
});

test("bounds pending restore previews to 64 MiB of retained bundle data", async () => {
  const backup = createWorkspaceBackup({
    providers: [providerFixture({ state: { version: 1, padding: "x".repeat(30 * 1024 * 1024) } })],
    now: mutableClock().now,
    secret: SECRET,
    workspaceId: WORKSPACE_ID,
  });
  const bundle = await backup.exportBundle();
  const first = await backup.previewImport(bundle);
  const second = await backup.previewImport(bundle);
  const third = await backup.previewImport(bundle);

  await assert.rejects(
    backup.confirmImport(first.token),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_RESTORE_PREVIEW_INVALID",
  );
  await assert.doesNotReject(backup.confirmImport(second.token));
  await assert.doesNotReject(backup.confirmImport(third.token));
});

test("stages every provider before commit and rolls committed providers back sequentially in reverse order", async () => {
  const events = [];
  const states = { alpha: "old-alpha", beta: "old-beta", gamma: "old-gamma" };
  function transactionalProvider(id, { failCommit = false } = {}) {
    return providerFixture({
      id,
      state: { version: 1, value: `new-${id}` },
      async stageImport(value) {
        events.push(`stage:${id}`);
        const previous = states[id];
        return {
          async commit() {
            events.push(`commit:${id}`);
            if (failCommit) throw new Error("synthetic commit failure");
            states[id] = value.value;
          },
          async rollback() {
            events.push(`rollback-start:${id}`);
            await Promise.resolve();
            states[id] = previous;
            events.push(`rollback-end:${id}`);
          },
          async cleanup() { events.push(`cleanup:${id}`); },
        };
      },
    });
  }
  const backup = createWorkspaceBackup({
    providers: [
      transactionalProvider("alpha"),
      transactionalProvider("beta"),
      transactionalProvider("gamma", { failCommit: true }),
    ],
    now: mutableClock().now,
    secret: SECRET,
    workspaceId: WORKSPACE_ID,
  });
  const preview = await backup.previewImport(await backup.exportBundle());

  await assert.rejects(
    backup.confirmImport(preview.token),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_RESTORE_COMMIT_FAILED",
  );
  assert.deepEqual(states, { alpha: "old-alpha", beta: "old-beta", gamma: "old-gamma" });
  assert.deepEqual(events.slice(0, 6), [
    "stage:alpha", "stage:beta", "stage:gamma", "commit:alpha", "commit:beta", "commit:gamma",
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("rollback")), [
    "rollback-start:beta",
    "rollback-end:beta",
    "rollback-start:alpha",
    "rollback-end:alpha",
  ]);
  assert.equal(events.some((event) => event.includes("gamma")), true);
  assert.equal(events.includes("rollback-start:gamma"), false);
  assert.ok(events.includes("cleanup:alpha"));
  assert.ok(events.includes("cleanup:beta"));
  assert.ok(events.includes("cleanup:gamma"));
});

test("continues reverse rollback after one provider rollback fails", async () => {
  const events = [];
  function transactionalProvider(id, { failCommit = false, failRollback = false } = {}) {
    return providerFixture({
      id,
      async stageImport() {
        return {
          async commit() {
            events.push(`commit:${id}`);
            if (failCommit) throw new Error("synthetic commit failure");
          },
          async rollback() {
            events.push(`rollback:${id}`);
            if (failRollback) throw new Error("synthetic rollback failure");
          },
          async cleanup() {},
        };
      },
    });
  }
  const backup = createWorkspaceBackup({
    providers: [
      transactionalProvider("alpha"),
      transactionalProvider("beta", { failRollback: true }),
      transactionalProvider("gamma", { failCommit: true }),
    ],
    now: mutableClock().now,
    secret: SECRET,
    workspaceId: WORKSPACE_ID,
  });
  const preview = await backup.previewImport(await backup.exportBundle());

  await assert.rejects(
    backup.confirmImport(preview.token),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_RESTORE_ROLLBACK_FAILED",
  );
  assert.deepEqual(events, [
    "commit:alpha",
    "commit:beta",
    "commit:gamma",
    "rollback:beta",
    "rollback:alpha",
  ]);
});

test("leaves every provider unchanged when staging fails", async () => {
  const events = [];
  const first = providerFixture({
    id: "alpha",
    async stageImport() {
      events.push("stage:alpha");
      return {
        async commit() { events.push("commit:alpha"); },
        async rollback() { events.push("rollback:alpha"); },
        async cleanup() { events.push("cleanup:alpha"); },
      };
    },
  });
  const second = providerFixture({
    id: "beta",
    async stageImport() {
      events.push("stage:beta");
      throw new Error("synthetic staging failure");
    },
  });
  const backup = createWorkspaceBackup({ providers: [first, second], now: mutableClock().now, secret: SECRET, workspaceId: WORKSPACE_ID });
  const preview = await backup.previewImport(await backup.exportBundle());

  await assert.rejects(
    backup.confirmImport(preview.token),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_RESTORE_STAGE_FAILED",
  );
  assert.equal(events.some((event) => event.startsWith("commit:")), false);
  assert.ok(events.includes("cleanup:alpha"));
});

test("cleans up a provider that returns an incomplete transaction contract", async () => {
  let cleaned = false;
  const provider = providerFixture({
    async stageImport() {
      return {
        async commit() {},
        async cleanup() { cleaned = true; },
      };
    },
  });
  const backup = createWorkspaceBackup({ providers: [provider], now: mutableClock().now, secret: SECRET, workspaceId: WORKSPACE_ID });
  const preview = await backup.previewImport(await backup.exportBundle());

  await assert.rejects(
    backup.confirmImport(preview.token),
    (error) => error instanceof WorkspaceBackupError && error.code === "WORKSPACE_RESTORE_STAGE_FAILED",
  );
  assert.equal(cleaned, true);
});

test("project repository exposes only its versioned store and supports reversible staged replacement", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-project-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004",
  ];
  const repository = createProjectRepository({ directory, makeId: () => ids.shift() });
  await repository.createProject({ key: "SYN", name: "Synthetic project" });
  const original = await repository.exportState();
  const replacement = { ...structuredClone(original), revision: original.revision + 10, projects: [], columns: [] };

  assert.equal(repository.id, "projects");
  assert.equal(repository.schemaVersion, 1);
  assert.deepEqual(Object.keys(original).sort(), ["activities", "columns", "labels", "projects", "revision", "taskLabels", "taskLinks", "tasks", "updatedAt", "version"]);
  const transaction = await repository.stageImport(replacement);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "projects.json"), "utf8")), original);
  await transaction.commit();
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "projects.json"), "utf8")), replacement);
  await transaction.rollback();
  await transaction.cleanup();
  assert.deepEqual(await repository.exportState(), original);

  await assert.rejects(repository.replaceState({ ...replacement, version: 99 }));
  assert.deepEqual(await repository.exportState(), original);
});

test("legacy project-only restore explicitly preserves optional radar state", async (t) => {
  const { createRadarRepository } = await import("../server/ai-radar/radar-repository.mjs");
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-optional-radar-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = createProjectRepository({ directory: path.join(directory, "projects") });
  const radar = createRadarRepository({ directory: path.join(directory, "ai-radar"), timeZone: "UTC" });
  await projects.createProject({ key: "OLD", name: "Synthetic legacy project" });
  const legacy = createWorkspaceBackup({ providers: [projects], secret: SECRET });
  const bundle = await legacy.exportBundle();
  await projects.createProject({ key: "NEW", name: "Synthetic later project" });
  await radar.updateSchedule({ enabled: true, time: "10:15" });
  const before = await radar.exportState();
  const backup = createWorkspaceBackup({ providers: [projects, radar], secret: SECRET });
  const preview = await backup.previewImport(bundle);
  assert.match(preview.warnings.join(" "), /ai-radar.*保留/);
  assert.deepEqual(preview.providers.map(({ id }) => id), ["projects"]);
  await backup.confirmImport(preview.token);
  assert.equal((await projects.getWorkspace()).projects.length, 1);
  assert.deepEqual(await radar.exportState(), before);
});

test("full project and radar backups round-trip and roll radar back if the later project commit fails", async (t) => {
  const { createRadarRepository } = await import("../server/ai-radar/radar-repository.mjs");
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-two-providers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = createProjectRepository({ directory: path.join(directory, "projects") });
  const radar = createRadarRepository({ directory: path.join(directory, "ai-radar"), timeZone: "UTC" });
  await projects.createProject({ key: "OLD", name: "Synthetic original project" });
  await radar.updateSchedule({ enabled: true });
  const backup = createWorkspaceBackup({ providers: [projects, radar], secret: SECRET });
  const bundle = await backup.exportBundle();
  assert.deepEqual(Object.keys(bundle.providers), ["ai-radar", "projects"]);
  await projects.createProject({ key: "NEW", name: "Synthetic newer project" });
  await radar.updateSchedule({ time: "12:00" });
  await backup.confirmImport((await backup.previewImport(bundle)).token);
  assert.deepEqual(await radar.exportState(), bundle.providers["ai-radar"].data);
  assert.deepEqual(await projects.exportState(), bundle.providers.projects.data);
  await radar.updateSchedule({ time: "15:00" });
  const before = await radar.exportState();
  const failingProjects = { ...projects, async stageImport(value) {
    const staged = await projects.stageImport(value);
    return { ...staged, async commit() { throw new Error("synthetic project commit failure"); } };
  } };
  const failingBackup = createWorkspaceBackup({ providers: [failingProjects, radar], secret: SECRET });
  await assert.rejects(failingBackup.confirmImport((await failingBackup.previewImport(bundle)).token), { code: "WORKSPACE_RESTORE_COMMIT_FAILED" });
  assert.deepEqual(await radar.exportState(), before);
  assert.deepEqual(await projects.exportState(), bundle.providers.projects.data);
  await radar.updateSchedule({ time: "16:00" }); // Cleanup released the durable lock.
});
