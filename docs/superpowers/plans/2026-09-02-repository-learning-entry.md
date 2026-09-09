# Repository Summary and Learning Entry Implementation Plan (Phase 2 — corrected)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implement strictly one vertical slice at a time: one failing behaviour test → minimal implementation → pass. Do not batch-write all tests before implementing, and never test private methods.

**Goal:** Let users create fixed-version, per-repository learning workspaces with reviewable missions and a three-active-project limit, with an optional model adding summaries and task-draft hints. The no-model path (select repo → manual mission draft → confirm → independent workspace) must work end-to-end.

**Architecture (verified against current code):**
- The GitHub client already exposes `getReadme` and `getHeadCommit` (`server/ai-radar/github-client.mjs:302`) and `createGitHubRadarClient` handles auth, rate-limit, ETag, pagination and timeout. Phase 2 reuses these read capabilities as-is; only shallow-clone of a fixed commit is net-new (a later slice, not phase 2).
- The knowledge assistant model transport (`server/knowledge-chat/model.mjs` `createModelClient` + `loadModelConfig`) is Anthropic-compatible but coupled to `KnowledgeError` and `/v1/messages` streaming. Phase 2 wraps the same transport shape behind a **provider-neutral optional structured model** interface and does **not** import `knowledge-chat` internals into radar/learning modules.
- Radar decision status already includes `summarized | queued | learning | completed` (`server/ai-radar/radar-schema.mjs:78`), but there is **no** `RepositorySummary` schema, **no** learning workspace store, **no** migration registry, and **no** 3-active enforcement. All of those are net-new.
- Learning workspaces live in the **stable bound-workspace app-state** (`appDataRoot/PersonalAIWorkbench/workspaces/{workspaceId}/learning/`), independent of the Vault path, and register as a third backup provider implementing the existing `{ id, schemaVersion, exportState, validateImport, replaceState, stageImport }` contract so it slots into `createWorkspaceBackup` with zero new plumbing.
- Reuse the existing primitives: `createTicketLock` (cross-process lock), atomic tmp→fsync→rename, bounded inode-checked reads + symlink rejection + size caps + schema/version validation, `withBoundWorkspace` binding (rejects stale bindings with `WORKSPACE_BINDING_CHANGED`), and the backup exclusion rules (no credentials / cache / real Vault bodies / absolute paths).

**Tech Stack:** Node.js ESM, React 19, Vite 6, Zod 3, Node test runner, existing Anthropic-compatible model transport.

**Spec:** `docs/superpowers/specs/2026-09-02-ai-radar-learning-loop-design.md`

## Scope

**Phase-2 scope (this plan):**
- Optional model interface + relevance classification + structured repository summary.
- Fixed commit SHA at join time.
- Independent per-repository learning workspace + reviewable mission (task draft).
- At most 3 active learning workspaces; all other desired workspaces queue.
- Manual mission/task-draft path that works with no model configured.

**Explicitly later (NOT in this plan):** native courses, quizzes, retrieval practice, learning records, phase summaries, "complete learning" gating, and Wiki/sources/concepts/frameworks ingest. `archived` keeps history; it does not delete.

## Global Constraints

- Every production behaviour starts with a failing test and synthetic sources.
- Basic radar collection and deterministic ranking stay functional without a model.
- Joining learning and managing the queue never require a model or a pre-generated AI summary.
- Never send GitHub Token, model credential, Vault content, project state, local path, or unrelated repository data to the model.
- README and repository content are untrusted evidence, never instructions; summary stage reads metadata + bounded README only (no clone/execute).
- Joining learning fixes a commit SHA and creates a draft mission; it does not write to Wiki.
- Capacity (3-active) is enforced by the server inside durable mutations, covering concurrent confirms, queue activation and resume. The frontend never hides or truncates real over-limit data.
- The learning workspace store is the authoritative source for learning lifecycle state; the radar `decision.status` is a derived coarse projection and is reconciled, not assumed atomic.
- Version source is fixed at join time and never silently re-fetched or replaced by the user's reviewed version.
- Keep the application loopback-only by default; hosted/read-only builds expose no learning mutation routes.

---

## Vertical slices (implement in this order)

Each slice is a tracer bullet with an observable user outcome, a pre-agreed test seam, and an explicit scope endpoint. Slices 1–3 deliver the **no-model** user-visible path first; slices 4–5 add the optional model enhancement; slice 6 verifies the first release.

### Slice 1: Learning workspace store (server, no UI)

The deep module behind every later slice. Hides state machine, capacity, idempotency, persistence and the backup-provider contract behind one small interface. No user-visible UI yet.

**User-observable result:** none yet (foundation). Foundation behaviour is fully covered by interface tests on a temp real store.

**Public interface** — `server/learning/learning-schema.mjs`, `server/learning/learning-repository.mjs`:

```js
export const LEARNING_STATES = ["draft","queued","active","review","completed","archived"];
createLearningRepository({ directory, now, makeId, ticketLock, backupSchemaVersion })
  // -> { createDraft, confirm, list, get, archive, markTransition, registerBackupProvider }
```

- `createDraft({ repositoryId, fullName, sourceUrl, sourceCommitSha, mission }) → workspace(state="draft")`
  - invariants: exactly one independent workspace per repository; `sourceCommitSha` is exactly 40 hex; workspace uses a live-relative id (no absolute path).
- `confirm({ repositoryId, token }) → { workspace, state }` — idempotent for a signed, time-boxed token; fourth concurrent confirm queues rather than failing silently; capacity checked inside a **single persisted mutation** (no read-then-write race).
- `list({ includeArchived })`, `get(workspaceId)`, `archive(workspaceId)`, `markTransition(...)`.
- `registerBackupProvider()` → `{ id:"learning", schemaVersion, exportState, validateImport, replaceState, stageImport }`.

**State machine** (only `active` counts toward the limit of 3):

```text
draft -> active | archived         (draft is unconfirmed; does not count)
queued -> active | archived
active -> review | archived
review -> completed | active       (resume; if full, stays in review with ACTIVE_LIMIT_REACHED)
completed -> archived
```

**Dependencies:** `server/workspace-state/ticket-lock.mjs` (`createTicketLock`, cross-process lock), `server/workspace-state/backup-schema.mjs`; pattern-match `server/ai-radar/radar-repository.mjs` atomic write + bounded inode-checked read + symlink rejection + size cap + schema/version validation + `.superpowers`-free error class `LearningWorkspaceError` + `safeLearningError` mapped via the existing `safeRadarError` style route-facing normalization.

**Test seam:** the public `LearningWorkspaceRepository` interface, exercised against a temporary real on-disk store (not a fake). **This is pending review — no test written in this step.**

**Acceptance criteria:** draft→confirm under capacity→active; fourth confirm→queued; duplicate confirm returns the same workspace; corrupt store→read-only recover (never overwrite); resume-when-full→`ACTIVE_LIMIT_REACHED` keeping `review`; `exportState`→`replaceState` round-trip; `stageImport` rolls back committed providers in reverse on any commit failure; backup provider exports only recoverable metadata (no cloned source cache, no credentials, no README bodies, no absolute paths).

**Scope endpoint:** all server transitions + persistence + backup-provider contract pass with a temp real store. No routes, no UI, no reconciliation yet.

---

### Slice 2: Join-learning orchestration + fixed version (server routes)

The server half of the user-visible path, still no UI. Pins the commit, issues preview/confirm, and reconciles the radar decision.

**User-observable result:** an HTTP caller can, for a chosen repository: preview a mission pinning current HEAD, confirm it into an independent workspace (or queue if full), list/get/archive workspaces, and see the radar card decision reflect queued/learning/completed — all with **no model configured**.

**Public interface** — `server/learning/learning-service.mjs`, `server/learning/learning-routes.mjs`:

```js
createLearningService({ github, summaries, learning, radar, now })
  // -> { previewMission, confirmMission, listWorkspaces, getWorkspace, archiveWorkspace, reconcile }
```

Routes under `/api/learning`: `POST /api/learning/preview`, `POST /api/learning/confirm`, `GET /api/learning`, `GET /api/learning/:id`, `POST /api/learning/:id/archive`. Summary stays under radar `/api/ai-radar`; learning lifecycle stays under `/api/learning`.

**Fixed-version source interface (reused as-is):** `github.getHeadCommit({ fullName })` (`server/ai-radar/github-client.mjs:292`, returns 40-hex default-branch HEAD). Preview pins this SHA into the mission token. Confirm binds exactly the previewed commit; it never silently re-fetches HEAD or replaces the user-reviewed version. If the summary `sourceCommitSha` differs from the joined version, record both and surface the difference; do not overwrite.

**No-model flow:** preview/confirm accept a user-supplied mission goal (`understand-architecture | learn-usage | analyze-design | reproduce-capability | adoption-decision`, per spec) and optional notes. An AI summary is an *optional enrichment*, never a prerequisite for join. When `optionalModel.available === false`, the manual draft path proceeds and the API returns an explicit `SUMMARY_UNAVAILABLE` capability signal while the base flow stays usable.

**State consistency (authority + reconcile):** the learning store is authoritative; radar `decisions[repositoryId].status` is a derived coarse projection. A mutation commits the learning record first, then issues the radar decision write. If the radar write fails, the learning record marks `radarDecisionSync:"pending"`. `reconcile()` re-derives the decision from authoritative learning state and retries the write; it runs at startup, before any radar dashboard/decision read, and before the next learning operation — so duplicates, retries and restarts converge deterministically. All binding-sensitive mutations run inside `registry.withBoundWorkspace(...)`; a mid-mutation rebind aborts atomically with `WORKSPACE_BINDING_CHANGED`.

**Dependencies:** `github.getHeadCommit` (existing), `LearningWorkspaceRepository` (Slice 1), radar repository + `setDecision` (`server/ai-radar/radar-repository.mjs:425`), `server/ai-radar/radar-schema.mjs` decision statuses, `vite-plugin-workbench.mjs` route registration gated to local, non-read-only (`radarMutable`-style guard: `!hosted && !projectsReadOnly`).

**Test seam:** the fixed-version source interface (`getHeadCommit`) + the learning routes HTTP boundary (real `createLearningRoutes` + call-recording fake github/learning/radar, matching the existing `tests/ai-radar-api.test.mjs` style). **Pending review — no test written.**

**Acceptance criteria:** preview pins current HEAD; confirm rejects drifted/expired/duplicate tokens; fourth confirm queues server-side; unreachable commit keeps the prior pinned version with a safe error (never silently switch HEAD); radar decision reconciles to queued/learning/completed; hosted/read-only writes fail (403/404); no route clones or executes repository code.

**Scope endpoint:** all learning HTTP commands work with a manual draft and no model. No summary generation, no UI.

---

### Slice 3: No-model learning UI (first fully user-visible slice)

Delivers the end-user path: **选择仓库 → 手工任务草案 → 确认 → 独立学习工作区**, plus the queue with active-limit feedback and archive.

**User-observable result:** from a radar card the user can open a mission dialog, pick one of the five goals, optionally write notes, confirm, and land on an independent learning workspace page showing source URL + pinned commit + mission. If 3 are already active, the fourth clearly queued. Without a model, radar still renders and the join path works; summary/hint areas explain configuration instead of blocking.

**Public interface** — `server/learning/learning-routes.mjs` (Slice 2) + client model `src/lib/learning-api.js`, `src/lib/learning-model.js`:

- Reuse the `command(path, payload)` + `queryParams` pattern from `src/lib/ai-radar-api.js` / `workspace-api.js`; pure projections mirror `src/lib/ai-radar-model.js` (`projectLearningQueue(payload) → { active, queued, drafts, archived, limit, error }`). The projection **must not hide** entries the server returns; if the server ever returns >3 active it surfaces a data-anomaly state, never truncates.
- Components (reuse `src/components/projects/TaskDrawer.jsx` drawer skeleton): `RepositorySummaryDrawer.jsx`, `LearningMissionDialog.jsx`, `LearningQueue.jsx`, `src/pages/LearningPage.jsx`; route + nav registered only under the existing `localWorkbench = import.meta.env.VITE_WORKBENCH_HOSTED !== "true"` block in `src/App.jsx` / `AppShell.jsx` (hosted builds omit learning navigation).
- Async state mirrors `src/pages/AiRadarPage.jsx` presentational/container split + per-action busy/error maps + out-of-order guard; read-only/hosted gating relies on server `403` + the `LOCAL_API_UNAVAILABLE` normalization in `src/lib/api-errors.js` and client-side capability arbitration like radar.

**Test seam:** the HTTP capability + user-visible interaction boundary — the existing `ai-radar-ui.test.mjs` mount harness (`react-dom/client` + happy-dom + globally mocked fetch recording `(path, method)`), plus `renderToStaticMarkup` static render like `projects-ui.test.mjs`. **Pending review — no test written.**

**Acceptance criteria:** mission dialog exposes exactly the five goals + confirmation; confirm never immediately activates or writes Wiki; learning page separates active/queued/drafts/archived with active count never displayed above 3 and always matching a server-enforced invariant; archive requires an explicit action and does not delete workspace files; source URL + pinned commit + mission visible; model-unavailable banner shows rather than a blocked join.

**Scope endpoint:** complete no-model learning lifecycle usable in the UI. No summary drawer content, no model hints.

---

### Slice 4: Optional structured model interface

Provider-neutral seam reusing the existing transport shape without coupling to `knowledge-chat`.

**User-observable result:** a capability endpoint reports whether structured generation is available; when it is, radar relevance and summaries enrich the join path (feeding Slice 5). When it is not, the base flow is unchanged with a clear reason.

**Public interface** — `server/models/structured-model.mjs`:

```js
createStructuredModel({ transport })
loadOptionalModel({ config, settingsPath }) // -> { available:false, reason } | { available:true, model }
// transport.generate({ system, prompt, schema, timeoutMs }) -> validated value (throws on invalid/timeout)
```

- Reuses the Anthropic-compatible transport shape of `createModelClient`/`loadModelConfig` (`server/knowledge-chat/model.mjs`) but **provider-neutral**: takes the configured base URL/token/model and its own error type (matching the `GitHubRadarError`/`RadarRepositoryError` convention), **does not import `KnowledgeError` or `./errors.mjs`**, does not assume Codex/vendor.
- Explicit availability probe (config present + reachable), schema-validated generation (Zod), and an internal timeout so invalid output is rejected for regeneration and a missing model yields `{ available:false, reason }` with a safe message. No credentials in errors. One adapter (the existing transport) — no generic multi-vendor framework.

**Test seam:** the optional structured model interface with synthetic `transport` completions (valid JSON, invalid JSON, schema mismatch, timeout, unavailable config). **Pending review — no test written.**

**Acceptance criteria:** unavailable→`MODEL_NOT_CONFIGURED` explicit result and base radar/learning unaffected; valid JSON passes schema; invalid JSON / schema mismatch / timeout are rejected with safe codes and never leak credentials; existing knowledge tests still pass (no behaviour change to `knowledge-chat`).

**Scope endpoint:** `loadOptionalModel` + `generate` validated. No radar/learning wiring yet.

---

### Slice 5: Repository summary + relevance + summary UI

The optional-model enhancement fed into the join path.

**User-observable result:** with a model, a radar card can generate a source-bound repository summary (problem, why now, relevance, stack, maintenance, License, cautions, recommendation) displayed in the summary drawer, and relevance classification enriches the "与你相关" list; joining learning can pre-fill the mission draft from the summary, always editable and still confirmable by hand. The summary shows its own source commit/URL/read time; if it differs from the joined version, both are shown.

**Public interface** — `server/ai-radar/radar-relevance.mjs`, `server/ai-radar/repository-summary.mjs`, `server/ai-radar/summary-schema.mjs`:

- `classifyRelevance({ repositories, model })` — rule-first (never model-critical), optional structured model as explicit input; only rule-filtered candidates reach the model; malformed output falls back per item; bounded reasons; credentials/README-body absent from prompts.
- `createRepositorySummaryService({ github, radar, model, now })` → `generate(repositoryId)` — reads metadata + HEAD + bounded README on demand (`getReadme`, ≤2 MiB cap already enforced), quotes evidence inside clear delimiters, rejects tool calls/instruction expansion, persists validated structured content + source refs (URL, sourceCommitSha, read time, workflow version).
- `RepositorySummary` schema added **with a versioned store**: radar `radarStoreSchema.version` is currently locked to `1` with no migration registry (`server/ai-radar/radar-repository.mjs:115` hard-fails on non-1). This slice introduces a migration registry so summaries extend the store without silently breaking existing `version:1` state; unknown versions are rejected and never overwrite.

**Test seam:** the optional structured model interface (Slice 4) + fixed-version read interface (Slice 2) for summary `sourceCommitSha`; HTTP capability + user-visible interaction (summary drawer, summary-into-mission hint, no-model banner). **Pending review — no test written.**

**Acceptance criteria:** model-not-configured returns explicit unavailable and does not affect radar; bound summary shows committed source + version; oversized README truncated with a marker; prompt-injection text treated as quoted evidence; stale/joined-version difference surfaced; invalid model output rejected with regen; no addresses/Local paths/credentials in summary or store.

**Scope endpoint:** relevance + summary generation and summary UI. Nothing in this slice adds courses, quizzes, completion gating or Wiki ingest.

---

### Slice 6: First-release verification and documentation

**User-observable result:** a documented, privacy-safe first release with explicit limits; public-boundary tests assert no learning/summary leakage.

**Public interface:** none (verification + docs only).

**Test seam:** existing `tests/public-boundaries.test.mjs` + command-line release gate. **Pending review — no new seam.**

**Acceptance criteria:** README documents optional GitHub/model config, manual-collection semantics, three lists, retention, summary scope, version pinning, 3-active limit, and that lessons/Wiki/code execution are later phases; `npm test && npm run build && npm run privacy:scan` all exit 0; `git diff --check` clean; no credential, home path, bundle-relative runtime data, real learning content or clone cache is tracked.

**Scope endpoint:** release gate green; phase 2 ships without phase 3/4 behaviour implied.

---

## Differences from the original plan

The original plan ordered work model-first (Task 1 structured adapter → Task 2 relevance → Task 3 summary → Tasks 4–7 learning). This plan reorders to **no-model learning path first** (Slices 1–3) then model enhancement (Slices 4–5), because:
- The spec mandates radar usable without a model and queue management available without one; the manual mission/task-draft path is a first-class user flow, not a degraded fallback.
- A user-visible tracer bullet ("select repo → manual draft → confirm → workspace") delivers value before any LLM is configured and isolates the model work behind the Slice 4 seam.
- Defers the Store-schema migration problem (Slice 5) until after the learning lifecycle is proven, so migration risk stays localized.

The original plan's example test snippets (Task 1 `loadOptionalModel`, Task 6 `projectLearningQueue`, Task 4 `workspaceRelativePath`) are illustrative, not implementation-complete; each is re-derived as a failing behaviour test in its slice.

## Pending decisions (product-rule conflicts found, not silently changed)

1. **Resume-when-full (review → active):** spec says review can return to active. When all 3 active slots are taken, the design keeps the workspace in `review` and returns `ACTIVE_LIMIT_REACHED` rather than silently queueing or dropping. Confirm that this matches product intent (vs. queueing the resumed workspace).
2. **Radar decision authority:** radar `decisions[repositoryId].status` is treated as a derived projection of the learning store. Confirm the radar card should always reflect the learning store's coarse state, not an independently-playable status.
3. **Store migration:** a real migration registry (new in `ai-radar`) is required because radar store `version` is locked to `1`. Confirm a version bump + migration registry is acceptable in this phase (vs. storing summaries in a separate side-store).
4. **Backup provider**: learning workspaces become a third backup provider alongside `projects` and `radar`, `optionalForImport`. Confirm learning metadata should restore independently when a Vault rebinds (it follows the bound workspace).

## Acceptance reference (30 days)

Record only local health counters (scheduled run coverage, failed run count, repos reviewed/saved, summaries generated, learning projects started); never commit real metrics. Success = review <10 min/day, ≥4 worthwhile repos, ≥1 started learning project.
