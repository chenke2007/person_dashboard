# Knowledge Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local knowledge assistant with cited multi-step retrieval and explicitly confirmed, create-only Wiki drafts.

**Architecture:** Reuse the existing index and document reader. Separate model transport, evidence retrieval, local session persistence, controlled draft writer, API routes, and React panel. The global read-only guard stays on; only exact enabled chat routes bypass it.

**Tech Stack:** Existing Node/React/Vite, native fetch and fs, Node test runner, existing Markdown renderer.

**Spec:** `docs/superpowers/specs/2026-08-28-knowledge-assistant-design.md`

## Global Constraints

- Local loopback only; no deployment or copying private data into this repository.
- No shell/SQL execution, arbitrary file tools, overwrites, or changes to existing Vault documents.
- User applications data stores chat state outside the Vault and repository; test fixtures are synthetic temporary directories.
- Exact limits: question 8,000 characters; 8 attachments; 12 search results; read 8,000 characters; evidence 64,000 characters; history 12 messages / 24,000 characters; 8 model rounds / 16 tools; concurrency 2; timeout 180 seconds; confirmation expires 30 minutes.
- New Markdown only in `wiki/concepts`, `wiki/references`, `wiki/questions`, default concepts; no nested user paths.
- This installation has no Git metadata (ZIP deployment). Preserve in-place files; do not initialize Git or invent commits. Record progress in this plan and use focused file review instead of Git review helpers.

## Task 1: Model transport and evidence retrieval

Files: create `Workbench/server/knowledge-chat/model.mjs`, `retrieval.mjs`, `errors.mjs`, `Workbench/shared/knowledge-sse.mjs`; tests `Workbench/tests/knowledge-model.test.mjs`, `knowledge-retrieval.test.mjs`.

Interfaces: `loadModelConfig({env, settingsPath})` returns secret server config. `createModelClient(config,{fetchImpl})` returns `complete({messages,system,tools,signal,onText}) -> {content,stopReason}`. `createEvidenceContext({getIndex,vaultRoot})` returns `search(query)`, `read(documentId,start,length)`, `sources()`; evidence IDs are stable within one task and sources carry document ID/path/hash/start/end/excerpt. `consumeSse(body,onEvent)` is shared by browser/server.

- [x] Write and run failing tests for split UTF-8/SSE frames, streamed tool JSON, error sanitization, missing end event, redirect rejection, search evidence and same-name files. Core assertion: `assert.equal(result.content[0].input.query, 'backup')`; no hidden thinking in returned output.
- [x] Implement strict Anthropic-compatible Messages stream adapter, config allowlist, bounded stream buffers, sanitized typed errors and abort propagation. Read only authorized settings fields, never echo secrets.
- [x] Implement ranked Chinese/Latin keyword search against existing index plus bounded snippet reads; revalidate current file and source hash. Example: `assert.equal((await evidence.read(id,0,100)).text, 'select backup_probe;')`; unknown/excluded IDs reject.
- [x] Run `node --test tests/knowledge-model.test.mjs tests/knowledge-retrieval.test.mjs`. Probe configured gateway using synthetic tool input only; confirm complete tool loop, streamed text and abort behavior.

## Task 2: Sessions and controlled draft writer

Files: create `Workbench/server/knowledge-chat/store.mjs`, `drafts.mjs`; tests `Workbench/tests/knowledge-store.test.mjs`, `knowledge-drafts.test.mjs`.

Interfaces: `createChatStore({directory})` exposes `list()`, `get(id)`, `create()`, `save(session)`; sessions `{id,title,messages,drafts,createdAt,updatedAt}`. `createDraftService({store,vaultRoot,getIndex,notifyPaths,enabled,now})` exposes `create(sessionId,{title,category,body,sources})`, `revise(sessionId,draftId,{title,category,body})`, `preview(sessionId,draftId)`, `commit(sessionId,draftId,{version,confirmationToken})`. Preview returns draft with immutable version/hash-bound token; commit returns `{path,documentId,indexPending}`.

- [x] Write failing tests against real temporary filesystem: persistence reload, corrupt record fails closed, session traversal, no draft writes before confirmation, unknown token, changed source, expired token, same-name collision, concurrent double confirm, symlink/junction escape, no alteration of raw material.
- [x] Implement serialized, atomic state writes and private application data directory. Never store tokens in model messages. Reject corrupt records instead of replacing them.
- [x] Implement server-built safe filenames, finite category allowlist, bounded body, source hashes, exclusive create and idempotent receipt; compare reviewed content and path, invalidate tokens on revision. A valid test: `assert.equal(await readFile(newPath,'utf8'), preview.documentBody)`; duplicate commit must return same path and preserve bytes.
- [x] Run `node --test tests/knowledge-store.test.mjs tests/knowledge-drafts.test.mjs`; review those files and fix actionable issues before integration.

## Task 3: Agent loop and API integration

Files: create `Workbench/server/knowledge-chat/service.mjs`, `routes.mjs`; modify `Workbench/server/vite-plugin-workbench.mjs`, `Workbench/vite.config.mjs`; tests `Workbench/tests/knowledge-service.test.mjs`, `knowledge-api.test.mjs`.

Interfaces: `createKnowledgeService({getIndex,vaultRoot,store,model,drafts,...})` exposes `run(sessionId,{question,mode,documentIds},{signal,emit})`, returning final saved session. `createKnowledgeRoutes(options)` exposes `matches(req,url)` and `handle(req,res,url)`; includes status/sessions/messages/drafts/preview/commit only. SSE payloads `{type,runId,...}` with text/source/tool/status/draft/done/error types. Model tools only search/read; draft is derived after an evidenced completed answer in organize mode.

- [x] Write tests with injected model transport at the external boundary, real index/store/drafts: tool loop reads evidence and resolves citations, rejects shell tool, handles cancel/timeout/budgets, resumes history, refuses no-source draft. Example: `assert.equal(session.messages.at(-1).sources[0].documentId, fixtureId)`.
- [x] Implement bounded loop, evidence ledger and safe final citation normalization; omit hidden reasoning and untrusted document instructions. Store interrupted state on abort. Source cards are authoritative; unknown model citation IDs are marked unavailable.
- [x] Register exact routes and require local host/origin + JSON mutation requests. Preserve unrelated read-only 403s; test `POST /api/open` stays 403 and unknown chat paths do not bypass protection. Commit flag separate from chat-enabled flag.
- [x] Run `node --test tests/knowledge-service.test.mjs tests/knowledge-api.test.mjs tests/obsidian-api.test.mjs`.

## Task 4: Assistant panel and integration

Files: create `Workbench/src/components/KnowledgeAssistant.jsx`, `KnowledgeDraft.jsx`, `Workbench/src/lib/knowledge-api.js`, `Workbench/src/styles/knowledge-assistant.css`; modify `Workbench/src/App.jsx`, `components/AppShell.jsx`, `components/DocumentDrawer.jsx`; tests `Workbench/tests/knowledge-ui.test.mjs`.

- [x] Write tests for stream event state, Markdown citation links, unsafe URL blocking, draft dirty/review/confirm state and cancellation using exported pure UI helpers. Use rendered React HTML for entry controls where practical, not source-text assertions.
- [x] Build panel with history, new chat, visible mode, context selector, stream/stop, clear failures, source cards, editable draft and distinct preview/confirm stages. All async actions show loading/disabled states; stop/new cancels current run, collapse preserves it; errors never look like model answers.
- [x] Wire visible navigation entry and document context, retain panel across page navigation; responsive full-width on narrow screens. Keep server confirmation token out of model/UI message content.
- [x] Run UI and backend targeted tests, build with Git Bash script-shell; HTTP route render check only (no unrequested browser QA).

## Task 5: Local activation and verification

Files: update `Workbench/.env.example`, `Workbench/README.md`, ignored local `.env` only for opt-in flags; no credential copies.

- [x] Document configuration/limits, distinction between question and confirmed write, transmission disclosure, source citation and newly generated document location.
- [x] Enable `WORKBENCH_KNOWLEDGE_CHAT=true`, `WORKBENCH_KNOWLEDGE_CREATE=true`, `WORKBENCH_KNOWLEDGE_USE_CLAUDE_SETTINGS=true` in local-only override; retain global read-only.
- [x] Run full new test suite, existing relevant suites, production build and privacy scan. Run full original suite and report Windows baseline failures separately.
- [x] Verify live status, entry compilation, synthetic model-backed question and draft preview. Automatic create tests only use temporary synthetic Vault; leave real save to user confirmation. Review full changes, then hand off URL and concise usage.

## Progress

- Design approved. Native gateway synthetic probe returned HTTP 200, SSE tool-use and message_stop; no real documents transmitted.
- No Git repository: local file-based execution and review will be used. Known original Windows test failures were reported before this work.
- Implementation and focused review completed. Review fixes cover interrupted-generation checkpoints, draft retry recovery, cancellation during draft persistence, preserved editor changes, independent create flag, and session-scoped async refresh.
- Final knowledge suite: 58/58 passed. Full repository suite: 203 tests, 198 passed, 5 old-reader-module failures (three Windows symlink permissions, one native watcher assertion, one temporary-directory cleanup race); no knowledge-suite failure. Details: `qa/knowledge-assistant-verification.md`.
- Final build and privacy scan passed. Live status, local entry, both assistant components and search return HTTP 200. Actual configured model passed a synthetic tool loop, draft creation/confirmation and stream cancellation; no real Vault document was created or overwritten.
