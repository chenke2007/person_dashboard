# Project Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only personal project management module with projects, columns, tasks, Board/List/Backlog views, filters, labels, Vault links, activity history, and durable local storage.

**Architecture:** A deep `ProjectRepository` module owns validation, invariants, ordering, revisions, activity generation, and atomic persistence. A focused route module maps `/api/projects/*` HTTP requests to that repository, while React pages consume a small `project-api` interface and derive views through pure model functions.

**Tech Stack:** Node.js 22, React 19, React Router 7, Vite 6, Zod 3, Node test runner, `@dnd-kit/core`, `@dnd-kit/sortable`.

**Spec:** `docs/superpowers/specs/2026-09-01-project-management-design.md`

## Global Constraints

- Local API remains bound to `127.0.0.1` and every mutation requires same-origin JSON requests.
- Hosted builds do not expose project navigation or mutation behavior.
- Real project data lives below `%LOCALAPPDATA%/PersonalAIWorkbench/<vault-id>/projects/` and never in the public repository.
- `vault-id` is the first 24 hexadecimal characters of the SHA-256 hash of the normalized absolute Vault path.
- Storage schema version is exactly `1`; corrupt or unknown versions are never overwritten.
- Project state uses `columnId` as the only status source; `null` means Backlog.
- No user accounts, assignees, comments, attachments, time tracking, Calendar, Gantt, WebSocket, PostgreSQL, Redis, or external integrations in this plan.
- Public examples, if any are required for tests, are synthetic and clearly identified.

---

### Task 1: Durable Project Repository

**Files:**
- Create: `Workbench/server/projects/project-repository.mjs`
- Create: `Workbench/server/projects/project-schema.mjs`
- Create: `Workbench/tests/project-repository.test.mjs`

**Interfaces:**
- Consumes: absolute `directory`, optional `now()`, `makeId()`, and async `resolveDocument(documentId)` dependencies.
- Produces: `createProjectRepository({ directory, now, makeId, resolveDocument })` with `getWorkspace`, `getProject`, `createProject`, `updateProject`, `archiveProject`, `createColumn`, `updateColumn`, `reorderColumns`, `createTask`, `updateTask`, `moveTask`, `archiveTask`, `createLabel`, `setTaskLabels`, `addTaskLink`, and `removeTaskLink`.
- Produces: `ProjectRepositoryError` with `code`, `message`, optional `details`, and `status`.

- [ ] **Step 1: Write failing tests for initialization and project creation**

```js
test("creates a project with three default columns and a stable revision", async (t) => {
  const directory = await makeStore(t);
  const repository = createProjectRepository({ directory, now: fixedClock(), makeId: sequenceIds() });
  assert.deepEqual(await repository.getWorkspace(), emptyWorkspace());
  const project = await repository.createProject({ key: "PAW", name: "Personal AI Workbench" });
  assert.equal(project.project.key, "PAW");
  assert.deepEqual(project.columns.map(({ name, isFinal }) => ({ name, isFinal })), [
    { name: "待办", isFinal: false },
    { name: "进行中", isFinal: false },
    { name: "已完成", isFinal: true },
  ]);
  assert.equal((await repository.getWorkspace()).revision, 1);
});
```

- [ ] **Step 2: Run the repository test and verify RED**

Run: `node --test tests/project-repository.test.mjs`

Expected: FAIL because `server/projects/project-repository.mjs` does not exist.

- [ ] **Step 3: Implement schema, safe directory checks, read/write, revisions, and project creation**

Define the persisted root as:

```js
const emptyStore = () => ({
  version: 1,
  revision: 0,
  updatedAt: null,
  projects: [], columns: [], tasks: [], labels: [], taskLabels: [], taskLinks: [], activities: [],
});
```

Validate with Zod before and after every mutation. Serialize mutations through one promise queue. Write `projects.json` through a unique `wx` temporary file, `FileHandle.sync()`, and `rename()`. Reject symbolic-link directories and files.

- [ ] **Step 4: Run initialization tests and verify GREEN**

Run: `node --test tests/project-repository.test.mjs`

Expected: PASS for empty initialization, default columns, unique normalized project keys, and persistence after repository reconstruction.

- [ ] **Step 5: Write failing tests for task numbering, invariants, movement, labels, links, and activities**

```js
test("moves tasks atomically and rejects stale revisions", async (t) => {
  const repository = await projectFixture(t);
  const first = await repository.createTask({ projectId: "project-1", title: "First" });
  const second = await repository.createTask({ projectId: "project-1", title: "Second" });
  const moved = await repository.moveTask({ taskId: second.task.id, columnId: "column-doing", index: 0, revision: second.revision });
  assert.equal(moved.task.columnId, "column-doing");
  await assert.rejects(
    repository.moveTask({ taskId: first.task.id, columnId: "column-doing", index: 0, revision: second.revision }),
    (error) => error.code === "PROJECT_REVISION_CONFLICT" && error.status === 409,
  );
});
```

Also cover project-local monotonically increasing task numbers, Backlog moves, continuous positions, date ordering, cross-project column rejection, final-column completion, column deletion constraints, label uniqueness, `resolveDocument` rejection for an unknown Vault document, and archive behavior.

- [ ] **Step 6: Implement repository commands with one mutation helper**

Every mutation calls `mutate(expectedRevision, operation)`, clones the validated store, applies the operation, normalizes positions, appends an activity when task state changes, increments `revision`, validates, writes, and returns a projection.

- [ ] **Step 7: Run repository tests and verify GREEN**

Run: `node --test tests/project-repository.test.mjs`

Expected: all repository tests PASS and no `.tmp` file remains.

- [ ] **Step 8: Commit**

```bash
git add Workbench/server/projects Workbench/tests/project-repository.test.mjs
git commit -m "feat: add durable project repository"
```

### Task 2: Local HTTP Project Routes

**Files:**
- Create: `Workbench/server/projects/project-routes.mjs`
- Create: `Workbench/tests/project-api.test.mjs`
- Modify: `Workbench/server/vite-plugin-workbench.mjs`

**Interfaces:**
- Consumes: `createProjectRepository`, `getIndex()`, `readOnly`, and the existing mutation request guard.
- Produces: `createProjectRoutes({ repository, getIndex, readOnly })` returning `{ matches(req, url), handle(req, res, url) }`.
- Produces JSON envelopes `{ revision, ...projection }` and errors `{ error: { code, message, details? } }`.

- [ ] **Step 1: Write failing HTTP integration tests**

Start a middleware-mode Vite fixture with an injected temporary project directory. Assert:

```js
const created = await jsonFetch(origin, "/api/projects", {
  method: "POST",
  body: { key: "PAW", name: "Workbench" },
});
assert.equal(created.response.status, 201);
assert.equal(created.body.project.key, "PAW");
assert.equal((await jsonFetch(origin, `/api/projects/${created.body.project.id}`)).body.columns.length, 3);
```

Cover create/update/archive project, create/update/move/archive task, labels and links, 409 revision conflicts, malformed JSON, wrong content type, cross-origin mutations, read-only mode, and a TaskLink path absent from the Vault index.

- [ ] **Step 2: Run the API test and verify RED**

Run: `node --test tests/project-api.test.mjs`

Expected: FAIL with 404 for `/api/projects`.

- [ ] **Step 3: Implement route matching and handlers**

Parse exact route patterns with anchored regular expressions. Limit request bodies to 256 KiB. Route functions must pass the current revision to repository mutations and map `ProjectRepositoryError.status`; unexpected errors return `500 PROJECT_STORAGE_ERROR` without local paths.

- [ ] **Step 4: Delegate from the Vite plugin**

Instantiate the repository lazily below the app-data directory already used by knowledge chat. Call `projectRoutes.matches()` before the legacy route chain and `await projectRoutes.handle()` when matched. Export or reuse the existing mutation guard instead of copying its logic.

- [ ] **Step 5: Run API and existing security tests**

Run: `node --test tests/project-api.test.mjs tests/reader-api.test.mjs tests/vault-sync.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Workbench/server/projects/project-routes.mjs Workbench/server/vite-plugin-workbench.mjs Workbench/tests/project-api.test.mjs
git commit -m "feat: expose local project API"
```

### Task 3: Frontend Project Model and API Client

**Files:**
- Create: `Workbench/src/lib/project-api.js`
- Create: `Workbench/src/lib/project-model.js`
- Create: `Workbench/tests/project-model.test.mjs`
- Create: `Workbench/tests/project-api-client.test.mjs`

**Interfaces:**
- Consumes: the existing `request(path, options)` helper, exported from `src/lib/api.js` or moved without behavior change to a shared request module.
- Produces: `loadProjects`, `createProject`, `loadProject`, `updateProject`, `archiveProject`, `createTask`, `updateTask`, `moveTask`, `archiveTask`, `setTaskLabels`, `addTaskLink`, and `removeTaskLink`.
- Produces pure `filterTasks(tasks, filters, context)`, `projectMetrics(projectSnapshot, today)`, `tasksForColumn(snapshot, columnId)`, and `backlogTasks(snapshot)`.

- [ ] **Step 1: Write failing pure-model tests**

```js
test("combines filter groups with AND and labels within a group with OR", () => {
  const result = filterTasks(tasks, { query: "发布", priorities: ["high"], labelIds: ["label-a", "label-b"] }, context);
  assert.deepEqual(result.map((task) => task.id), ["task-matching-all-groups"]);
});
```

Cover normalized Chinese keyword matching, archived exclusion, overdue dates, completion by `column.isFinal`, continuous position sorting, and Backlog selection.

- [ ] **Step 2: Run model tests and verify RED**

Run: `node --test tests/project-model.test.mjs`

Expected: FAIL because the model module does not exist.

- [ ] **Step 3: Implement pure project projections**

Do not mutate API objects. Accept `today` explicitly for date-sensitive functions. Use `Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" })` only as a stable secondary sort after `position`.

- [ ] **Step 4: Run model tests and verify GREEN**

Run: `node --test tests/project-model.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing API client tests and implement wrappers**

Stub `globalThis.fetch` and assert exact method, JSON body, and path for create, update, move, label, and link operations. Export the existing request helper so project calls share timeout and normalized errors.

- [ ] **Step 6: Run client tests and commit**

Run: `node --test tests/project-model.test.mjs tests/project-api-client.test.mjs`

```bash
git add Workbench/src/lib/api.js Workbench/src/lib/project-api.js Workbench/src/lib/project-model.js Workbench/tests/project-model.test.mjs Workbench/tests/project-api-client.test.mjs
git commit -m "feat: add project client model"
```

### Task 4: Navigation and Project Overview

**Files:**
- Create: `Workbench/src/pages/ProjectsPage.jsx`
- Create: `Workbench/src/components/projects/ProjectCard.jsx`
- Create: `Workbench/src/components/projects/projects.css`
- Create: `Workbench/tests/projects-ui.test.mjs`
- Modify: `Workbench/src/App.jsx`
- Modify: `Workbench/src/components/AppShell.jsx`

**Interfaces:**
- Consumes: `loadProjects`, `createProject`, and `projectMetrics`.
- Produces: local-only `/projects` route and project links to `/projects/:projectId`.

- [ ] **Step 1: Write failing UI information-gate tests**

Following existing source-level UI tests, assert that `AppShell.jsx` includes the Projects navigation only under `localWorkbench`, `App.jsx` registers both project routes only locally, and hosted builds cannot render the page.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/projects-ui.test.mjs`

Expected: FAIL because project navigation and pages are absent.

- [ ] **Step 3: Implement the project overview**

Show loading, empty, populated, and error states. The empty state creates a project through a dialog with required `name` and `key`. Each card shows completion, active task count, overdue count, and latest activity. Do not create sample data automatically.

- [ ] **Step 4: Add responsive styles using existing design tokens**

Keep styles scoped below `.projects-page`. At widths below 720px, use a one-column card layout and full-width dialog actions. Preserve visible focus rings and 44px minimum interactive targets.

- [ ] **Step 5: Run UI tests and build**

Run: `node --test tests/projects-ui.test.mjs && npm run build`

Expected: PASS and Vite build completes.

- [ ] **Step 6: Commit**

```bash
git add Workbench/src/App.jsx Workbench/src/components/AppShell.jsx Workbench/src/pages/ProjectsPage.jsx Workbench/src/components/projects Workbench/tests/projects-ui.test.mjs
git commit -m "feat: add project overview"
```

### Task 5: Board, List, Backlog, Filters, and Task Drawer

**Files:**
- Create: `Workbench/src/pages/ProjectPage.jsx`
- Create: `Workbench/src/components/projects/ProjectToolbar.jsx`
- Create: `Workbench/src/components/projects/ProjectBoard.jsx`
- Create: `Workbench/src/components/projects/ProjectList.jsx`
- Create: `Workbench/src/components/projects/ProjectBacklog.jsx`
- Create: `Workbench/src/components/projects/TaskCard.jsx`
- Create: `Workbench/src/components/projects/TaskDrawer.jsx`
- Create: `Workbench/src/components/projects/MoveTaskMenu.jsx`
- Modify: `Workbench/src/components/projects/projects.css`
- Modify: `Workbench/package.json`
- Modify: `Workbench/package-lock.json`
- Modify: `Workbench/tests/projects-ui.test.mjs`

**Interfaces:**
- Consumes: Task 3 API and model functions plus `onOpenDocument` supplied by `App`.
- Produces: complete `/projects/:projectId` experience and accessible task movement.

- [ ] **Step 1: Write failing tests for view state and task editing**

Assert route source includes Board/List/Backlog controls, view preference key `workbench-project-view`, shared filters, create task, TaskDrawer fields, save errors, archive action, and mobile move menu. Add pure tests for the reducer that applies server-confirmed responses and restores the previous snapshot after failed moves.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/projects-ui.test.mjs tests/project-model.test.mjs`

Expected: FAIL for missing project view modules.

- [ ] **Step 3: Install only the approved drag dependencies**

Run: `npm install @dnd-kit/core@^6.3.1 @dnd-kit/sortable@^10.0.0`

Expected: package and lock file contain only these new direct dependencies.

- [ ] **Step 4: Implement ProjectPage state and three projections**

Load one project snapshot, store filters and selected task locally, persist only the view name to localStorage, and pass immutable projections into each view. Backlog calls `moveTask` with `columnId: null`; Board uses actual column IDs.

- [ ] **Step 5: Implement accessible movement and rollback**

Use pointer and keyboard sensors. During drag, keep the previous snapshot; call one `moveTask({ taskId, columnId, index, revision })`; replace with the server snapshot on success and restore on failure. Always expose the same movement through `MoveTaskMenu`.

- [ ] **Step 6: Implement TaskDrawer**

Use controlled fields and explicit Save. Keep dirty input after a failed save. Validate title and date ordering before request. Labels use checkboxes. Archive requires a confirmation dialog.

- [ ] **Step 7: Run focused tests and build**

Run: `node --test tests/projects-ui.test.mjs tests/project-model.test.mjs tests/project-api-client.test.mjs && npm run build`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add Workbench/package.json Workbench/package-lock.json Workbench/src/pages/ProjectPage.jsx Workbench/src/components/projects Workbench/tests/projects-ui.test.mjs Workbench/tests/project-model.test.mjs
git commit -m "feat: add project planning views"
```

### Task 6: Vault Links, Activity, Documentation, and Release Gate

**Files:**
- Modify: `Workbench/src/components/projects/TaskDrawer.jsx`
- Create: `Workbench/src/components/projects/TaskActivity.jsx`
- Modify: `Workbench/src/components/projects/projects.css`
- Modify: `Workbench/src/App.jsx`
- Modify: `Workbench/tests/projects-ui.test.mjs`
- Modify: `Workbench/tests/project-api.test.mjs`
- Modify: `Workbench/README.md`

**Interfaces:**
- Consumes: existing `searchVault(query)` and `App.openDocument`, plus project link endpoints.
- Produces: searchable Vault links, stale-link presentation, and activity timeline.

- [ ] **Step 1: Write failing tests for safe Vault links and activity projection**

API tests must reject absolute paths, traversal, unknown documents, and cross-Vault identifiers. UI tests must assert search uses existing Vault search, selecting a result calls `addTaskLink`, valid links call `onOpenDocument`, and stale links show “文档已移动或删除” with Remove but no Open action.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/project-api.test.mjs tests/projects-ui.test.mjs`

Expected: FAIL for missing link UI and activity presentation.

- [ ] **Step 3: Implement document linking and activity timeline**

Debounce search by 250ms, cap results at 20, and cancel stale requests. Render activities newest first with explicit Chinese descriptions derived from `activity.type`; never render raw JSON or full document contents.

- [ ] **Step 4: Document local storage and privacy behavior**

Add a README section describing the local-only feature, app-data location, external Vault links, hosted/read-only behavior, and that no real project data belongs in the repository.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/project-repository.test.mjs tests/project-api.test.mjs tests/project-model.test.mjs tests/project-api-client.test.mjs tests/projects-ui.test.mjs`

Expected: PASS.

- [ ] **Step 6: Run full release gate**

Run sequentially from `Workbench`:

```bash
npm test
npm run build
npm run privacy:scan
```

Expected: all commands exit 0 with no privacy findings.

- [ ] **Step 7: Commit**

```bash
git add Workbench/src Workbench/server Workbench/tests Workbench/README.md Workbench/package.json Workbench/package-lock.json
git commit -m "feat: connect projects to vault knowledge"
```

- [ ] **Step 8: Review the final branch**

Inspect `git diff HEAD~6..HEAD`, confirm no real project data or local absolute path was added, and run `git status --short` to verify the tree is clean.
