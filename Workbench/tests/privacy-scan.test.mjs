import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  collectPublishableFiles,
  formatFindings,
  scanRepository,
} from "../scripts/privacy-scan.mjs";

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

test("privacy scan anchors nested Git roots at the repository top level", async () => {
  await withRepository({}, async (repositoryRoot) => {
    const detectFile = path.join(repositoryRoot, "Workbench", "detect.txt");
    await writeFile(detectFile, `${blockedIdentifier()}\n`);
    await run("git", ["add", "Workbench/detect.txt"], repositoryRoot);

    const nestedRoot = path.join(repositoryRoot, "Workbench");
    const files = await collectPublishableFiles(nestedRoot);
    const findings = await scanRepository(nestedRoot);

    assert.ok(files.some((file) => file.relativePath === "Workbench/detect.txt"));
    assert.ok(findings.some((finding) => finding.file === "Workbench/detect.txt"));
  });
});

test("privacy scan refuses a tracked file reached through a linked ancestor", async () => {
  await withRepository({}, async (repositoryRoot) => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "privacy-scan-outside-"));
    const contentRoot = path.join(repositoryRoot, "content");
    try {
      await mkdir(contentRoot);
      await writeFile(path.join(contentRoot, "entry.txt"), "clean\n");
      await run("git", ["add", "content/entry.txt"], repositoryRoot);
      await mkdir(path.join(outsideRoot, "content"));
      await writeFile(
        path.join(outsideRoot, "content", "entry.txt"),
        `${blockedIdentifier()}\n`,
      );
      await rm(contentRoot, { recursive: true, force: true });
      await symlink(path.join(outsideRoot, "content"), contentRoot, "junction");

      const files = await collectPublishableFiles(repositoryRoot);
      const findings = await scanRepository(repositoryRoot);

      assert.equal(files.some((file) => file.relativePath === "content/entry.txt"), false);
      assert.equal(findings.some((finding) => finding.file === "content/entry.txt"), false);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("privacy scan redacts credential values from findings and diagnostics", async () => {
  await withRepository({}, async (repositoryRoot) => {
    const credentialValue = ["synthetic", "value", "123456789"].join("-");
    const credentialName = ["api", "key"].join("_");
    await mkdir(path.join(repositoryRoot, "docs"));
    await writeFile(
      path.join(repositoryRoot, "docs", "credential.txt"),
      `${credentialName}="${credentialValue}"\n`,
    );

    const findings = await scanRepository(repositoryRoot);
    const output = formatFindings(findings);
    const result = await runScanner(repositoryRoot);

    assert.ok(findings.some((finding) => finding.label === "credential-like assignment"));
    assert.equal(output.includes(credentialValue), false);
    assert.equal(result.stderr.includes(credentialValue), false);
  });
});
