# AI Radar and Learning Loop Implementation Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement these plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved first release as three independently reviewable increments: reliable local state, GitHub AI radar, and repository summary plus learning entry.

**Architecture:** Each increment has its own implementation plan and produces working software. Execute them in order because later plans consume the local state registry, backup provider interface, and HTTP integration seam established earlier.

**Tech Stack:** Node.js ESM, React 19, Vite 6, Zod 3, Node test runner, GitHub REST API.

**Spec:** `docs/superpowers/specs/2026-09-02-ai-radar-learning-loop-design.md`

## Global Constraints

- Keep the application loopback-only by default.
- Do not depend on Codex scheduling, Windows Task Scheduler, or another operating-system scheduler.
- Missing GitHub history remains missing; never manufacture star deltas.
- GitHub repository content is untrusted input and must never become an instruction or execute automatically.
- GitHub and model credentials stay in ignored local configuration and never enter backups, logs, Vault content, fixtures, or tracked files.
- Public hosted builds hide local collection, learning, and mutation routes.
- Tests and demos use only fully synthetic repositories, metrics, paths, and learning content.
- Run `npm test`, `npm run build`, and `npm run privacy:scan` before publishing.

---

## Execution Order

1. [`2026-09-02-workbench-reliability-foundation.md`](./2026-09-02-workbench-reliability-foundation.md)
   - Cross-platform release gate and stable start documentation.
   - Task restore.
   - Versioned state providers, unified backup/restore, and Vault rebind.
2. [`2026-09-02-ai-radar-core.md`](./2026-09-02-ai-radar-core.md)
   - GitHub discovery, snapshots, ranking, retention, in-process scheduling, routes, and UI.
3. [`2026-09-02-repository-learning-entry.md`](./2026-09-02-repository-learning-entry.md)
   - Optional model summaries, fixed commit SHA, learning workspaces, queue limits, and UI.

Each plan ends with its own release gate and commit. Do not begin a later plan while an earlier plan has failing tests or unresolved review findings.
