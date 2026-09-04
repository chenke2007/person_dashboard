import { execFile as execFileCallback } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const workbenchRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(workbenchRoot, "..");
const excludedDirectories = new Set([".git", "dist", "node_modules", "qa"]);
const excludedFiles = new Set([
  "Workbench/package-lock.json",
  "Workbench/scripts/privacy-scan.mjs",
]);
const binaryExtensions = new Set([
  ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".webp",
]);

const checks = [
  {
    label: "absolute macOS home path",
    expression: /\/Users\/[^/\s"'`<>]+/g,
  },
  {
    label: "private Vault or product identifier",
    expression: /MediaContentVault|OBSIDIAN\/MediaContentVault|小戴AI|小戴一直在学习/g,
  },
  {
    label: "credential-like assignment",
    expression: /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\n]{8,}["']/gi,
  },
  {
    label: "private key material",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
];

function toRelativePath(root, absolutePath) {
  const relativePath = path.relative(root, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath.split(path.sep).join("/");
}

async function collectFile(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return null;

  const absolutePath = path.resolve(root, relativePath);
  const normalizedRelativePath = toRelativePath(root, absolutePath);
  if (!normalizedRelativePath || excludedFiles.has(normalizedRelativePath)) return null;
  if (binaryExtensions.has(path.extname(normalizedRelativePath).toLowerCase())) return null;

  let details;
  try {
    details = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!details.isFile() || details.size > 5 * 1024 * 1024) return null;

  return { absolutePath, relativePath: normalizedRelativePath };
}

async function collectFallbackFiles(directory, root) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".DS_Store")) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        files.push(...await collectFallbackFiles(absolutePath, root));
      }
      continue;
    }
    const relativePath = toRelativePath(root, absolutePath);
    if (!relativePath) continue;
    const file = await collectFile(root, relativePath);
    if (file) files.push(file);
  }
  return files;
}

async function collectGitFiles(root) {
  let insideWorkTree;
  try {
    ({ stdout: insideWorkTree } = await execFile(
      "git",
      ["-C", root, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8" },
    ));
  } catch {
    return null;
  }
  if (insideWorkTree.trim() !== "true") return null;

  const { stdout } = await execFile(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--full-name",
      "-z",
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const files = await Promise.all(
    stdout
      .split("\0")
      .filter(Boolean)
      .map((relativePath) => collectFile(root, relativePath)),
  );
  return files.filter(Boolean);
}

export async function collectPublishableFiles(root = repositoryRoot) {
  const gitFiles = await collectGitFiles(root);
  return gitFiles ?? collectFallbackFiles(root, root);
}

export async function scanRepository(root = repositoryRoot) {
  const findings = [];
  for (const file of await collectPublishableFiles(root)) {
    const source = await readFile(file.absolutePath, "utf8");
    for (const check of checks) {
      check.expression.lastIndex = 0;
      for (const match of source.matchAll(check.expression)) {
        const line = source.slice(0, match.index).split("\n").length;
        findings.push({
          file: file.relativePath,
          line,
          label: check.label,
          sample: match[0].slice(0, 120),
        });
      }
    }
  }
  return findings;
}

export function formatFindings(findings) {
  if (findings.length === 0) {
    return "Privacy scan passed: no blocked personal identifiers or credential assignments found.\n";
  }
  return [
    "Privacy scan failed:",
    ...findings.map((finding) =>
      `- ${finding.file}:${finding.line} [${finding.label}] ${finding.sample}`,
    ),
    "",
  ].join("\n");
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const findings = await scanRepository();
  const output = formatFindings(findings);
  if (findings.length > 0) {
    process.stderr.write(output);
    process.exitCode = 1;
  } else {
    process.stdout.write(output);
  }
}
