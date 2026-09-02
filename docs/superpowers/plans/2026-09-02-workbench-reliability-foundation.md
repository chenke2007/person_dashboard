# Workbench Reliability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local project state safe to start, migrate, back up, restore, and rebind before adding AI radar data.

**Architecture:** Introduce a versioned workspace-state seam whose providers own validation and import/export. Keep project behavior in `ProjectRepository`; a registry maps the current Vault fingerprint to a stable local workspace ID, while backup orchestration operates only on provider payloads and excludes credentials and caches.

**Tech Stack:** Node.js ESM, React 19, Vite 6, Zod 3, Node test runner, filesystem atomic writes.

**Spec:** `docs/superpowers/specs/2026-09-02-ai-radar-learning-loop-design.md`

## Global Constraints

- Preserve loopback-only mutation APIs and hosted-build feature gates.
- Never place an absolute Vault path, credential, or real project payload in tracked files or test fixtures.
- Backup import is preview-first and confirmation-gated; unknown or corrupt versions never overwrite current state.
- Vault rebind must be explicit and must not silently attach an unrelated workspace.
- Use fully synthetic paths and records in tests.
- Every production behavior starts with a failing test.

---

### Task 1: Cross-platform release commands and stable startup contract

**Files:**
- Create: `Workbench/scripts/build-workbench.mjs`
- Modify: `Workbench/package.json`
- Modify: `Workbench/README.md`
- Modify: `README.md`
- Test: `Workbench/tests/package-scripts.test.mjs`

**Interfaces:**
- Consumes: Vite's programmatic `build()` function and existing `scripts/prepare-sites-build.mjs` side effect.
- Produces: `npm run build` that works on Windows and POSIX; one documented local start command: `cd Workbench && npm run dev`.

- [ ] **Step 1: Write the failing package-script test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("build script is cross-platform and startup has one documented entry", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.build, "node scripts/build-workbench.mjs");
  assert.equal(pkg.scripts.dev, "vite");
  const source = await readFile(new URL("../scripts/build-workbench.mjs", import.meta.url), "utf8");
  assert.match(source, /VITE_WORKBENCH_HOSTED/);
  assert.doesNotMatch(source, /shell:\s*true/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd Workbench && node --test tests/package-scripts.test.mjs`
Expected: FAIL because `build` still contains POSIX inline environment syntax and the script file is absent.

- [ ] **Step 3: Implement the programmatic build**

```js
// Workbench/scripts/build-workbench.mjs
process.env.VITE_WORKBENCH_HOSTED = "true";
const { build } = await import("vite");
await build();
await import("./prepare-sites-build.mjs");
```

Set `package.json` script `build` to `node scripts/build-workbench.mjs`. Document the single start command and explain that features must be merged into the checked-out branch; do not document a `.worktrees` path.

- [ ] **Step 4: Verify the test and real build**

Run: `cd Workbench && node --test tests/package-scripts.test.mjs && npm run build`
Expected: PASS and a completed Vite/Sites build on Windows.

- [ ] **Step 5: Commit**

```bash
git add Workbench/package.json Workbench/scripts/build-workbench.mjs Workbench/tests/package-scripts.test.mjs Workbench/README.md README.md
git commit -m "fix: make Workbench release commands portable"
```

### Task 2: Archived task listing and restore

**Files:**
- Modify: `Workbench/server/projects/project-repository.mjs`
- Modify: `Workbench/server/projects/project-routes.mjs`
- Modify: `Workbench/src/lib/project-api.js`
- Modify: `Workbench/src/pages/ProjectPage.jsx`
- Modify: `Workbench/src/components/projects/projects.css`
- Test: `Workbench/tests/project-repository.test.mjs`
- Test: `Workbench/tests/project-api.test.mjs`
- Test: `Workbench/tests/projects-ui.test.mjs`

**Interfaces:**
- Consumes: existing `archiveTask(taskId)` and project snapshot.
- Produces: `restoreTask(taskId)`, `GET /api/projects/:id?archived=include`, `POST /api/tasks/:id/restore`, and an archived-task view.

- [ ] **Step 1: Write failing repository tests**

```js
test("lists and restores archived tasks without changing their number", async (t) => {
  const { repository, created } = await projectFixture(t);
  const made = await repository.createTask({ projectId: created.project.id, title: "Synthetic task" });
  await repository.archiveTask(made.task.id);
  assert.equal((await repository.getProject(created.project.id)).tasks.length, 0);
  assert.equal((await repository.getProject(created.project.id, { includeArchived: true })).tasks.length, 1);
  const restored = await repository.restoreTask(made.task.id);
  assert.equal(restored.task.number, made.task.number);
  assert.equal(restored.task.archivedAt, null);
  assert.equal(restored.activities[0].type, "task.restored");
});
```

- [ ] **Step 2: Run repository test and verify RED**

Run: `cd Workbench && node --test tests/project-repository.test.mjs`
Expected: FAIL because `getProject` has no options and `restoreTask` is missing.

- [ ] **Step 3: Implement repository behavior**

Add `getProject(projectId, { includeArchived = false } = {})` and:

```js
restoreTask(taskId) {
  return mutate((store, timestamp) => {
    const task = requireTask(store, taskId);
    task.archivedAt = null;
    task.updatedAt = timestamp;
    appendActivity(store, task.projectId, task.id, "task.restored", {}, timestamp);
    normalizeTaskPositions(store, task.projectId, task.columnId);
    return task;
  });
}
```

- [ ] **Step 4: Add failing route and UI tests**

Assert `POST /api/tasks/:id/restore` returns 200 and the project page exposes an “已归档任务” view with a “恢复任务” action.

- [ ] **Step 5: Implement route, client, and UI**

Extend the task route pattern to `move|archive|restore|labels|links`, add `restoreTask()` to `project-api.js`, and load archived tasks only when the user opens the archived view.

- [ ] **Step 6: Verify focused tests**

Run: `cd Workbench && node --test tests/project-repository.test.mjs tests/project-api.test.mjs tests/projects-ui.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Workbench/server/projects Workbench/src/lib/project-api.js Workbench/src/pages/ProjectPage.jsx Workbench/src/components/projects/projects.css Workbench/tests/project-*.test.mjs Workbench/tests/projects-ui.test.mjs
git commit -m "feat: restore archived project tasks"
```

### Task 3: Versioned workspace registry and Vault rebind

**Files:**
- Create: `Workbench/server/workspace-state/workspace-registry.mjs`
- Create: `Workbench/server/workspace-state/workspace-schema.mjs`
- Create: `Workbench/tests/workspace-registry.test.mjs`
- Modify: `Workbench/server/vite-plugin-workbench.mjs`

**Interfaces:**
- Consumes: normalized Vault root and application data root.
- Produces: `createWorkspaceRegistry({ directory, now, makeId })` with `resolveVault()`, `listWorkspaces()`, `previewRebind()`, and `confirmRebind()`.

- [ ] **Step 1: Write failing registry tests**

```js
test("keeps a stable workspace id and requires confirmation to rebind", async (t) => {
  const registry = createWorkspaceRegistry({ directory: await makeStore(t), makeId: sequenceIds(), now: fixedClock() });
  const first = await registry.resolveVault({ fingerprint: "a".repeat(64), label: "Synthetic Vault" });
  const preview = await registry.previewRebind({ currentFingerprint: "b".repeat(64), workspaceId: first.workspaceId });
  assert.equal(preview.requiresConfirmation, true);
  assert.equal((await registry.resolveVault({ fingerprint: "b".repeat(64), label: "Moved Vault" })).workspaceId === first.workspaceId, false);
  await registry.confirmRebind({ token: preview.token });
  assert.equal((await registry.resolveVault({ fingerprint: "b".repeat(64), label: "Moved Vault" })).workspaceId, first.workspaceId);
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/workspace-registry.test.mjs`
Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement strict schema and atomic registry writes**

Use a v1 Zod store containing workspace IDs, labels, hashed fingerprints, timestamps, and pending confirmation hashes. Never store an absolute Vault path. `confirmRebind()` must reject expired or altered previews.

```js
export function createWorkspaceRegistry({ directory, now = () => new Date(), makeId = randomUUID }) {
  return { resolveVault, listWorkspaces, previewRebind, confirmRebind };
}
```

- [ ] **Step 4: Route project state through stable workspace ID**

In `workbenchApiPlugin`, replace the direct `vaultId` directory choice with the registry result:

```js
const workspace = await registry.resolveVault({ fingerprint: vaultFingerprint, label: path.basename(vaultRoot) });
const stateRoot = path.join(appDataRoot, "PersonalAIWorkbench", "workspaces", workspace.workspaceId);
```

Migration must recognize the existing hashed directory as a candidate, register it without moving data, and preserve current projects.

- [ ] **Step 5: Verify legacy adoption, rebind, corruption, and symlink defenses**

Run: `cd Workbench && node --test tests/workspace-registry.test.mjs tests/project-api.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Workbench/server/workspace-state Workbench/server/vite-plugin-workbench.mjs Workbench/tests/workspace-registry.test.mjs Workbench/tests/project-api.test.mjs
git commit -m "feat: add stable local workspace registry"
```

### Task 4: Provider-based backup export and previewed restore

**Files:**
- Create: `Workbench/server/workspace-state/backup-schema.mjs`
- Create: `Workbench/server/workspace-state/workspace-backup.mjs`
- Create: `Workbench/server/workspace-state/workspace-routes.mjs`
- Create: `Workbench/tests/workspace-backup.test.mjs`
- Modify: `Workbench/server/projects/project-repository.mjs`
- Modify: `Workbench/server/vite-plugin-workbench.mjs`

**Interfaces:**
- Consumes: providers implementing `id`, `schemaVersion`, `exportState()`, `validateImport(value)`, and `replaceState(value)`.
- Produces: `createWorkspaceBackup({ providers, now, secret })` with `exportBundle()`, `previewImport(bundle)`, and `confirmImport(token)`.

- [ ] **Step 1: Write failing provider and backup tests**

```js
const provider = {
  id: "projects",
  schemaVersion: 1,
  exportState: async () => ({ version: 1, projects: [] }),
  validateImport: async (value) => value,
  replaceState: async (value) => { replaced = value; },
};
const backup = createWorkspaceBackup({ providers: [provider], now: fixedClock(), secret: Buffer.alloc(32, 7) });
const bundle = await backup.exportBundle();
assert.deepEqual(Object.keys(bundle.providers), ["projects"]);
const preview = await backup.previewImport(bundle);
assert.equal(replaced, undefined);
await backup.confirmImport(preview.token);
assert.deepEqual(replaced, bundle.providers.projects.data);
```

Also assert unknown provider versions, altered bundles, expired tokens, credentials, absolute paths, and oversized payloads are rejected.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/workspace-backup.test.mjs`
Expected: FAIL because backup modules are absent.

- [ ] **Step 3: Add project provider methods**

Expose only validated store data:

```js
exportState() { return readStore(); },
validateImport(value) { return projectStoreSchema.parseAsync(migrateProjectStore(value)); },
replaceState(value) { return replaceStoreAtomically(value); },
```

- [ ] **Step 4: Implement signed preview and atomic confirmation**

The preview token binds the bundle checksum, provider versions, workspace ID, and expiry. Validate every provider before replacing any. Stage all files first, then commit replacements; if staging fails, leave current state unchanged.

- [ ] **Step 5: Add local-only routes**

Implement:

- `GET /api/workspace/backup`
- `POST /api/workspace/restore/preview`
- `POST /api/workspace/restore/confirm`
- `GET /api/workspace/rebind/candidates`
- `POST /api/workspace/rebind/preview`
- `POST /api/workspace/rebind/confirm`

Reuse existing same-origin, JSON and loopback mutation checks in the Vite plugin.

- [ ] **Step 6: Verify backup and route tests**

Run: `cd Workbench && node --test tests/workspace-backup.test.mjs tests/project-api.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Workbench/server/workspace-state Workbench/server/projects/project-repository.mjs Workbench/server/vite-plugin-workbench.mjs Workbench/tests/workspace-backup.test.mjs Workbench/tests/project-api.test.mjs
git commit -m "feat: add safe workspace backup and restore"
```

### Task 5: Backup and rebind user interface

**Files:**
- Create: `Workbench/src/lib/workspace-api.js`
- Create: `Workbench/src/components/system/WorkspaceDataPanel.jsx`
- Modify: `Workbench/src/pages/SystemPage.jsx`
- Modify: `Workbench/src/styles.css`
- Create: `Workbench/tests/workspace-ui.test.mjs`

**Interfaces:**
- Consumes: workspace backup, restore-preview, restore-confirm, and rebind endpoints.
- Produces: system page actions for export, previewed restore, and explicit Vault rebind.

- [ ] **Step 1: Write failing UI contract tests**

Assert the system page has “导出工作台备份”, “预览恢复”, and “重新绑定本地工作区”; confirmation buttons remain disabled until a successful preview returns a token.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/workspace-ui.test.mjs`
Expected: FAIL because the panel is absent.

- [ ] **Step 3: Implement API client and panel**

```js
export const exportWorkspaceBackup = () => request("/api/workspace/backup");
export const previewWorkspaceRestore = (bundle) => command("/api/workspace/restore/preview", bundle);
export const confirmWorkspaceRestore = (token) => command("/api/workspace/restore/confirm", { token });
```

Show provider counts, versions, warnings, and excluded secret/cache copy before confirmation. Never render absolute paths returned by accidental server errors.

- [ ] **Step 4: Verify UI and build**

Run: `cd Workbench && node --test tests/workspace-ui.test.mjs && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Workbench/src/lib/workspace-api.js Workbench/src/components/system Workbench/src/pages/SystemPage.jsx Workbench/src/styles.css Workbench/tests/workspace-ui.test.mjs
git commit -m "feat: add workspace data recovery controls"
```

### Task 6: Reliability release gate

**Files:**
- No planned source changes. Any failure returns to the task that owns the failing behavior before this gate is rerun.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: a green, reviewable reliability increment ready for branch integration.

- [ ] **Step 1: Run focused reliability tests**

Run: `cd Workbench && node --test --test-concurrency=1 tests/package-scripts.test.mjs tests/project-*.test.mjs tests/projects-ui.test.mjs tests/workspace-*.test.mjs`
Expected: PASS with zero failures.

- [ ] **Step 2: Run the full release gate**

Run: `cd Workbench && npm test && npm run build && npm run privacy:scan`
Expected: all commands exit 0. Do not waive Windows symlink or watcher failures; make the test harness use supported junction/temp-directory behavior without weakening escape checks.

- [ ] **Step 3: Inspect privacy and Git state**

Run: `git diff --check && git status --short`
Expected: no whitespace errors, no `.env`, backup payload, local path, generated runtime data, or credential file staged.

- [ ] **Step 4: Finish the branch deliberately**

Use `superpowers:finishing-a-development-branch`. The expected base is `main`; verify it before merging. After a local merge, rerun the full release gate on `main` before removing the worktree.
