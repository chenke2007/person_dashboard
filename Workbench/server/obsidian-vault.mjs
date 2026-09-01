import path from "node:path";
import { readFile, lstat, realpath } from "node:fs/promises";
import XLSX from "xlsx";

const PLUGIN_FOLDERS = new Set(["agents", "bin", "commands", "docs", "hooks", "scripts", "skills", "tests", "_templates"]);
const EXCLUDED_FOLDERS = new Set(["node_modules", "__pycache__", "site-packages", "venv", "dist", "build", "sessions", "xshell_sessions", "plsql_connections"]);
const PLUGIN_FILES = new Set(["agents.md", "claude.md", "gemini.md", "readme.md", "wiki.md", "changelog.md", "attribution.md", "contributing.md", "code_of_conduct.md", "privacy.md", "security.md", "license", "makefile", "codeowners", "citation.cff"]);
const PRIVATE_OR_EXECUTABLE = /\.(?:pyc|pyo|exe|dll|rpm|msi|so|dylib|key|pem|p12|pfx|connections|xsh)$/i;
const TEXT_EXTENSIONS = new Set(["md", "txt", "sql", "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd", "py", "js", "mjs", "cjs", "ts", "json", "yml", "yaml", "xml", "html", "htm", "css", "conf", "cfg", "ini", "properties", "j2", "tmpl", "rst", "csv", "tsv", "log", "cs", "c", "h", "cpp", "java", "pl", "r", "rb", "go", "psql", "ctl", "par", "ora", "~sql"]);
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_OFFICE_BYTES = 64 * 1024 * 1024;

export function isObsidianPath(relativePath) {
  const parts = relativePath.split("/");
  if (!parts.length || parts.some((part, i) => !part || part === ".." || part === "." || (part.startsWith(".") && !(i === 0 && part === ".raw")))) return false;
  if (PLUGIN_FOLDERS.has(parts[0].toLowerCase())) return false;
  if (parts.some((part) => EXCLUDED_FOLDERS.has(part.toLowerCase()))) return false;
  const name = parts.at(-1).toLowerCase();
  if (parts.length === 1 && PLUGIN_FILES.has(name)) return false;
  if (/^(?:credentials|secrets)(?:\.|$)/i.test(name) || /^(?:id_rsa|id_ed25519)(?:\.|$)/i.test(name)) return false;
  if (PRIVATE_OR_EXECUTABLE.test(name) || /^~\$/.test(name) || /\.(?:tmp|swp|swo|part)$/i.test(name)) return false;
  return true;
}

export function obsidianMaterialPath(relativePath) {
  if (relativePath.startsWith("10_raw/")) return relativePath;
  if (relativePath.startsWith(".raw/")) return `10_raw/原始资料/${relativePath.slice(5)}`;
  return `10_raw/其他文档/${relativePath}`;
}

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer);
  if (buffer.subarray(0, 8192).includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { return new TextDecoder("gb18030").decode(buffer); }
}

// The caller supplies an indexed path, never an arbitrary request path. Recheck
// every segment so replacing a file/directory with a link cannot escape the Vault.
export async function readIndexedFile(vaultRoot, relativePath, maximumBytes = MAX_TEXT_BYTES) {
  if (path.win32.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.includes("\0") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("UNSAFE_FILE_PATH");
  const root = await realpath(vaultRoot);
  let candidate = root;
  for (const part of relativePath.split("/")) {
    candidate = path.join(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error("SYMLINK_SKIPPED");
  }
  const details = await lstat(candidate);
  if (!details.isFile() || details.size > maximumBytes) throw new Error("FILE_TOO_LARGE_OR_UNAVAILABLE");
  const data = await readFile(candidate);
  if (data.length > maximumBytes) throw new Error("FILE_TOO_LARGE_OR_UNAVAILABLE");
  return data;
}

export async function extractObsidianText(vaultRoot, relativePath, sizeBytes) {
  const extension = path.posix.extname(relativePath).slice(1).toLowerCase();
  const isOffice = ["doc", "docx", "pdf", "xlsx", "xls"].includes(extension);
  const maximumBytes = isOffice ? MAX_OFFICE_BYTES : MAX_TEXT_BYTES;
  if (extension && !TEXT_EXTENSIONS.has(extension) && !isOffice) return { content: null, contentStatus: "metadata_only" };
  if (sizeBytes > maximumBytes) return { content: null, contentStatus: "too_large" };
  try {
    const buffer = await readIndexedFile(vaultRoot, relativePath, maximumBytes);
    let content;
    if (extension === "doc" || extension === "docx") {
      const { default: WordExtractor } = await import("word-extractor");
      const document = await new WordExtractor().extract(buffer);
      content = [document.getBody(), document.getFootnotes(), document.getEndnotes(), document.getHeaders(), document.getTextboxes()].filter(Boolean).join("\n\n");
    } else if (extension === "pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 });
      try { content = (await parser.getText()).pages.map((page) => page.text).join("\n\n"); }
      finally { await parser.destroy(); }
    } else if (extension === "xlsx" || extension === "xls") {
      const book = XLSX.read(buffer, { type: "buffer" });
      content = book.SheetNames.map((name) => `${name}\n${XLSX.utils.sheet_to_csv(book.Sheets[name])}`).join("\n\n");
    } else {
      content = decodeText(buffer);
    }
    if (content == null) return { content: null, contentStatus: "metadata_only" };
    if (!content.trim()) return { content: null, contentStatus: "no_text" };
    if (content.length > MAX_TEXT_BYTES) return { content: content.slice(0, MAX_TEXT_BYTES), contentStatus: "truncated" };
    return { content, contentStatus: "ready" };
  } catch {
    return { content: null, contentStatus: "extraction_failed" };
  }
}
