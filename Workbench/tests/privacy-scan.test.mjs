import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const scannerSource = new URL("../scripts/privacy-scan.mjs", import.meta.url);

function blockedIdentifier() {
  return ["Media", "Content", "Vault"].join("");
}

async function run(command, args, cwd) {
  return execFile(command, args, { cwd });
}

async function runScanner(repositoryRoot) {
  try {
    const result = await run(
      process.execPath,
      ["Workbench/scripts/privacy-scan.mjs"],
      repositoryRoot,
    );
    return { status: 0, ...result };
  } catch (error) {
    return {
      status: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function createRepository({ initializeGit = true } = {}) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "privacy-scan-"));
  await mkdir(path.join(repositoryRoot, "Workbench", "scripts"), { recursive: true });
  await cp(scannerSource, path.join(repositoryRoot, "Workbench", "scripts", "privacy-scan.mjs"));

  if (initializeGit) {
    await run("git", ["init", "--quiet"], repositoryRoot);
    await run("git", ["add", "Workbench/scripts/privacy-scan.mjs"], repositoryRoot);
  }

  return repositoryRoot;
}

async function withRepository(options, body) {
  const repositoryRoot = await createRepository(options);
  try {
    await body(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

test("privacy scan rejects blocked content in an ordinary publishable file", async () => {
  await withRepository({}, async (repositoryRoot) => {
    await mkdir(path.join(repositoryRoot, "docs"));
    await writeFile(
      path.join(repositoryRoot, "docs", "example.txt"),
      `${blockedIdentifier()}\n`,
    );

    const result = await runScanner(repositoryRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/example\.txt/);
  });
});

test("privacy scan skips an ignored nested checkout that contains a scanner copy", async () => {
  await withRepository({}, async (repositoryRoot) => {
    await writeFile(path.join(repositoryRoot, ".gitignore"), ".worktrees/\n");
    await run("git", ["add", ".gitignore"], repositoryRoot);
    const nestedScanner = path.join(
      repositoryRoot,
      ".worktrees",
      "local-copy",
      "Workbench",
      "scripts",
      "privacy-scan.mjs",
    );
    await mkdir(path.dirname(nestedScanner), { recursive: true });
    await cp(scannerSource, nestedScanner);

    const result = await runScanner(repositoryRoot);

    assert.equal(result.status, 0, result.stderr);
  });
});

test("privacy scan checks force-tracked content under an otherwise ignored path", async () => {
  await withRepository({}, async (repositoryRoot) => {
    await writeFile(path.join(repositoryRoot, ".gitignore"), ".worktrees/\n");
    const trackedFile = path.join(repositoryRoot, ".worktrees", "published", "blocked.txt");
    await mkdir(path.dirname(trackedFile), { recursive: true });
    await writeFile(trackedFile, `${blockedIdentifier()}\n`);
    await run("git", ["add", ".gitignore"], repositoryRoot);
    await run("git", ["add", "--force", ".worktrees/published/blocked.txt"], repositoryRoot);

    const result = await runScanner(repositoryRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.worktrees\/published\/blocked\.txt/);
  });
});

test("privacy scan keeps a clean standalone source archive eligible", async () => {
  await withRepository({ initializeGit: false }, async (repositoryRoot) => {
    const result = await runScanner(repositoryRoot);

    assert.equal(result.status, 0, result.stderr);
  });
});

test("privacy scan checks ordinary files in a standalone source archive", async () => {
  await withRepository({ initializeGit: false }, async (repositoryRoot) => {
    await mkdir(path.join(repositoryRoot, "docs"));
    await writeFile(
      path.join(repositoryRoot, "docs", "blocked.txt"),
      `${blockedIdentifier()}\n`,
    );

    const result = await runScanner(repositoryRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/blocked\.txt/);
  });
});
