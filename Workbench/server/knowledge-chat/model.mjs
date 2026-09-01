import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { consumeSse } from "../../shared/knowledge-sse.mjs";
import { fail, KnowledgeError } from "./errors.mjs";

export async function loadModelConfig({ env = process.env, settingsPath = path.join(os.homedir(), ".claude", "settings.json") } = {}) {
  let settings = {};
  if (env.WORKBENCH_KNOWLEDGE_USE_CLAUDE_SETTINGS === "true") {
    try { settings = JSON.parse(await readFile(settingsPath, "utf8")); }
    catch { fail("MODEL_CONFIG_ERROR", "无法读取已授权的本地模型配置。", 503); }
  }
  const local = settings.env || {};
  const base = env.WORKBENCH_KNOWLEDGE_BASE_URL || local.ANTHROPIC_BASE_URL;
  const token = env.WORKBENCH_KNOWLEDGE_API_KEY || local.ANTHROPIC_AUTH_TOKEN || local.ANTHROPIC_API_KEY;
  const model = env.WORKBENCH_KNOWLEDGE_MODEL || settings.model || local.ANTHROPIC_MODEL;
  if (!base || !token || !model) return { configured: false };
  let url;
  try { url = new URL(base); } catch { fail("MODEL_CONFIG_ERROR", "模型网关地址无效。", 503); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail("MODEL_CONFIG_ERROR", "模型网关地址无效。", 503);
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = prefix.endsWith("/v1") ? `${prefix}/messages` : `${prefix}/v1/messages`;
  return { configured: true, url: url.href, token, model, authKind: env.WORKBENCH_KNOWLEDGE_API_KEY || (!local.ANTHROPIC_AUTH_TOKEN && local.ANTHROPIC_API_KEY) ? "key" : "bearer", transportEncrypted: url.protocol === "https:" };
}

export function createModelClient(config, { fetchImpl = fetch } = {}) {
  return {
    async complete({ messages, system = "", tools = [], signal, onText = () => {} }) {
      if (!config?.url || !config.token || !config.model) fail("MODEL_NOT_CONFIGURED", "请先配置模型网关。", 503);
      try {
        const response = await fetchImpl(config.url, {
          method: "POST", redirect: "error", signal,
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(config.authKind === "key" ? { "x-api-key": config.token } : { authorization: `Bearer ${config.token}` }) },
          body: JSON.stringify({ model: config.model, max_tokens: 8192, stream: true, system, tools, messages }),
        });
        if (!response.ok) { await response.body?.cancel(); fail("MODEL_HTTP_ERROR", `模型服务返回 HTTP ${response.status}，请检查连接或授权。`, 502); }
        if (!response.headers.get("content-type")?.includes("text/event-stream")) { await response.body?.cancel(); fail("MODEL_PROTOCOL_ERROR", "模型网关未返回兼容的流式响应。", 502); }
        const blocks = new Map(), inputs = new Map();
        let finished = false, stopReason = null;
        await consumeSse(response.body, async (event) => {
          if (event.type === "error") fail("MODEL_STREAM_ERROR", "模型服务中断了响应，请重试。", 502);
          if (event.type === "content_block_start") {
            const block = event.content_block;
            if (block?.type === "text") {
              blocks.set(event.index, { type: "text", text: String(block.text || "") });
              if (block.text) onText(block.text);
            } else if (block?.type === "tool_use") blocks.set(event.index, { type: "tool_use", id: block.id, name: block.name, input: block.input || {} });
          }
          if (event.type === "content_block_delta") {
            const block = blocks.get(event.index);
            if (block?.type === "text" && event.delta?.type === "text_delta") { block.text += event.delta.text; onText(event.delta.text); }
            if (block?.type === "tool_use" && event.delta?.type === "input_json_delta") inputs.set(event.index, (inputs.get(event.index) || "") + event.delta.partial_json);
          }
          if (event.type === "message_delta") stopReason = event.delta?.stop_reason || stopReason;
          if (event.type === "message_stop") finished = true;
        });
        if (!finished || !["tool_use", "end_turn", "stop_sequence"].includes(stopReason)) fail("MODEL_INCOMPLETE", "模型响应未完整结束，未生成可入库草稿。", 502);
        for (const [index, json] of inputs) if (json.trim()) blocks.get(index).input = JSON.parse(json);
        const content = [...blocks.values()];
        if (!content.length) fail("MODEL_EMPTY", "模型未返回正文或有效工具调用。", 502);
        return { content, stopReason };
      } catch (error) {
        if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
        if (error instanceof KnowledgeError) throw error;
        fail("MODEL_CONNECTION_ERROR", "模型连接或响应解析失败，请检查网关后重试。", 502);
      }
    },
  };
}
