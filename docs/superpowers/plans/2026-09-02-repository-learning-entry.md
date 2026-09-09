# Repository Summary and Learning Entry Implementation Plan (Phase 2 — corrected contract v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implement strictly one vertical slice at a time: one failing behaviour test → minimal implementation → pass. Do not batch-write all tests before implementing, and never test private methods.

**Goal:** Let users create fixed-version, per-repository learning workspaces with reviewable, editable missions and a three-active-project limit. The no-model path (radar card "加入学习" → choose one of five goals and edit the task draft → review fixed commit → confirm → independent workspace) must work end-to-end. Optional model summaries, relevance and task-draft hints are later slices, never a prerequisite.

**Architecture (verified against current code):**
- `createGitHubRadarClient` (`server/ai-radar/github-client.mjs:302`) already exposes `getReadme` and `getHeadCommit`, plus auth, rate-limit, ETag, pagination and timeout. **Both return objects, not scalars**: `getHeadCommit({ fullName, ref? })` → `{ fullName, ref, sha, committedAt, observedAt }` (use `.sha`); `getReadme({ fullName, ref? })` → `{ fullName, ref, sha, path, content, observedAt }` where `sha` is the README **blob** SHA, not a commit SHA. Summary reading must pass the fixed commit as `ref` explicitly.
- The knowledge assistant model transport (`server/knowledge-chat/model.mjs` `createModelClient` + `loadModelConfig`) is Anthropic-compatible but coupled to `KnowledgeError` and `/v1/messages` streaming. Phase 2 **reuses/extends the existing transport shape** behind a provider-neutral optional structured model interface; it does **not** import `knowledge-chat` internals into radar/learning modules, and never duplicates a second request implementation.
- Radar decision status already reserves `queued | learning | completed` (`server/ai-radar/radar-schema.mjs:78`). There is **no** `RepositorySummary` schema, **no** learning workspace store, **no** 3-active enforcement, and **no** migration registry. The learning workspace store is net-new; summary storage is a later slice.
- Learning workspaces live in the **stable bound-workspace app-state** (`appDataRoot/PersonalAIWorkbench/workspaces/{workspaceId}/learning/`), independent of the Vault path, and register as a third backup provider implementing the existing `{ id, schemaVersion, exportState, validateImport, replaceState, stageImport }` contract so it slots into `createWorkspaceBackup` with zero new plumbing.
- Lock primitives are **per-store and independent**: radar holds `radar.lock`, the registry holds `workspace-registry.lock`, and the learning store holds its own lock — each via `createTicketLock` (`server/workspace-state/ticket-lock.mjs:41`). `withBoundWorkspace` (`server/workspace-state/workspace-registry.mjs:456`) is a **binding guard**: it takes the registry lock to verify the current binding, then runs the operation. It is **not** a cross-store transaction or rollback mechanism. A learning mutation runs `withBoundWorkspace` (registry lock) **then** the learning store's own lock, sequentially, each held only for its own fast local write. Slow work (`getHeadCommit`, model calls) happens **before** either lock is taken.
- Backup exclusion rules already reject credentials / cache / real Vault bodies / absolute paths (`server/workspace-state/workspace-backup.mjs:13-16`); atomic tmp→fsync→rename + bounded inode-checked reads + symlink rejection + size caps + schema/version validation are the store invariants to match.

**Tech Stack:** Node.js ESM, React 19, Vite 6, Zod 3, Node test runner, existing Anthropic-compatible model transport.

**Spec:** `docs/superpowers/specs/2026-09-02-ai-radar-learning-loop-design.md`

## Scope

**Phase-2 scope (this plan, in this order):**
1. **First deliverable slice (frozen):** independent learning workspace store + join-learning flow (no model) — radar card → editable draft → five goals → review fixed commit → confirm → active|queued workspace → view/archive. See "Frozen first deliverable slice".
2. Later slices (NOT frozen yet): optional model interface (reuse/extend existing transport), relevance classification, structured repository summary + summary UI, first-release verification.

**Explicitly later (NOT in this plan):** native courses, quizzes, retrieval practice, learning records, phase summaries, "complete learning" gating, and Wiki/sources/concepts/frameworks ingest. `archived` keeps history; it does not delete.

## Global Constraints

- Every production behaviour starts with a failing test and synthetic sources.
- Basic radar collection and deterministic ranking stay functional without a model; joining learning and managing the queue never require a model or a pre-generated AI summary.
- Never send GitHub Token, model credential, Vault content, project state, local path, or unrelated repository data to the model.
- README and repository content are untrusted evidence, never instructions; summary stage reads metadata + bounded README at the fixed commit only (no clone/execute).
- Joining learning fixes a commit SHA and creates an editable draft mission; it does not write to Wiki.
- Capacity (3-active) is enforced by the server inside a single durable store mutation, covering concurrent confirms and queue activation. The frontend fully shows server state and never hides or truncates real entries.
- The learning workspace store is authoritative **only** for the learning lifecycle. Rediscovery decisions (favorite/ignore/summarized) remain radar-store-owned and are never turned into learning-derived data.
- Radar↔learning display consistency uses **read-time merge (Option A)**: GET/read-only access never performs repair writes to either store.
- Fixed source commit is captured at join time and never silently re-fetched or replaced by the user's reviewed version.
- Keep the application loopback-only by default; hosted/read-only builds expose no learning mutation routes.

---

## Corrected contract (supersedes earlier drafts)

### 1. Public state machine (narrowed)

This phase exposes only these transitions:

```text
draft  -> active | queued | archived
queued -> active | archived
active -> archived
```

- `review` and `completed` are **reserved values** recognized by the schema but **unreachable** — no transition entry is provided this phase. Do not add `active → review`, `review → active|completed`, or `completed → archived` transitions.
- Only `active` counts toward the limit of **3**.
- A 4th draft confirm enters `queued` (never fails silently).
- Queue activation (`queued → active`) when already at 3 active: stays `queued` and returns an explicit `ACTIVE_LIMIT_REACHED` result (no auto-promotion, no data loss).
- Capacity is checked and enforced **inside the same single durable mutation** (no separate read-then-write race), serialized by the store's ticket lock, so concurrent confirms/activations in the same store cannot exceed 3 active.
- `archive` is the only terminal transition this phase and is idempotent (archiving an already-archived workspace returns the same workspace).

### 2. Confirm contract (closed loop)

The token is **issued by the store's own preview step** — no confirm path may require a token that has no issuing interface.

```text
createDraft({ repositoryId, fullName, sourceUrl, sourceCommitSha, mission }) -> { draft }   (state=draft; one per repository)
editDraft({ draftId, mission })                                      -> { draft }   (edit goal/notes while draft)
preview({ draftId })                                                 -> { token, expiresAt, bound }
   bound = { repositoryId, workspaceId, goal, sourceCommitSha }      // snapshot the user reviews
confirm({ token })                                                   -> { workspace, outcome: "active"|"queued"|"already-confirmed" }
list({ includeArchived }) / get(workspaceId) / archive(workspaceId)  -> workspace(s)
```

- **Valid, unconsumed token**: confirms only the exact bound draft — the bound `repositoryId`, `workspaceId`, `goal`, and `sourceCommitSha` are the values confirmed. Nothing else is accepted.
- **Retry of the same already-successful confirm**: returns the existing result (same workspace, same `outcome`), **never** creates a duplicate workspace or placeholder. This requires the store to persist the consumed-token → outcome **receipt**.
- **Unused-but-expired / input-drifted / ownership-mismatched token**: rejected with `CONFIRM_TOKEN_INVALID`. Input drift = the live draft's `goal`/`sourceCommitSha`/`repositoryId` no longer match the token's `bound` (user edited or a different commit appeared) → force a fresh `preview`. Ownership mismatch = token wasn't issued for this store/binding.
- **Receipt retention & restart retry**: consumed-token receipts persist in the store, bounded by a TTL (e.g. 24h, gc'd like other retention). After a process restart, a replayed token returns the persisted receipt (idempotent replay). After the receipt TTL expires, a replayed token rejects with `CONFIRM_TOKEN_CONSUMED`; the workspace remains discoverable via `get(workspaceId)`/`list`/repository lookup, so the client recovers without re-creating.
- **Closed responsibilities**: `createDraft`/`preview`/`editDraft` never transition state out of `draft`; only `confirm` consumes a token and transitions to `active`/`queued`. Every return value is complete for its caller (draft returns the editable draft; preview returns token+bound snapshot; confirm returns workspace+outcome).

### 3. Radar ↔ learning consistency (Option A: read-time merge)

**The learning store is authoritative only for the learning lifecycle.** Rediscovery decisions (`saved`/`ignored`/`summarized`/`unread` via radar `setDecision`) are owned by the radar store and are never rewritten from learning state. Phase 2 sets **no** `queued`/`learning`/`completed` decision values on the radar store — those enum slots stay reserved/unused this phase; the learning lifecycle lives entirely in the learning store.

**Display mapping (draft/queued/active/archived → radar card):** the radar dashboard read path joins the learning store per repository and overlays the lifecycle facet; the discovery decision is untouched:

| Learning state | Radar card shows | Rediscovery decision |
|---|---|---|
| (no workspace) | discovery decision only | unchanged (saved/ignored/summarized/unread) |
| draft | "学习（草稿）" | unchanged |
| queued | "学习中（排队）" | unchanged |
| active | "学习中" | unchanged |
| archived | "已归档" | **unchanged** — archive does not alter the repo's earlier favorite/ignore/summarized decision |

**Why Option A (read-time merge) over Option B (write-back):**
- Option B introduces a sync-intent record, an idempotent write-back, and a "confirm write-back complete" handshake between two stores with independent locks. That machinery is exactly the class of failure the step warns about (write ordering, crash between learning-write and radar-write, retry/restart/late-op races, rebind during sync) — and it risks learning writes clobbering user rediscovery decisions.
- Option A removes the cross-store write path entirely: the learning store is the single truth for lifecycle; the radar read path merges it live. There is nothing to converge because there is no second copy to keep in sync.
- Cost: the radar dashboard read does one extra local read of the learning store (no network). That is cheap and localized to the read path.
- GET and read-only access never perform repair writes by construction — a read-merge has no write path.

**Failure-window / retry / restart / late-op / rebind analysis (Option A):**
- Cross-store write ordering: none exists; there is no write to the radar store from learning code, so there is no ordering or crash window between two stores.
- Late-completing old op: a confirm that finishes after a GET started yields a later GET showing the newer lifecycle state; benign (read-time, eventual), never a write.
- Retry/restart: the learning store persists the transition; a restarted process re-reads it. No reconciliation step needed.
- Rebind: the learning store lives under the bound workspace; after Vault rebind, reads use the newly bound store and the (also re-bound) radar store. No cross-store repair.
- **Lock scope and order (corrected):** each store serializes its own writes under its own `createTicketLock`. A learning mutation is `withBoundWorkspace(...)` (registry lock; verifies binding, aborts `WORKSPACE_BINDING_CHANGED` if moved) **then** the learning store's own lock for the durable write — sequential, each held only for its own fast local op. `withBoundWorkspace` is a **binding guard, not a cross-store rollback**: it does not commit/rollback the radar store and must not be described as such. **Slow work (`getHeadCommit`, model calls) runs before any lock.** The lock-held section never awaits GitHub or the model.

### 4. Unified backup contract

Recovery scope by asset class:

| Asset class | Backup/restore | Examples |
|---|---|---|
| Metadata | **recoverable** | `workspace.json`, state, goal, `sourceCommitSha`, `sourceUrl`, version, timestamps, receipt TTL bookkeeping |
| User-written files | **recoverable** | authored mission/task notes (`MISSION.md`, `NOTES.md`) — authored learning assets |
| Generated files | **recoverable only if learning records** | validated, source-referenced learning artifacts (checksum, source refs); **not** transient model output |
| Cache | **never backed up** | shallow clone, fetched README cache, transient model checkpoints |

- **Old backups missing the `learning` provider**: `learning` is `optionalForImport` (like `radar`), so an old projects/radar-only backup imports cleanly and the **existing learning data is preserved** (not deleted, not overwritten).
- **Framework vs provider responsibility split:** the backup framework provides the bundle format, checksum, per-provider version validation, two-phase `stageImport` (stage all → commit sequentially → reverse rollback on any commit failure), and atomic per-provider replace. The **learning provider itself** must guarantee, at its own file level: atomic tmp→fsync→rename commit, failure recovery that leaves the prior valid state on a partial write, and corruption protection (bounded inode-checked reads, symlink rejection, size cap, schema/version validation).
- **Absent store is a no-op:** `list`, `get`, `exportState`, and the radar read-merge must treat a missing learning store as empty and **must not create the store directory** on read-only query/export. Directory creation happens only on an actual mutation.

### 5. User-action semantics

- Clicking "加入学习" opens an **editable draft** (mission dialog with the five goals + free text), not an immediate activation.
- After the user confirms, the workspace enters **`active`**, or **`queued`** if 3 are already active — per capacity, decided server-side in the single mutation.
- **No automatic Wiki write** on join/confirm.
- The UI renders the server's full state: active/queued/drafts/archived sections plus any `ACTIVE_LIMIT_REACHED`/`CONFIRM_TOKEN_*` outcome. It never clips entries — if the server ever returns more than 3 active, the UI surfaces a data-anomaly state rather than truncating.

### 6. Fixed-source contract

- Use `getHeadCommit({ fullName })` → returns an **object**; the pinned commit SHA is **`.sha`** (40-hex), not the whole object.
- `getReadme({ fullName, ref })` → returns `{ sha, ... }` where `sha` is the **README blob SHA**, never a commit SHA.
- Summary generation must explicitly pass the **fixed commit's SHA as `ref`** to `getReadme` so the README is read at the pinned commit; it records the blob `sha` as the README source and the fixed commit SHA as the summary source commit.
- **Record summary-source commit and learning fixed commit independently**: the summary keeps its own `sourceCommitSha`; the learning workspace keeps its own pinned `sourceCommitSha`. When they differ, both are stored and surfaced; neither overwrites the other, and confirm never silently swaps them.

---

## Frozen first deliverable slice

**Final user result (must work end-to-end, no model):**

```text
雷达卡片 "加入学习"
  → 选择五种目标之一并编辑任务草案
  → 审核固定 commit
  → 确认
  → 独立工作区展示来源、目标和状态
第 4 个进入队列，用户可查看和归档
```

Implementation checkpoints within this slice (mark as done only at the checkpoint, do **not** claim a checkpoint is "complete user capability" on its own):

- **Checkpoint S1 — store:** `LearningWorkspaceRepository` (see interface below) fully passes its interface tests on a temp real store: state machine, capacity, idempotent confirm, read-only-without-store, restart persistence, backup-provider contract.
- **Checkpoint S2 — HTTP:** `LearningService` + routes wire `getHeadCommit` (preview fixes commit) + `createDraft/editDraft/preview/confirm/list/get/archive`; confirm → active|queued server-side; hosted/read-only writes fail.
- **Checkpoint S3 — UI:** radar card "加入学习" → editable mission dialog (five goals) → review fixed commit → confirm → learning workspace page (source/goal/state) + queue view with archive.

Freeze rule: the slice is accepted only when **all three checkpoints** are green together against temp real stores and synthetic GitHub/model responses. The store alone is an internal foundation, not a deliverable user capability; do not ship any single checkpoint as "the feature done".

**Out of this slice:** optional model, summaries, relevance, migration registry, courses, completion, Wiki ingest.

---

## Next implementation checkpoint — LearningWorkspaceRepository (interface & test seams)

Only this next piece is detailed. Everything below is the public interface under test; tests observe behaviour **through this interface** on a **temporary real on-disk store**, never by reading internal JSON as the primary assertion.

**Inputs / return values**

```js
createLearningRepository({ directory, now, makeId?, ticketLock?, schemaVersion })
  -> {
      createDraft(input),   editDraft(input),   preview({ draftId }),
      confirm({ token }),   list({ includeArchived }),   get(workspaceId),
      archive(workspaceId), registerBackupProvider(),     exportState(), validateImport(value), replaceState(value)
    }
```

- `createDraft(input)` input `{ repositoryId, fullName, sourceUrl, sourceCommitSha, mission }`; `mission = { goal, notes? }`; `goal ∈ { understand-architecture, learn-usage, analyze-design, reproduce-capability, adoption-decision }`. Returns `{ draft }` with `state:"draft"`, a workspace id that is live-relative (no absolute path), and 40-hex `sourceCommitSha` enforced.
- `editDraft({ draftId, mission })` returns `{ draft }` only while `state==="draft"`; edits goal/notes; re-validates constraints.
- `preview({ draftId })` returns `{ token, expiresAt, bound: { repositoryId, workspaceId, goal, sourceCommitSha } }`; issues a fresh single-consumption token bound to the current draft snapshot; the `bound` is what the user reviews.
- `confirm({ token })` returns `{ workspace, outcome }` (`active`|`queued`|`already-confirmed`); consumes the token, persists the receipt, applies capacity in the same mutation.
- `list({ includeArchived })` / `get(workspaceId)` / `archive(workspaceId)` return workspaces or a clear `WORKSPACE_NOT_FOUND`; `archive` is idempotent.
- `registerBackupProvider()` returns `{ id:"learning", schemaVersion, exportState, validateImport, replaceState, stageImport }`.

**Draft edit & confirm (closed loop):** drafting, editing, previewing and confirming are separated as above; only `confirm` transitions state; preview is the sole token issuer; confirm validates the token bound against the live store.

**Idempotency / capacity / archive**
- Same consumed token replayed → same `outcome`, no duplicate workspace.
- 4th active-confirm → `queued`; queue activation at 3 active → stays `queued` + `ACTIVE_LIMIT_REACHED`.
- Archive idempotent; archived workspace retrievable via `get`/`list({includeArchived:true})`.

**Read-only without store (no directory created):** `list`/`get`/`exportState` on a missing store return empty (or `WORKSPACE_NOT_FOUND` for `get`) and do **not** create the store directory; only a mutation creates it.

**Restart persistence via the same interface:** after re-creating `createLearningRepository({ directory: sameDir, ... })` in a fresh process, `list`/`get` return the previously persisted workspaces and confirm-receipts through the same public interface — verify by interface query, not raw file reads.

**Backup-provider public contract:** `exportState` → `validateImport` → `replaceState` round-trips; `stageImport` returns `{ commit, rollback, cleanup }`; absent learning provider in an old backup is tolerated (`optionalForImport`) and leaves existing data intact; provider `exportState` never emits credentials, absolute paths, real Vault bodies, or clone/README cache.

---

## Test seams & key behaviours (for confirmation — no test written in this step)

**Recommended seams (observe through the public interface, temp real stores, synthetic GitHub/model at external adapter seams):**

1. **Slice-1 seam — `LearningWorkspaceRepository` interface** (temp real store). Key behaviours: confirm under capacity→active; 4th→queued; queue activation when full→stays queued + `ACTIVE_LIMIT_REACHED`; same-token replay→`already-confirmed` no duplicate; expired/drifted/ownership-mismatched token→`CONFIRM_TOKEN_INVALID`; archive idempotent; read-only query on missing store→empty and **no directory created**; re-create repository on same dir→same workspaces/receipts through the interface; `exportState`→`replaceState` round-trip; `stageImport` reverse-rollback on commit failure; provider exports exclude credentials/cache/abs-path/Vault body.

2. **Slice-2 seam — fixed-version source + routes HTTP boundary.** Key behaviours: `getHeadCommit` returns an object, use `.sha`; preview pins `.sha` into the token bound; confirm rejects drifted/expired/duplicate/ownership token; 4th queues server-side; unreachable commit keeps prior pinned version with safe error (never silent HEAD switch); local/read-only gate (403/404 on hosted/read-only write); no route clones or executes code. (Cross-store coordination uses **temp real learning AND radar stores**; GitHub/model use synthetic responses at adapter seams — do not prove real transactions/concurrency with all-fake stores.)

3. **Slice-3 seam — HTTP capability + user-visible interaction** (`ai-radar-ui.test.mjs` mount harness + `renderToStaticMarkup`). Key behaviours: "加入学习" opens editable draft; five goals selectable; review fixed commit; confirm→active|queued; workspace page shows source/goal/state; 4th visible in queue and archivable; full state rendered — no clipping of server entries; hosted build hides learning nav; model-unavailable state never blocks the manual path.

**Boundary notes:** tests assert through the public interface and rendered UI, not by reading internal JSON files. Never use all-fake stores to claim real transaction/concurrency invariants; use real stores for store/reconcile-level tests and synthetic responses only for GitHub/model at the external adapter seam.

---

## Later slices (not frozen)

- **Optional structured model interface:** provider-neutral wrapper that **reuses/extends the existing knowledge transport shape** (no second request implementation); explicit availability probe, Zod-validated generation, internal timeout; availability probe must **not** block base pages by actively pinging the model network (probe is a local config+capability check; on-demand calls stay on the explicit action).
- **Relevance classification + repository summary + summary UI:** rule-first, optional-model; summary reads bounded README **at the fixed commit `ref`**; records summary-source commit and learning fixed commit independently; adds a versioned store (migration registry) for summaries.
- **First-release verification + docs.**

## Pending decisions (product-rule conflicts, not silently changed)

1. `review`/`completed` are reserved-but-unreachable this phase (no transition entry). Confirm later phases own those transitions and add their UI/acceptance then.
2. Radar↔learning display consistency uses **Option A read-time merge**; radar `queued|learning|completed` enum slots stay unused this phase. Confirm no product requirement needs a persisted radar learning status (which would force Option B).
3. A migration registry for the radar store is deferred to the summary slice (the learning store has its own independent schema/version). Confirm that's acceptable.

## Acceptance reference (30 days)

Record only local health counters (scheduled run coverage, failed run count, repos reviewed/saved, summaries generated, learning projects started); never commit real metrics. Success = review <10 min/day, ≥4 worthwhile repos, ≥1 started learning project.
