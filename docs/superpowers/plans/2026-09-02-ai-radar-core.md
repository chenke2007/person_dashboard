# AI Radar Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a portable local GitHub AI radar with daily snapshots, honest day/week/month deltas, three explainable lists, in-process scheduling, preference feedback, and dashboard UI.

**Architecture:** A `RadarRepository` owns versioned durable state. A GitHub adapter handles official REST concerns, a pure ranking module derives lists, and a scheduler invokes one idempotent collection command through injected clock/timer seams. Local HTTP routes expose snapshots and commands; hosted builds remain read-only and hide the feature.

**Tech Stack:** Node.js ESM, React 19, Vite 6, Zod 3, Node test runner, GitHub REST API.

**Spec:** `docs/superpowers/specs/2026-09-02-ai-radar-learning-loop-design.md`

## Global Constraints

- Execute the reliability foundation plan first.
- Use only GitHub official REST endpoints in this increment; do not scrape Trending.
- Default focus areas are Agent, AI coding, RAG/personal knowledge, and AI productivity applications.
- Show 8 daily, 12 weekly, and 20 monthly items.
- Keep rising, established, and relevant as separate lists; never present an opaque combined score.
- Scheduler runs only while Workbench runs, catches up on startup, and supports manual collection.
- Snapshot gaps remain explicit and missing baselines produce “数据积累中”.
- Keep 400 days of daily snapshots, then monthly aggregates; preserve complete history for saved/learning repositories.
- Every production behavior starts with a failing test and uses synthetic GitHub fixtures.

---

### Task 1: Radar schema and durable repository

**Files:**
- Create: `Workbench/server/ai-radar/radar-schema.mjs`
- Create: `Workbench/server/ai-radar/radar-repository.mjs`
- Create: `Workbench/tests/radar-repository.test.mjs`
- Modify: `Workbench/server/vite-plugin-workbench.mjs`

**Interfaces:**
- Consumes: stable workspace state root and backup-provider interface from the reliability plan.
- Produces: `createRadarRepository({ directory, now })` with repository, snapshot, run, decision, preference, schedule, and retention methods.

- [ ] **Step 1: Write failing repository tests**

```js
test("upserts repositories and keeps one latest snapshot per local date", async (t) => {
  const radar = createRadarRepository({ directory: await makeStore(t), now: fixedClock() });
  await radar.upsertRepositories([syntheticRepository({ id: 101, stars: 100 })]);
  await radar.recordSnapshots([syntheticSnapshot({ repositoryId: 101, stars: 100 })], "2026-09-02T00:00:00.000Z", "Asia/Shanghai");
  await radar.recordSnapshots([syntheticSnapshot({ repositoryId: 101, stars: 105 })], "2026-09-02T06:00:00.000Z", "Asia/Shanghai");
  const state = await radar.getState();
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.snapshots[0].stars, 105);
  assert.equal(state.snapshots[0].capturedDate, "2026-09-02");
});
```

Add cases for strict schema, unknown version, corrupt store preservation, concurrent writes, run records, decisions, reversible preferences, schedule state, symlink/junction escape, and size limits.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/radar-repository.test.mjs`
Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement v1 schema and atomic repository**

```js
export function createRadarRepository({ directory, now = () => new Date() }) {
  return {
    getState,
    upsertRepositories,
    recordSnapshots,
    recordRun,
    setDecision,
    addPreference,
    revertPreference,
    resetPreferences,
    getSchedule,
    updateSchedule,
    applyRetention,
    exportState,
    validateImport,
    replaceState,
  };
}
```

Use the same validated, serialized, temp-file-plus-atomic-replace pattern as the project repository. Store `radar.json` under the stable workspace state root.

- [ ] **Step 4: Register the radar backup provider**

Add provider ID `ai-radar`, schema version `1`, and ensure exported state contains no Token, README body, request headers, or absolute path.

- [ ] **Step 5: Verify repository tests**

Run: `cd Workbench && node --test tests/radar-repository.test.mjs tests/workspace-backup.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Workbench/server/ai-radar Workbench/server/vite-plugin-workbench.mjs Workbench/tests/radar-repository.test.mjs Workbench/tests/workspace-backup.test.mjs
git commit -m "feat: add durable AI radar state"
```

### Task 2: Official GitHub discovery adapter

**Files:**
- Create: `Workbench/server/ai-radar/github-client.mjs`
- Create: `Workbench/server/ai-radar/github-errors.mjs`
- Create: `Workbench/tests/github-radar-client.test.mjs`
- Modify: `Workbench/.env.example`

**Interfaces:**
- Consumes: `fetchImpl`, optional `WORKBENCH_GITHUB_TOKEN`, focus-area query definitions, and cached ETags.
- Produces: `createGitHubRadarClient({ fetchImpl, token, userAgent })` with `discoverCandidates()`, `getRepositories()`, `getReadme()`, and `getHeadCommit()`.

- [ ] **Step 1: Write failing adapter tests with synthetic responses**

```js
test("discovers candidates without leaking the token", async () => {
  const calls = [];
  const client = createGitHubRadarClient({
    token: "test-token-not-a-real-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return githubJson({ items: [syntheticGithubRepository()] });
    },
  });
  const result = await client.discoverCandidates({ focusAreas: ["agent", "ai-coding"] });
  assert.equal(result.repositories.length, 1);
  assert.equal(JSON.stringify(result).includes("test-token"), false);
});
```

Add pagination, 304 ETag, 403 primary limit, 429/secondary limit, `Retry-After`, partial details failure, archived/fork filtering, invalid payload, and sanitized error cases.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/github-radar-client.test.mjs`
Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement the client**

```js
export function createGitHubRadarClient({ fetchImpl = fetch, token = null, userAgent = "personal-ai-workbench" } = {}) {
  return { discoverCandidates, getRepositories, getReadme, getHeadCommit };
}
```

Use `Accept: application/vnd.github+json`, an explicit API version, serial requests, bounded pages, and normalized repository records. Do not expose authorization headers through return values or errors.

- [ ] **Step 4: Add local configuration documentation**

Add commented `WORKBENCH_GITHUB_TOKEN=` to `.env.example`, explicitly stating it is optional, read-only, ignored locally, and excluded from backup.

- [ ] **Step 5: Verify tests**

Run: `cd Workbench && node --test tests/github-radar-client.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Workbench/server/ai-radar/github-*.mjs Workbench/tests/github-radar-client.test.mjs Workbench/.env.example
git commit -m "feat: collect AI repositories from GitHub"
```

### Task 3: Honest trend projection and three ranking lists

**Files:**
- Create: `Workbench/shared/ai-radar-ranking.mjs`
- Create: `Workbench/tests/ai-radar-ranking.test.mjs`

**Interfaces:**
- Consumes: repositories, snapshots, period (`day | week | month`), preference signals, and optional structured relevance results.
- Produces: `rankRadar({ repositories, snapshots, period, preferences, relevance, now })` returning `{ rising, established, relevant }` with coverage and reasons.

- [ ] **Step 1: Write failing ranking tests**

```js
test("does not manufacture a delta when a baseline is missing", () => {
  const ranked = rankRadar({
    repositories: [syntheticRepo(1)],
    snapshots: [snapshot(1, "2026-09-02", 120)],
    period: "week",
    preferences: [],
    relevance: [],
    now: new Date("2026-09-02T08:00:00Z"),
  });
  assert.equal(ranked.rising[0].observedStarDelta, null);
  assert.equal(ranked.rising[0].status, "collecting");
});
```

Add exact 1/7/30-day baseline, nearest earlier snapshot, 5/7 coverage, missing days, established ranking, deterministic topic relevance, archived demotion, saved-history retention marker, and reversible `lessLike` tests.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/ai-radar-ranking.test.mjs`
Expected: FAIL because ranking module is absent.

- [ ] **Step 3: Implement pure ranking functions**

```js
export function observedDelta(snapshots, repositoryId, targetDays, now) { /* null when no honest baseline */ }
export function rankRising(input) { /* observed delta, then current stars, then stable id */ }
export function rankEstablished(input) { /* current stars plus maintenance/archived rules */ }
export function rankRelevant(input) { /* rules, optional model relevance, preferences */ }
export function rankRadar(input) { return { rising: rankRising(input), established: rankEstablished(input), relevant: rankRelevant(input) }; }
```

Return separate reason arrays; do not expose one combined score in the output contract.

- [ ] **Step 4: Verify tests**

Run: `cd Workbench && node --test tests/ai-radar-ranking.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Workbench/shared/ai-radar-ranking.mjs Workbench/tests/ai-radar-ranking.test.mjs
git commit -m "feat: rank AI radar trends honestly"
```

### Task 4: Idempotent collection command and retention

**Files:**
- Create: `Workbench/server/ai-radar/radar-collector.mjs`
- Create: `Workbench/tests/radar-collector.test.mjs`
- Modify: `Workbench/server/ai-radar/radar-repository.mjs`

**Interfaces:**
- Consumes: GitHub client, radar repository, ranking module, injected clock, and configured focus areas.
- Produces: `createRadarCollector(...).collect({ trigger })` returning a safe run result.

- [ ] **Step 1: Write failing collector tests**

Assert one invocation discovers candidates, records repository metadata and snapshots, derives lists, records a successful run, and applies retention. Assert a second same-day invocation upserts rather than duplicates. Assert partial repository failures preserve successful snapshots and a total failure preserves the previous dashboard.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/radar-collector.test.mjs`
Expected: FAIL because the collector is absent.

- [ ] **Step 3: Implement the command**

```js
export function createRadarCollector({ github, repository, rank = rankRadar, now = () => new Date(), timeZone }) {
  return { collect };
}
```

The command must serialize overlapping runs, use `trigger: schedule | startup | manual`, sanitize failures, and mark a local date successful only after snapshots and run metadata are durable.

- [ ] **Step 4: Verify tests**

Run: `cd Workbench && node --test tests/radar-collector.test.mjs tests/radar-repository.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Workbench/server/ai-radar/radar-collector.mjs Workbench/server/ai-radar/radar-repository.mjs Workbench/tests/radar-collector.test.mjs Workbench/tests/radar-repository.test.mjs
git commit -m "feat: collect and retain AI radar snapshots"
```

### Task 5: In-process daily scheduler

**Files:**
- Create: `Workbench/server/ai-radar/radar-scheduler.mjs`
- Create: `Workbench/tests/radar-scheduler.test.mjs`
- Modify: `Workbench/server/vite-plugin-workbench.mjs`

**Interfaces:**
- Consumes: `collector.collect`, radar schedule persistence, injected clock, `setTimeoutImpl`, and `clearTimeoutImpl`.
- Produces: `createRadarScheduler({ collect, store, now, setTimeoutImpl, clearTimeoutImpl })` with `start()`, `stop()`, `runDue()`, `runNow()`, and `getStatus()`.

- [ ] **Step 1: Write failing clock-driven tests**

```js
test("catches up once on startup and exposes the next run", async () => {
  const calls = [];
  const scheduler = createRadarScheduler({ collect: async (input) => calls.push(input), store, now: fixedNow("2026-09-02T09:00:00+08:00"), setTimeoutImpl: fakeSetTimeout });
  await scheduler.start();
  assert.deepEqual(calls, [{ trigger: "startup" }]);
  assert.equal((await scheduler.getStatus()).nextRunAt, "2026-09-03T08:00:00+08:00");
});
```

Add disabled schedule, before-time startup, failed-run retry, manual run, timezone, concurrent trigger, and stop cleanup tests.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/radar-scheduler.test.mjs`
Expected: FAIL because the scheduler is absent.

- [ ] **Step 3: Implement the scheduler**

Keep scheduling generic only for this one daily job; do not parse Cron expressions. Recompute the next delay after every run and on settings changes. Cap long timer delays and recheck the clock rather than assuming one timer survives indefinitely.

- [ ] **Step 4: Start and stop with the Vite server lifecycle**

Create radar dependencies during plugin setup, call `scheduler.start()` only in local mutable mode, and call `scheduler.stop()` from server close. Hosted builds and read-only project/radar mode must not collect.

- [ ] **Step 5: Verify tests**

Run: `cd Workbench && node --test tests/radar-scheduler.test.mjs tests/radar-collector.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Workbench/server/ai-radar/radar-scheduler.mjs Workbench/server/vite-plugin-workbench.mjs Workbench/tests/radar-scheduler.test.mjs
git commit -m "feat: schedule local AI radar collection"
```

### Task 6: Radar HTTP routes and client model

**Files:**
- Create: `Workbench/server/ai-radar/radar-routes.mjs`
- Create: `Workbench/src/lib/ai-radar-api.js`
- Create: `Workbench/src/lib/ai-radar-model.js`
- Create: `Workbench/tests/ai-radar-api.test.mjs`
- Create: `Workbench/tests/ai-radar-model.test.mjs`
- Modify: `Workbench/server/vite-plugin-workbench.mjs`

**Interfaces:**
- Consumes: repository dashboard queries, scheduler status/commands, decisions, and preferences.
- Produces: `/api/ai-radar` read endpoints and local mutation commands plus browser client functions.

- [ ] **Step 1: Write failing route tests**

Cover:

- `GET /api/ai-radar?period=day`
- `GET /api/ai-radar/status`
- `POST /api/ai-radar/collect`
- `PATCH /api/ai-radar/schedule`
- `PUT /api/ai-radar/repositories/:id/decision`
- `POST /api/ai-radar/preferences`
- `POST /api/ai-radar/preferences/:id/revert`
- `DELETE /api/ai-radar/preferences`

Assert hosted/read-only mutations fail, invalid periods/actions fail, JSON and same-origin protections remain active, and safe errors contain no GitHub response headers.

- [ ] **Step 2: Run route tests and verify RED**

Run: `cd Workbench && node --test tests/ai-radar-api.test.mjs`
Expected: FAIL because routes are absent.

- [ ] **Step 3: Implement routes and plugin delegation**

Use a focused `createRadarRoutes({ repository, scheduler, readOnly })` matching only `/api/ai-radar`. Keep request parsing and public errors inside the route module.

- [ ] **Step 4: Write and implement client-model tests**

```js
export function projectRadarDashboard(payload, { period, list, state, focus }) { /* pure filters and stable card projection */ }
```

Test exact request methods/bodies and 8/12/20 view limits without mutating server order.

- [ ] **Step 5: Verify route and model tests**

Run: `cd Workbench && node --test tests/ai-radar-api.test.mjs tests/ai-radar-model.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Workbench/server/ai-radar/radar-routes.mjs Workbench/server/vite-plugin-workbench.mjs Workbench/src/lib/ai-radar-*.js Workbench/tests/ai-radar-*.test.mjs
git commit -m "feat: expose local AI radar commands"
```

### Task 7: AI radar page and navigation

**Files:**
- Create: `Workbench/src/pages/AiRadarPage.jsx`
- Create: `Workbench/src/components/ai-radar/AiRadarCard.jsx`
- Create: `Workbench/src/components/ai-radar/AiRadarFilters.jsx`
- Create: `Workbench/src/components/ai-radar/AiRadarStatus.jsx`
- Create: `Workbench/src/components/ai-radar/ai-radar.css`
- Modify: `Workbench/src/App.jsx`
- Modify: `Workbench/src/components/AppShell.jsx`
- Create: `Workbench/tests/ai-radar-ui.test.mjs`

**Interfaces:**
- Consumes: `loadRadar`, `collectRadar`, `updateRadarSchedule`, decision, and preference client functions.
- Produces: local-only `/ai-radar` UI with period/list/status/focus filters, schedule controls, and card actions.

- [ ] **Step 1: Write failing UI contract tests**

Assert the local route and navigation exist while hosted builds omit them. Assert three list labels, three periods, “本地观测”, coverage state, “立即采集”, “减少类似推荐”, preference undo/reset, schedule enable/time/timezone controls, visible next-run time, and disabled mutation controls in read-only mode.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/ai-radar-ui.test.mjs`
Expected: FAIL because UI files and route are absent.

- [ ] **Step 3: Implement accessible page composition**

Use buttons/tabs with explicit selected state, semantic card actions, visible loading/error/stale states, and compact responsive cards. Add a settings panel for schedule enablement, local run time, IANA timezone, next-run display, and manual collection. Do not place every action behind hover. Keep filters in URL search params so reload preserves the current view.

- [ ] **Step 4: Verify UI test and production build**

Run: `cd Workbench && node --test tests/ai-radar-ui.test.mjs && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Workbench/src/pages/AiRadarPage.jsx Workbench/src/components/ai-radar Workbench/src/App.jsx Workbench/src/components/AppShell.jsx Workbench/tests/ai-radar-ui.test.mjs
git commit -m "feat: add AI radar workspace"
```

### Task 8: Overview daily picks and release gate

**Files:**
- Create: `Workbench/src/components/ai-radar/AiRadarOverview.jsx`
- Modify: `Workbench/src/pages/OverviewPage.jsx`
- Modify: `Workbench/tests/ai-radar-ui.test.mjs`
- Modify: `Workbench/tests/public-boundaries.test.mjs`

**Interfaces:**
- Consumes: day/relevant radar dashboard and status.
- Produces: exactly three overview picks, unread count, stale/failure copy, and link to `/ai-radar`.

- [ ] **Step 1: Write failing overview tests**

Assert exactly three synthetic picks render, empty state does not invent data, collection failure preserves old picks with stale time, and hosted build has no local radar entry or mutation endpoint.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/ai-radar-ui.test.mjs tests/public-boundaries.test.mjs`
Expected: FAIL because overview integration is absent.

- [ ] **Step 3: Implement the overview projection**

Load radar independently from existing overview/graph payloads so a GitHub failure cannot block the main dashboard. Render three cards only when local radar data exists.

- [ ] **Step 4: Run focused radar suite**

Run: `cd Workbench && node --test --test-concurrency=1 tests/github-radar-client.test.mjs tests/radar-*.test.mjs tests/ai-radar-*.test.mjs tests/public-boundaries.test.mjs tests/workspace-backup.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run full release gate**

Run: `cd Workbench && npm test && npm run build && npm run privacy:scan`
Expected: all commands exit 0 and no real repository history, local path, Token, README cache, or generated radar state appears in Git.

- [ ] **Step 6: Commit**

```bash
git add Workbench/src/components/ai-radar/AiRadarOverview.jsx Workbench/src/pages/OverviewPage.jsx Workbench/tests/ai-radar-ui.test.mjs Workbench/tests/public-boundaries.test.mjs
git commit -m "feat: surface daily AI radar picks"
```
