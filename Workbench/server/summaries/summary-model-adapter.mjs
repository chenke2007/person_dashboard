import { SUMMARY_MODEL_CODES, SUMMARY_SYSTEM_PROMPT, README_MAX_CHARS, SummaryModelError } from "./summary-model.mjs";

// First concrete adapter: an Anthropic-compatible non-streaming /v1/messages
// request fed by the same gateway env the knowledge assistant uses
// (WORKBENCH_KNOWLEDGE_BASE_URL / API_KEY / MODEL). It is fully independent of
// the knowledge-chat module per the privacy boundary: it reuses the gateway
// protocol shape, not its modules. Config lives in this adapter, never in the
// summary domain module.

function fail(code, message, status = 502) {
  throw new SummaryModelError(code, message, status);
}

function cleanConfig(env, settings) {
  const base = env?.WORKBENCH_KNOWLEDGE_BASE_URL ?? settings?.baseUrl ?? null;
  const token = env?.WORKBENCH_KNOWLEDGE_API_KEY ?? settings?.apiKey ?? null;
  const model = env?.WORKBENCH_KNOWLEDGE_MODEL ?? settings?.model ?? null;
  if (!base || !token || !model) return { configured: false };
  let url;
  try { url = new URL(base); } catch { return { configured: false }; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail("SUMMARY_MODEL_CONFIG_ERROR", "模型网关地址无效。", 503);
  }
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = prefix.endsWith("/v1") ? `${prefix}/messages` : `${prefix}/v1/messages`;
  return { configured: true, url: url.href, token, model, authKind: "key" };
}

// Extracts the first balanced JSON object from model text. Tolerates markdown
// fences and surrounding prose the way a JSON-mode-free API can produce them;
// anything unbalanced or missing fails as an invalid output.
function extractJson(text) {
  const source = String(text ?? "");
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

export function createSummaryModelAdapter({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 45_000,
  settings = null,
} = {}) {
  if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    fail("SUMMARY_MODEL_CONFIG_ERROR", "模型适配器依赖无效。", 503);
  }
  let config = null;
  const current = () => {
    if (!config) config = cleanConfig(env, settings || null);
    return config;
  };

  return {
    capabilities() {
      // Local config check only; never pings the model network.
      const value = current();
      return {
        configured: value.configured,
        providerId: value.configured ? "anthropic-compatible" : null,
        modelId: value.configured ? value.model : null,
      };
    },
    async generate({ repository = null, readme = null, system = SUMMARY_SYSTEM_PROMPT } = {}) {
      const value = current();
      if (!value.configured) fail(SUMMARY_MODEL_CODES.NOT_CONFIGURED, "尚未配置摘要模型。", 503);
      if (!repository || typeof repository !== "object" || Array.isArray(repository)) fail("SUMMARY_MODEL_INVALID_INPUT", "仓库输入无效。", 502);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        const userData = JSON.stringify({
          task: "根据仓库元数据与 README 生成结构化中文摘要。",
          repository: {
            fullName: String(repository.fullName ?? "").slice(0, 240),
            description: String(repository.description ?? "").slice(0, 500),
            language: repository.language ?? null,
            topics: Array.isArray(repository.topics) ? repository.topics.slice(0, 20) : [],
            stars: repository.stars ?? null,
            license: repository.license ?? null,
            defaultBranch: repository.defaultBranch ?? null,
            archived: Boolean(repository.archived),
          },
          readme: readme && typeof readme === "object"
            ? { path: String(readme.path ?? "").slice(0, 240), content: String(readme.content ?? "").slice(0, README_MAX_CHARS) }
            : null,
        });
        response = await fetchImpl(value.url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": value.token,
          },
          body: JSON.stringify({
            model: value.model,
            max_tokens: 4_096,
            system,
            messages: [{ role: "user", content: userData }],
          }),
        });
      } catch (error) {
        if (controller.signal.aborted) fail(SUMMARY_MODEL_CODES.CALL_FAILED, "模型请求超时，请重试。", 502);
        fail(SUMMARY_MODEL_CODES.CALL_FAILED, "模型连接失败，请检查网关后重试。", 502);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        fail(SUMMARY_MODEL_CODES.CALL_FAILED, `模型服务返回 HTTP ${response.status}，请检查连接或授权。`, 502);
      }
      const declared = response.headers.get("content-length");
      if (declared && /^\d+$/.test(declared) && Number(declared) > 4 * 1024 * 1024) {
        await response.body?.cancel().catch(() => {});
        fail(SUMMARY_MODEL_CODES.INVALID_OUTPUT, "模型响应超过容量限制，已拒绝保存。", 502);
      }
      const chunks = [];
      let size = 0;
      try {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) { await reader.cancel().catch(() => {}); fail(SUMMARY_MODEL_CODES.INVALID_OUTPUT, "模型响应超过容量限制，已拒绝保存。", 502); }
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        if (controller.signal.aborted) fail(SUMMARY_MODEL_CODES.CALL_FAILED, "模型请求超时，请重试。", 502);
        fail(SUMMARY_MODEL_CODES.CALL_FAILED, "模型响应读取失败，请重试。", 502);
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        fail(SUMMARY_MODEL_CODES.INVALID_OUTPUT, "模型响应不是有效 JSON，已拒绝保存。", 502);
      }
      const text = Array.isArray(parsed?.content)
        ? parsed.content.find((block) => block && block.type === "text")?.text ?? ""
        : "";
      const json = extractJson(text);
      let content;
      try {
        content = json ? JSON.parse(json) : null;
      } catch {
        fail(SUMMARY_MODEL_CODES.INVALID_OUTPUT, "模型输出无法解析为结构化摘要，已拒绝保存。", 502);
      }
      if (!content || typeof content !== "object" || Array.isArray(content)) {
        fail(SUMMARY_MODEL_CODES.INVALID_OUTPUT, "模型输出缺少结构化摘要，已拒绝保存。", 502);
      }
      return { content, providerId: "anthropic-compatible", modelId: value.model };
    },
  };
}