# Repository Summary and Learning Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional AI relevance and summaries, then let users create fixed-version, per-repository learning workspaces with reviewable missions and a three-active-project limit.

**Architecture:** Reuse the existing model transport through a provider-neutral adapter, but keep radar usable without it. Summary generation accepts only normalized metadata and bounded README text. A separate `LearningWorkspaceRepository` owns workspace state and files outside the Vault; joining learning fixes the source commit and creates a draft mission that must be confirmed.

**Tech Stack:** Node.js ESM, React 19, Vite 6, Zod 3, Node test runner, existing Anthropic-compatible knowledge model transport.

**Spec:** `docs/superpowers/specs/2026-09-02-ai-radar-learning-loop-design.md`

## Global Constraints

- Execute reliability foundation and AI radar core plans first.
- Basic radar collection and deterministic ranking remain functional without a model.
- Never send GitHub Token, model credential, Vault content, project state, local path, or unrelated repository data to the model.
- README and repository content are untrusted evidence, never instructions.
- Summary stage reads metadata and bounded README only; it does not clone or execute the repository.
- Joining learning fixes a commit SHA and creates a draft mission; it does not write to Wiki.
- Keep at most 3 active learning workspaces; queued workspaces are unlimited within repository capacity limits.
- Each repository gets an independent workspace.
- Every production behavior starts with a failing test and synthetic sources.

---

### Task 1: Provider-neutral structured model adapter

**Files:**
- Create: `Workbench/server/models/structured-model.mjs`
- Create: `Workbench/tests/structured-model.test.mjs`
- Modify: `Workbench/server/knowledge-chat/model.mjs`

**Interfaces:**
- Consumes: existing model config and transport.
- Produces: `createStructuredModel({ complete })` with `generate({ system, prompt, schema, timeoutMs })`; `loadOptionalModel({ env })` returns `{ available, model, reason }`.

- [ ] **Step 1: Write failing optional-model tests**

```js
test("returns an explicit unavailable result without configured credentials", async () => {
  const result = await loadOptionalModel({ env: {} });
  assert.deepEqual(result, { available: false, model: null, reason: "MODEL_NOT_CONFIGURED" });
});

test("validates structured output before returning it", async () => {
  const model = createStructuredModel({ complete: async () => '{"direction":"agent","reason":"Synthetic reason"}' });
  const value = await model.generate({ system: "Classify", prompt: "Synthetic evidence", schema: classificationSchema });
  assert.equal(value.direction, "agent");
});
```

Also test invalid JSON, schema mismatch, timeout, repair-at-most-once, and credential-free public errors.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/structured-model.test.mjs`
Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Extract transport reuse without changing knowledge assistant behavior**

Keep `createModelClient()` compatible. Add the adapter above it rather than making radar import knowledge-service internals. Do not introduce provider-specific fields into radar or learning schemas.

- [ ] **Step 4: Verify model and existing knowledge tests**

Run: `cd Workbench && node --test tests/structured-model.test.mjs tests/knowledge-model.test.mjs tests/knowledge-service.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Workbench/server/models/structured-model.mjs Workbench/server/knowledge-chat/model.mjs Workbench/tests/structured-model.test.mjs Workbench/tests/knowledge-model.test.mjs
git commit -m "refactor: expose optional structured model interface"
```

### Task 2: Explainable AI relevance classification

**Files:**
- Create: `Workbench/server/ai-radar/radar-relevance.mjs`
- Create: `Workbench/tests/radar-relevance.test.mjs`
- Modify: `Workbench/server/ai-radar/radar-collector.mjs`
- Modify: `Workbench/shared/ai-radar-ranking.mjs`

**Interfaces:**
- Consumes: a bounded list of rule-filtered candidate metadata and optional structured model.
- Produces: `classifyRelevance({ repositories, model })` returning repository ID, direction, relevance (`high | medium | low`), and visible reason.

- [ ] **Step 1: Write failing relevance tests**

```js
test("uses deterministic focus rules when no model is available", async () => {
  const result = await classifyRelevance({ repositories: [syntheticAgentRepo()], model: null });
  assert.deepEqual(result[0], { repositoryId: 101, direction: "agent", relevance: "medium", reasonCode: "TOPIC_MATCH", reason: "匹配 Agent 关注方向" });
});
```

Add tests that only rule-filtered candidates reach the model, malformed output falls back per item, reasons have length limits, and README/body/credentials are absent from prompts.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/radar-relevance.test.mjs`
Expected: FAIL because the classifier is absent.

- [ ] **Step 3: Implement rule-first classification**

Use repository name, description, topics, language, archived flag, and deterministic focus mappings. Send only a capped candidate batch to the model. Persist structured results with model/workflow version and generated time.

- [ ] **Step 4: Feed relevance into the separate relevant list**

Do not change rising or established list semantics. Preference signals remain explicit inputs and reasons remain visible.

- [ ] **Step 5: Verify tests**

Run: `cd Workbench && node --test tests/radar-relevance.test.mjs tests/ai-radar-ranking.test.mjs tests/radar-collector.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Workbench/server/ai-radar/radar-relevance.mjs Workbench/server/ai-radar/radar-collector.mjs Workbench/shared/ai-radar-ranking.mjs Workbench/tests/radar-relevance.test.mjs Workbench/tests/ai-radar-ranking.test.mjs Workbench/tests/radar-collector.test.mjs
git commit -m "feat: explain AI radar relevance"
```

### Task 3: Source-bound repository summaries

**Files:**
- Create: `Workbench/server/ai-radar/repository-summary.mjs`
- Create: `Workbench/server/ai-radar/summary-schema.mjs`
- Create: `Workbench/tests/repository-summary.test.mjs`
- Modify: `Workbench/server/ai-radar/radar-schema.mjs`
- Modify: `Workbench/server/ai-radar/radar-repository.mjs`

**Interfaces:**
- Consumes: normalized repository metadata, bounded README response, HEAD commit, optional structured model, and radar repository.
- Produces: `createRepositorySummaryService(...).generate(repositoryId)` and persisted structured summary with sources and commit SHA.

- [ ] **Step 1: Write failing summary tests**

```js
test("binds a summary to repository URL, commit, and README source", async () => {
  const summary = await service.generate(101);
  assert.equal(summary.repositoryId, 101);
  assert.equal(summary.sourceCommitSha, "a".repeat(40));
  assert.deepEqual(summary.sources, [{ kind: "readme", path: "README.md", commitSha: "a".repeat(40) }]);
});
```

Add model-not-configured, missing README, oversized README truncation, prompt-injection text treated as quoted evidence, stale HEAD, invalid output, and no-secret tests.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/repository-summary.test.mjs`
Expected: FAIL because summary service is absent.

- [ ] **Step 3: Define the summary schema**

```js
const summaryContentSchema = z.object({
  problem: z.string().min(1).max(1200),
  whyNow: z.string().min(1).max(1200),
  relevance: z.string().min(1).max(1200),
  stack: z.array(z.string().max(80)).max(20),
  maintenance: z.string().max(600),
  license: z.string().max(120).nullable(),
  recommendation: z.enum(["learn", "watch", "skip"]),
  cautions: z.array(z.string().max(300)).max(12),
}).strict();
```

- [ ] **Step 4: Implement generation and persistence**

Fetch metadata, HEAD and README on demand; quote evidence inside clear delimiters; reject tool calls or instruction expansion; save only validated structured content and source references. One repository may keep the latest summary plus bounded history.

- [ ] **Step 5: Verify tests**

Run: `cd Workbench && node --test tests/repository-summary.test.mjs tests/radar-repository.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Workbench/server/ai-radar/repository-summary.mjs Workbench/server/ai-radar/summary-schema.mjs Workbench/server/ai-radar/radar-*.mjs Workbench/tests/repository-summary.test.mjs Workbench/tests/radar-repository.test.mjs
git commit -m "feat: generate source-bound repository summaries"
```

### Task 4: Learning workspace schema and repository

**Files:**
- Create: `Workbench/server/learning/learning-schema.mjs`
- Create: `Workbench/server/learning/learning-repository.mjs`
- Create: `Workbench/tests/learning-repository.test.mjs`
- Modify: `Workbench/server/vite-plugin-workbench.mjs`

**Interfaces:**
- Consumes: stable workspace state root, repository ID/full name, source URL, fixed commit SHA, and mission draft.
- Produces: `createLearningRepository({ directory, now, makeId })` with draft, confirm, queue, activate, archive, and backup-provider methods.

- [ ] **Step 1: Write failing repository tests**

```js
test("creates one independent draft workspace per repository", async (t) => {
  const learning = createLearningRepository({ directory: await makeStore(t), now: fixedClock(), makeId: sequenceIds() });
  const draft = await learning.createDraft({ repositoryId: 101, fullName: "synthetic/example", sourceUrl: "https://github.com/synthetic/example", sourceCommitSha: "a".repeat(40), mission: syntheticMission() });
  assert.equal(draft.state, "draft");
  assert.match(draft.workspaceRelativePath, /^[0-9a-f-]+$/);
  assert.equal(path.isAbsolute(draft.workspaceRelativePath), false);
});
```

Add unique repository workspace, exactly 40-hex commit, draft confirmation token, revision drift, three-active limit, queue ordering, archive, corrupt workspace, atomic writes, symlink escape, and no Vault write tests.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/learning-repository.test.mjs`
Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement v1 workspace files**

For the first release create:

```text
workspace.json
MISSION.md
RESOURCES.md
NOTES.md
reference/
lessons/
learning-records/
assets/
```

`MISSION.md` is generated from structured mission data; it contains no absolute path or credential. Directories for future artifacts are empty and ignored by the public repository because runtime workspaces live under local application state.

- [ ] **Step 4: Enforce state transitions**

```js
draft -> queued | active
queued -> active | archived
active -> review | archived
review -> completed | active
completed -> archived
```

Only `active` counts toward the limit of 3. Confirming a fourth draft queues it rather than failing silently.

- [ ] **Step 5: Register backup provider**

Export workspace metadata and authored learning files, but exclude cloned repository cache, credentials, transient model checkpoints, and absolute paths.

- [ ] **Step 6: Verify tests**

Run: `cd Workbench && node --test tests/learning-repository.test.mjs tests/workspace-backup.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Workbench/server/learning Workbench/server/vite-plugin-workbench.mjs Workbench/tests/learning-repository.test.mjs Workbench/tests/workspace-backup.test.mjs
git commit -m "feat: add repository learning workspaces"
```

### Task 5: Join-learning orchestration and routes

**Files:**
- Create: `Workbench/server/learning/learning-service.mjs`
- Create: `Workbench/server/learning/learning-routes.mjs`
- Create: `Workbench/tests/learning-api.test.mjs`
- Modify: `Workbench/server/ai-radar/radar-routes.mjs`
- Modify: `Workbench/server/vite-plugin-workbench.mjs`

**Interfaces:**
- Consumes: GitHub `getHeadCommit`, latest repository summary, learning repository, and radar decision state.
- Produces: mission preview/confirm, workspace list/read/archive, and synchronized radar learning states.

- [ ] **Step 1: Write failing orchestration tests**

Cover:

- `POST /api/ai-radar/repositories/:id/summary`
- `POST /api/learning/preview`
- `POST /api/learning/confirm`
- `GET /api/learning`
- `GET /api/learning/:id`
- `POST /api/learning/:id/archive`

Assert preview fixes the current HEAD, confirm rejects changed preview inputs, the fourth confirmed workspace queues, hosted/read-only writes fail, and no route executes or clones repository code.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/learning-api.test.mjs`
Expected: FAIL because the service and routes are absent.

- [ ] **Step 3: Implement mission preview**

```js
export function createLearningService({ github, summaries, learning, radar, now }) {
  return { previewMission, confirmMission, listWorkspaces, getWorkspace, archiveWorkspace };
}
```

Mission goal must be one of `understand-architecture | learn-usage | analyze-design | reproduce-capability | adoption-decision`. The preview includes scope, expected outcome, source summary, fixed commit SHA, and a 30-minute-expiring confirmation token.

- [ ] **Step 4: Implement focused routes**

Keep summary action under radar and learning lifecycle under `/api/learning`. Reuse local same-origin and JSON protections. Update radar decision only after learning state is durable.

- [ ] **Step 5: Verify tests**

Run: `cd Workbench && node --test tests/learning-api.test.mjs tests/repository-summary.test.mjs tests/learning-repository.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Workbench/server/learning Workbench/server/ai-radar/radar-routes.mjs Workbench/server/vite-plugin-workbench.mjs Workbench/tests/learning-api.test.mjs
git commit -m "feat: create reviewable learning missions"
```

### Task 6: Summary and learning client model

**Files:**
- Create: `Workbench/src/lib/learning-api.js`
- Create: `Workbench/src/lib/learning-model.js`
- Create: `Workbench/tests/learning-model.test.mjs`
- Modify: `Workbench/src/lib/ai-radar-api.js`

**Interfaces:**
- Consumes: summary and learning HTTP routes.
- Produces: exact command clients and pure learning queue projections.

- [ ] **Step 1: Write failing client/model tests**

```js
test("projects no more than three active workspaces", () => {
  const projected = projectLearningQueue(syntheticLearningPayload());
  assert.equal(projected.active.length, 3);
  assert.equal(projected.queued.length, 1);
});
```

Assert exact request bodies, mission goal labels, source/commit visibility, archive projection, and no local path projection.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/learning-model.test.mjs`
Expected: FAIL because modules are absent.

- [ ] **Step 3: Implement client and pure model**

```js
export const previewLearningMission = (input) => command("/api/learning/preview", input);
export const confirmLearningMission = (token) => command("/api/learning/confirm", { token });
export function projectLearningQueue(payload) { /* active, queued, drafts, archived */ }
```

- [ ] **Step 4: Verify tests**

Run: `cd Workbench && node --test tests/learning-model.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Workbench/src/lib/learning-*.js Workbench/src/lib/ai-radar-api.js Workbench/tests/learning-model.test.mjs
git commit -m "feat: add learning workspace client model"
```

### Task 7: Summary and learning queue UI

**Files:**
- Create: `Workbench/src/components/ai-radar/RepositorySummaryDrawer.jsx`
- Create: `Workbench/src/components/learning/LearningMissionDialog.jsx`
- Create: `Workbench/src/components/learning/LearningQueue.jsx`
- Create: `Workbench/src/components/learning/learning.css`
- Modify: `Workbench/src/pages/AiRadarPage.jsx`
- Create: `Workbench/src/pages/LearningPage.jsx`
- Modify: `Workbench/src/App.jsx`
- Modify: `Workbench/src/components/AppShell.jsx`
- Create: `Workbench/tests/learning-ui.test.mjs`

**Interfaces:**
- Consumes: summary, mission preview/confirm, list/read/archive client functions.
- Produces: summary drawer, five-goal mission review, local `/learning` queue, source/version display, and active-limit feedback.

- [ ] **Step 1: Write failing UI contract tests**

Assert:

- Without a model, radar still renders and summary button explains configuration.
- Summary shows problem, why now, relevance, stack, maintenance, License, cautions, recommendation, URL, commit and source time.
- “加入学习” first opens a mission preview; it never immediately activates or writes Wiki.
- Mission dialog exposes exactly five goals and a confirmation step.
- Learning page separates active, queued, drafts and archived; active count never exceeds 3.
- Hosted builds omit learning routes and navigation.

- [ ] **Step 2: Run test and verify RED**

Run: `cd Workbench && node --test tests/learning-ui.test.mjs`
Expected: FAIL because UI files are absent.

- [ ] **Step 3: Implement summary drawer and mission dialog**

Keep fetched README out of the browser payload. Show only validated summary and explicit source metadata. If HEAD changes between summary and mission preview, display the newly fixed commit rather than silently claiming the old summary version is current.

- [ ] **Step 4: Implement learning queue page**

Use state-labelled sections and one clear next action per workspace. Archiving requires the existing user action but does not delete workspace files. Do not add lesson authoring or Wiki ingest controls in this increment.

- [ ] **Step 5: Verify UI and build**

Run: `cd Workbench && node --test tests/learning-ui.test.mjs tests/ai-radar-ui.test.mjs && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Workbench/src/components/ai-radar/RepositorySummaryDrawer.jsx Workbench/src/components/learning Workbench/src/pages/AiRadarPage.jsx Workbench/src/pages/LearningPage.jsx Workbench/src/App.jsx Workbench/src/components/AppShell.jsx Workbench/tests/learning-ui.test.mjs
git commit -m "feat: add repository learning entry"
```

### Task 8: First-release verification and documentation

**Files:**
- Modify: `Workbench/README.md`
- Modify: `README.md`
- Modify: `Workbench/tests/public-boundaries.test.mjs`
- Modify only other files required to correct verification failures.

**Interfaces:**
- Consumes: all tasks in the three implementation plans.
- Produces: documented, privacy-safe first release with no implied later-phase behavior.

- [ ] **Step 1: Document exact behavior and limits**

Document optional GitHub/model configuration, internal schedule semantics, manual collection, missing-history behavior, the three lists, retention, summary scope, three-active limit, and that lessons/Wiki ingest/code execution are later phases.

- [ ] **Step 2: Extend public-boundary tests**

Assert hosted builds expose no AI radar/learning navigation or local mutation routes, fixtures are synthetic, `.env` values are absent, runtime radar/learning data is ignored, and backup excludes credentials/cache/Vault bodies.

- [ ] **Step 3: Run focused first-release tests**

Run: `cd Workbench && node --test --test-concurrency=1 tests/structured-model.test.mjs tests/radar-*.test.mjs tests/github-radar-client.test.mjs tests/ai-radar-*.test.mjs tests/repository-summary.test.mjs tests/learning-*.test.mjs tests/workspace-*.test.mjs tests/public-boundaries.test.mjs`
Expected: PASS with zero failures.

- [ ] **Step 4: Run the complete release gate**

Run: `cd Workbench && npm test && npm run build && npm run privacy:scan`
Expected: all commands exit 0.

- [ ] **Step 5: Inspect tracked data**

Run: `git status --short && git diff --check && git grep -n -E "(github_pat_|ghp_|Authorization: Bearer|[A-Z]:\\\\Users\\\\)" -- . ':!docs/superpowers/plans/*'`
Expected: no credential, local home path, real learning content, runtime state, or repository clone is tracked.

- [ ] **Step 6: Commit**

```bash
git add README.md Workbench/README.md Workbench/tests/public-boundaries.test.mjs
git commit -m "docs: document AI radar learning entry"
```

- [ ] **Step 7: Perform the 30-day acceptance setup**

Record only local runtime health counters: scheduled run coverage, failed run count, number of repositories reviewed, number saved, summaries generated, and learning projects started. Do not commit real metrics. The product acceptance after 30 days is review under 10 minutes/day, at least 4 worthwhile repositories, and at least 1 started learning project.
