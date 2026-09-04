# Post merge fixture repair report

## Root cause

On Windows, `os.tmpdir()` can return a path containing an 8.3 short name. The project API fixture passed that path directly to `mkdtemp`, and Vite's file watcher then aborted in `fs-event.c` while watching the resulting tree. The canonical path from `realpath(os.tmpdir())` does not contain the short alias.

## Change

`Workbench/tests/project-api.test.mjs` now resolves `os.tmpdir()` through `realpath` before calling `mkdtemp`. It also asserts that the created fixture root is canonical. No production code, dependency, API behavior, security assertion, or fixture case was changed.

## Verification

- `node --test tests/project-api.test.mjs` (run 1): 13 passed, 0 failed, 0 cancelled, 0 skipped; duration 384568.5839 ms.
- `node --test tests/project-api.test.mjs` (run 2): 13 passed, 0 failed, 0 cancelled, 0 skipped; duration 453997.3592 ms.
- `git diff --check`: passed (only Git's line-ending normalization warning was emitted).

Both focused runs completed successfully, including the Vite watcher setup and teardown exercised by every fixture. The runs were unusually slow during cleanup, but neither produced the reproduced Windows assertion failure.

## Commit

The one-file fixture repair is committed in the scoped commit recorded below. The report is added in the immediately following documentation commit because this directory is ignored by the repository's general artifact rules.

Fixture commit: a44b84d (`test: canonicalize project API fixture temp root`)

## Concerns

The focused test remains slow on this host, especially during watcher teardown. The full merged release gate was intentionally not run here; the controller will run it after integrating this commit.
