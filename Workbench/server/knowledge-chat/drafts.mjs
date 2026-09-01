import path from "node:path";
import { createHash, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { getDocument } from "../vault-index.mjs";
import { extractObsidianText, isObsidianPath, readIndexedFile } from "../obsidian-vault.mjs";
import { fail, objectKeys } from "./errors.mjs";

const CATEGORIES = new Set(["concepts", "references", "questions"]);
const queues = new Map();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function validateContent({ title, category, body }) {
  if (typeof title !== "string" || !title || title.length > 120 || title.startsWith(".") ||
      title.includes("..") || /[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/.test(title) || /[. ]$/.test(title) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(title) ||
      !CATEGORIES.has(category) || typeof body !== "string" || !body.trim() || Buffer.byteLength(body) > 128 * 1024) {
    fail("INVALID_DRAFT", "草稿标题、分类或正文无效；只支持安全文件名和限定分类。");
  }
}

function publicDraft(draft) {
  const { id, title, category, body, sources, version, createdAt, updatedAt, receipt } = draft;
  return structuredClone({ id, title, category, body, sources, version, createdAt, updatedAt, recoveryPending: Boolean(draft._commit && !receipt), ...(receipt ? { receipt } : {}) });
}

function render(draft) {
  const escape = (text) => String(text).replace(/[\\[\]`]/g, "\\$&").replace(/[\r\n]/g, " ");
  const links = draft.sources.map((source) => `- [${escape(source.key)}: ${escape(source.title)}](/${source.path.split("/").map(encodeURIComponent).join("/")}) — 片段 ${source.start}–${source.end}；SHA-256: ${source.hash}`);
  return `# ${draft.title}\n\n> AI 辅助整理草稿；基于所列资料生成，操作前请人工核实。\n\n${draft.body}\n\n## 来源\n\n${links.join("\n")}\n`;
}

function snapshot(draft) {
  validateContent(draft);
  const targetPath = `wiki/${draft.category}/${draft.title}.md`;
  const documentBody = render(draft);
  const snapshotHash = sha256(JSON.stringify({ title: draft.title, category: draft.category, body: draft.body, sources: draft.sources, version: draft.version, path: targetPath, documentBody }));
  return { path: targetPath, documentBody, snapshotHash };
}

function sameToken(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || actual.length !== expected.length || actual.length > 128) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDraftService({ store, vaultRoot, getIndex, notifyPaths, enabled, now = () => new Date() }) {
  const root = path.resolve(vaultRoot);
  const stamp = () => new Date(now()).toISOString();

  function exclusive(sessionId, draftId, operation) {
    const key = `${process.platform === "win32" ? root.toLowerCase() : root}:${sessionId}:${draftId}`;
    const previous = queues.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation).catch((error) => {
      if (error?.status) throw error;
      fail("DRAFT_STORAGE_ERROR", "草稿操作未完成；请恢复会话查看状态。", 500);
    });
    queues.set(key, task);
    task.then(() => { if (queues.get(key) === task) queues.delete(key); }, () => { if (queues.get(key) === task) queues.delete(key); });
    return task;
  }

  function find(session, draftId) {
    const draft = session.drafts.find((item) => item.id === draftId);
    if (!draft) fail("DRAFT_NOT_FOUND", "草稿不存在或不属于此会话。", 404);
    return draft;
  }

  async function updateDraft(sessionId, draftId, mutator) {
    const session = await store.update(sessionId, (current) => { mutator(find(current, draftId)); });
    return find(session, draftId);
  }

  async function validateSources(sources, { checkExcerpt = false } = {}) {
    if (!Array.isArray(sources) || !sources.length) fail("SOURCE_REQUIRED", "没有可用资料，不能创建基于资料的草稿。");
    if (sources.length > 32) fail("SOURCE_UNAVAILABLE", "草稿来源数量超出限制。");
    const index = await getIndex();
    const seen = new Set();
    const result = [];
    for (const source of sources) {
      if (!source || typeof source !== "object" || !/^S[1-9]\d*$/.test(source.key) || seen.has(source.key) ||
          typeof source.documentId !== "string" || typeof source.path !== "string" || typeof source.title !== "string" ||
          source.title.length > 1000 || !/^[a-f0-9]{64}$/.test(source.hash) ||
          !Number.isSafeInteger(source.start) || source.start < 0 || !Number.isSafeInteger(source.end) || source.end <= source.start || source.end - source.start > 8000 ||
          typeof source.excerpt !== "string" || !source.excerpt || source.excerpt.length > 220) {
        fail("SOURCE_UNAVAILABLE", "来源元数据无效。", 409);
      }
      const document = getDocument(index, source.documentId);
      if (!document || document.id !== source.documentId || document.path !== source.path || !isObsidianPath(source.path)) fail("SOURCE_UNAVAILABLE", "来源已不可用或不允许访问。", 409);
      let bytes;
      try { bytes = await readIndexedFile(root, source.path, 64 * 1024 * 1024); }
      catch { fail("SOURCE_UNAVAILABLE", "来源当前无法安全读取。", 409); }
      if (sha256(bytes) !== source.hash) fail("SOURCE_CHANGED", "来源已变更，请重新读取资料并生成草稿。", 409);
      if (checkExcerpt) {
        const parsed = await extractObsidianText(root, source.path, bytes.length);
        if (!parsed.content || source.end > parsed.content.length || parsed.content.slice(source.start, source.end).slice(0, 220) !== source.excerpt) {
          fail("SOURCE_CHANGED", "来源片段与当前资料不一致。", 409);
        }
        let after;
        try { after = await readIndexedFile(root, source.path, 64 * 1024 * 1024); }
        catch { fail("SOURCE_UNAVAILABLE", "来源当前无法安全读取。", 409); }
        if (sha256(after) !== source.hash) fail("SOURCE_CHANGED", "来源在校验期间发生变化。", 409);
      }
      seen.add(source.key);
      result.push({ key: source.key, documentId: source.documentId, path: source.path, title: document.title, hash: source.hash, start: source.start, end: source.end, excerpt: source.excerpt });
    }
    return result;
  }

  async function safeTarget(relativePath, { createParents = false } = {}) {
    const parts = relativePath.split("/");
    if (parts.length !== 3 || parts[0] !== "wiki" || !CATEGORIES.has(parts[1])) fail("DRAFT_UNSAFE_PATH", "入库路径不在允许范围。", 409);
    let cursor = path.parse(root).root;
    // Do not silently resolve a linked root or linked ancestor into a different Vault.
    for (const part of root.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const details = await lstat(cursor);
      if (details.isSymbolicLink() || !details.isDirectory()) fail("DRAFT_UNSAFE_PATH", "入库目录含符号链接或目录联接。", 409);
    }
    const canonical = await realpath(root);
    cursor = root;
    for (const part of parts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      let details;
      try { details = await lstat(cursor); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!createParents) return { absolutePath: path.join(root, ...parts), exists: false };
        try { await mkdir(cursor); } catch (creation) { if (creation.code !== "EEXIST") throw creation; }
        details = await lstat(cursor);
      }
      if (details.isSymbolicLink() || !details.isDirectory()) fail("DRAFT_UNSAFE_PATH", "入库目录含符号链接或目录联接。", 409);
      const resolved = await realpath(cursor), relative = path.relative(canonical, resolved);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) fail("DRAFT_UNSAFE_PATH", "入库目录超出允许范围。", 409);
    }
    const absolutePath = path.join(root, ...parts);
    try {
      const details = await lstat(absolutePath);
      if (details.isSymbolicLink() || !details.isFile()) fail("DRAFT_UNSAFE_PATH", "目标路径不是安全的新文件。", 409);
      return { absolutePath, exists: true, details };
    } catch (error) { if (error.code === "ENOENT") return { absolutePath, exists: false }; throw error; }
  }

  function checkConfirmation(draft, input) {
    objectKeys(input, ["version", "confirmationToken"]);
    const confirmation = draft._confirmation;
    if (!confirmation || !Number.isFinite(Date.parse(confirmation.expiresAt)) || !Number.isSafeInteger(input.version) || input.version !== draft.version || input.version !== confirmation.version ||
        !sameToken(input.confirmationToken, confirmation.token)) fail("DRAFT_CONFIRMATION_INVALID", "确认已失效，请重新预览当前草稿。", 409);
    let current;
    try { current = snapshot(draft); }
    catch { fail("DRAFT_CONFIRMATION_INVALID", "草稿内容发生变化，请重新预览。", 409); }
    if (current.snapshotHash !== confirmation.snapshotHash || current.path !== confirmation.path || current.documentBody !== confirmation.documentBody) {
      fail("DRAFT_CONFIRMATION_INVALID", "草稿内容或路径发生变化，请重新预览。", 409);
    }
    return confirmation;
  }

  async function verifyWrittenFile(draft, confirmation, target) {
    const journal = draft._commit;
    const bodyHash = sha256(confirmation.documentBody);
    if (!target.exists || !journal || journal.phase !== "writing" || journal.path !== confirmation.path || journal.bodyHash !== bodyHash ||
        target.details.dev !== journal.dev || target.details.ino !== journal.ino || target.details.birthtimeMs !== journal.birthtimeMs) {
      fail("DRAFT_WRITE_INCOMPLETE", "先前写入未确认完整，未覆盖目标；请检查该文件。", 409);
    }
    let bytes;
    try { bytes = await readIndexedFile(root, confirmation.path, 256 * 1024); }
    catch { fail("DRAFT_WRITE_INCOMPLETE", "先前写入的文件当前无法安全核验，未覆盖目标。", 409); }
    if (sha256(bytes) !== bodyHash) fail("DRAFT_WRITE_INCOMPLETE", "先前写入内容不完整或已变更，未覆盖目标。", 409);
  }

  async function recordAndNotify(sessionId, draftId, targetPath) {
    const receipt = { path: targetPath, documentId: Buffer.from(targetPath, "utf8").toString("base64url"), indexPending: true };
    await updateDraft(sessionId, draftId, (draft) => { draft.receipt = receipt; draft._commit.phase = "saved"; });
    try { await notifyPaths([targetPath]); }
    catch { return receipt; }
    receipt.indexPending = false;
    await updateDraft(sessionId, draftId, (draft) => { draft.receipt = receipt; });
    return receipt;
  }

  return {
    async create(sessionId, input, { signal } = {}) {
      return exclusive(sessionId, "create", async () => {
        signal?.throwIfAborted();
        objectKeys(input, ["title", "category", "body", "sources"]);
        const content = { title: input.title, category: input.category ?? "concepts", body: input.body };
        validateContent(content);
        const sources = await validateSources(input.sources, { checkExcerpt: true });
        signal?.throwIfAborted();
        const timestamp = stamp();
        const draft = { id: randomUUID(), ...content, sources, version: 1, createdAt: timestamp, updatedAt: timestamp };
        await store.update(sessionId, (session) => {
          signal?.throwIfAborted();
          session.drafts.push(draft);
        });
        return publicDraft(draft);
      }).catch((error) => {
        // Storage/operation wrappers sanitize generic exceptions; retain cancellation identity.
        signal?.throwIfAborted();
        throw error;
      });
    },
    async revise(sessionId, draftId, changes) {
      objectKeys(changes, ["title", "category", "body"]);
      return exclusive(sessionId, draftId, async () => {
        const draft = await updateDraft(sessionId, draftId, (current) => {
          if (current.receipt || current._commit) fail("DRAFT_ALREADY_COMMITTED", "草稿已经保存或正在恢复写入；请新建草稿。", 409);
          const next = { ...current, ...changes };
          validateContent(next);
          Object.assign(current, changes, { version: current.version + 1, updatedAt: stamp() });
          delete current._confirmation;
        });
        return publicDraft(draft);
      });
    },
    async preview(sessionId, draftId) {
      return exclusive(sessionId, draftId, async () => {
        const existing = find(await store.get(sessionId), draftId);
        if (existing.receipt) fail("DRAFT_ALREADY_COMMITTED", "草稿已经保存；请查看保存状态。", 409);
        const recoveryOnly = Boolean(existing._commit);
        let prior;
        let journalSnapshot;
        if (recoveryOnly) {
          // Refresh authorization for the exact previously reviewed file, never a new write.
          prior = checkConfirmation(existing, { version: existing.version, confirmationToken: existing._confirmation?.token });
          journalSnapshot = JSON.stringify(existing._commit);
          await validateSources(existing.sources);
          await verifyWrittenFile(existing, prior, await safeTarget(prior.path));
        }
        const draft = await updateDraft(sessionId, draftId, (current) => {
          if (current.receipt) fail("DRAFT_ALREADY_COMMITTED", "草稿已经保存；请查看保存状态。", 409);
          if (recoveryOnly) {
            checkConfirmation(current, { version: existing.version, confirmationToken: prior.token });
            if (JSON.stringify(current._commit) !== journalSnapshot) fail("DRAFT_WRITE_INCOMPLETE", "保存状态在核验期间变化，请重新核验。", 409);
          } else if (current._commit) fail("DRAFT_WRITE_INCOMPLETE", "保存状态已变化，请重新核验。", 409);
          current._confirmation = { ...(recoveryOnly ? prior : snapshot(current)), token: randomBytes(32).toString("hex"), version: current.version, recoveryOnly, expiresAt: new Date(new Date(now()).getTime() + 30 * 60 * 1000).toISOString() };
        });
        const { token, expiresAt, documentBody, path: targetPath } = draft._confirmation;
        return { ...publicDraft(draft), confirmationToken: token, expiresAt, documentBody, path: targetPath, recoveryOnly };
      });
    },
    async commit(sessionId, draftId, input) {
      return exclusive(sessionId, draftId, async () => {
        if (!(typeof enabled === "function" ? enabled() : enabled)) fail("DRAFT_WRITE_DISABLED", "确认入库功能尚未启用。", 403);
        let draft = find(await store.get(sessionId), draftId);
        const confirmation = checkConfirmation(draft, input);
        if (draft.receipt) return structuredClone(draft.receipt);
        if (new Date(now()).getTime() >= Date.parse(confirmation.expiresAt)) fail("DRAFT_CONFIRMATION_EXPIRED", "确认已过期，请重新预览草稿。", 409);
        await validateSources(draft.sources);
        const target = await safeTarget(confirmation.path);
        const bodyHash = sha256(confirmation.documentBody);
        if (target.exists) {
          if (!draft._commit) fail("DRAFT_PATH_EXISTS", "目标文件已存在，请更换草稿标题。", 409);
          await verifyWrittenFile(draft, confirmation, target);
          return recordAndNotify(sessionId, draftId, confirmation.path);
        }
        if (confirmation.recoveryOnly || draft._commit?.phase === "writing") fail("DRAFT_WRITE_INCOMPLETE", "先前创建的文件已不可用，未再次创建。", 409);
        draft = await updateDraft(sessionId, draftId, (current) => { current._commit = { phase: "intent", path: confirmation.path, bodyHash }; });
        const ready = await safeTarget(confirmation.path, { createParents: true });
        if (ready.exists) fail("DRAFT_PATH_EXISTS", "目标文件已存在，请更换草稿标题。", 409);
        let handle;
        try { handle = await open(ready.absolutePath, "wx", 0o600); }
        catch (error) { if (error.code === "EEXIST") fail("DRAFT_PATH_EXISTS", "目标文件已存在，请更换草稿标题。", 409); throw error; }
        try {
          const details = await handle.stat();
          // Persist ownership before writing; retries require this identity AND exact full bytes.
          await updateDraft(sessionId, draftId, (current) => { current._commit = { phase: "writing", path: confirmation.path, bodyHash, dev: details.dev, ino: details.ino, birthtimeMs: details.birthtimeMs }; });
          await safeTarget(confirmation.path);
          await handle.writeFile(confirmation.documentBody, "utf8");
          await handle.sync();
        } catch (error) {
          if (error?.status) throw error;
          fail("DRAFT_WRITE_INCOMPLETE", "写入中断，未报告保存成功；请检查文件后恢复。", 500);
        } finally { await handle.close(); }
        await safeTarget(confirmation.path);
        const bytes = await readIndexedFile(root, confirmation.path, 256 * 1024);
        if (sha256(bytes) !== bodyHash) fail("DRAFT_WRITE_INCOMPLETE", "写入校验失败，未报告保存成功。", 500);
        return recordAndNotify(sessionId, draftId, confirmation.path);
      });
    },
  };
}
