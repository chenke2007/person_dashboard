import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createChatStore } from "./store.mjs";
import { createDraftService } from "./drafts.mjs";
import { createKnowledgeService } from "./service.mjs";
import { loadModelConfig, createModelClient } from "./model.mjs";
import { fail, objectKeys, publicError } from "./errors.mjs";
import { getDocument } from "../vault-index.mjs";
import { isObsidianPath, readIndexedFile } from "../obsidian-vault.mjs";

const ROOT = "/api/knowledge-chat";
const SESSION = /^\/sessions\/([a-zA-Z0-9-]+)(?:\/(messages))?$/;
const DRAFT = /^\/sessions\/([a-zA-Z0-9-]+)\/drafts\/([a-zA-Z0-9-]+)\/(revise|preview|commit)$/;
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(body));
}
function visibleSession(value) {
  const result = JSON.parse(JSON.stringify(value, (key, item) => key.startsWith("_") || ["confirmationToken", "expiresAt"].includes(key) ? undefined : item));
  for (const draft of result.drafts || []) {
    if (value.drafts.find((item) => item.id === draft.id)?._commit && !draft.receipt) draft.recoveryPending = true;
  }
  return result;
}
function localRequest(req) {
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { fail("LOCAL_ORIGIN_DENIED", "本地助手拒绝该请求。", 403); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname) || req.headers["sec-fetch-site"] === "cross-site") fail("LOCAL_ORIGIN_DENIED", "仅允许本机访问知识库助手。", 403);
  if (req.headers.origin && req.headers.origin !== host.origin) fail("LOCAL_ORIGIN_DENIED", "本地助手拒绝跨站访问。", 403);
  if (req.method === "POST" && (!req.headers.origin || req.headers.origin !== host.origin)) fail("LOCAL_ORIGIN_DENIED", "操作需要来自本地工作台页面。", 403);
}
async function bodyJson(req) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) fail("INVALID_CONTENT_TYPE", "需要 JSON 请求。", 415);
  const parts = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 256 * 1024) fail("REQUEST_TOO_LARGE", "请求内容过大。", 413); parts.push(chunk); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { fail("INVALID_JSON", "请求不是有效 JSON。"); }
}

export function createKnowledgeRoutes({ vaultRoot, getIndex, notifyPaths, env = process.env, enabled = env.WORKBENCH_KNOWLEDGE_CHAT === "true", createEnabled = env.WORKBENCH_KNOWLEDGE_CREATE === "true", directory, modelConfig, model } = {}) {
  let dependencies;
  async function load() {
    if (!dependencies) dependencies = (async () => {
      const config = modelConfig || await loadModelConfig({ env });
      const vaultId = createHash("sha256").update(path.resolve(vaultRoot).toLowerCase()).digest("hex").slice(0, 24);
      const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
      const store = createChatStore({ directory: directory || path.join(base, "PersonalAIWorkbench", vaultId, "chat") });
      const drafts = createDraftService({ store, vaultRoot, getIndex, notifyPaths, enabled: createEnabled });
      const service = createKnowledgeService({ getIndex, vaultRoot, store, drafts, model: model || createModelClient(config) });
      return { config, store, drafts, service };
    })().catch((error) => { dependencies = undefined; throw error; });
    return dependencies;
  }
  return {
    async close() { if (dependencies) { const value = await dependencies.catch(() => null); value?.service.close(); } },
    matches(req, url) {
      if (!url.pathname.startsWith(ROOT)) return false;
      const route = url.pathname.slice(ROOT.length);
      if (req.method === "GET") return ["/status", "/sessions", "/source"].includes(route) || Boolean(SESSION.exec(route) && !SESSION.exec(route)[2]);
      if (req.method !== "POST") return false;
      return route === "/sessions" || Boolean(SESSION.exec(route)?.[2]) || DRAFT.test(route);
    },
    async handle(req, res, url) {
      try {
        localRequest(req);
        const route = url.pathname.slice(ROOT.length);
        if (!enabled) {
          if (route === "/status") return sendJson(res, 200, { enabled: false, configured: false, createEnabled: false });
          fail("CHAT_DISABLED", "知识库助手尚未启用。", 403);
        }
        const { config, store, drafts, service } = await load();
        if (req.method === "GET" && route === "/status") return sendJson(res, 200, { enabled, configured: Boolean(config.configured), model: config.model || null, createEnabled, transportEncrypted: Boolean(config.transportEncrypted) });
        if (req.method === "GET" && route === "/source") {
          const document = getDocument(await getIndex(), url.searchParams.get("id"));
          if (!document || !isObsidianPath(document.path)) fail("SOURCE_UNAVAILABLE", "来源已不可用。", 404);
          const bytes = await readIndexedFile(vaultRoot, document.path, 64 * 1024 * 1024).catch(() => fail("SOURCE_UNAVAILABLE", "来源已不可用。", 404));
          if (createHash("sha256").update(bytes).digest("hex") !== url.searchParams.get("hash")) fail("SOURCE_CHANGED", "来源已变化，请重新提问或重新检索后查看。", 409);
          return sendJson(res, 200, { id: document.id });
        }
        if (req.method === "GET" && route === "/sessions") return sendJson(res, 200, { items: await store.list() });
        const sessionMatch = SESSION.exec(route);
        if (req.method === "GET" && sessionMatch) return sendJson(res, 200, visibleSession(await service.getSession(sessionMatch[1])));
        const body = await bodyJson(req);
        if (route === "/sessions") { objectKeys(body, []); return sendJson(res, 201, visibleSession(await store.create())); }
        if (sessionMatch?.[2] === "messages") {
          if (!config.configured) fail("MODEL_NOT_CONFIGURED", "模型网关尚未配置。", 503);
          objectKeys(body, ["question", "mode", "documentIds"]);
          const controller = new AbortController();
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff", Connection: "keep-alive" });
          const emit = (event) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event.type === "done" ? { ...event, session: visibleSession(event.session) } : event)}\n\n`); };
          const cancel = () => { if (!res.writableEnded) controller.abort(); };
          res.on("close", cancel);
          try { await service.run(sessionMatch[1], body, { signal: controller.signal, emit }); }
          catch (error) { emit({ type: "error", error: controller.signal.aborted ? { code: "CANCELLED", message: "生成已停止。" } : publicError(error) }); }
          finally { res.off("close", cancel); res.end(); }
          return;
        }
        const draftMatch = DRAFT.exec(route);
        if (draftMatch) {
          const [, sessionId, draftId, action] = draftMatch;
          if (action === "revise") { objectKeys(body, ["title", "category", "body"]); return sendJson(res, 200, await drafts.revise(sessionId, draftId, body)); }
          if (action === "preview") { objectKeys(body, []); return sendJson(res, 200, await drafts.preview(sessionId, draftId)); }
          objectKeys(body, ["version", "confirmationToken"]);
          return sendJson(res, 200, await drafts.commit(sessionId, draftId, body));
        }
        fail("ROUTE_NOT_FOUND", "该操作不存在。", 404);
      } catch (error) { sendJson(res, error.status || 500, { error: publicError(error) }); }
    },
  };
}
