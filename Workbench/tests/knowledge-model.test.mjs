import test from "node:test";
import assert from "node:assert/strict";
import { createModelClient, loadModelConfig } from "../server/knowledge-chat/model.mjs";
import { consumeSse } from "../shared/knowledge-sse.mjs";

function stream(events, split = 3) {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new ReadableStream({ start(controller) { for (let n = 0; n < bytes.length; n += split) controller.enqueue(bytes.slice(n, n + split)); controller.close(); } });
}
const config = { url: "https://model.example/v1/messages", token: "synthetic-secret", authKind: "bearer", model: "synthetic-model" };
test("split SSE preserves Chinese UTF-8 and JSON frames", async () => {
  const out = [];
  await consumeSse(stream([{ type: "text", text: "数据库备份" }], 1), (data) => out.push(data));
  assert.deepEqual(out, [{ type: "text", text: "数据库备份" }]);
});
test("model transport assembles tools and text without exposing hidden thinking", async () => {
  let request;
  const client = createModelClient(config, { fetchImpl: async (url, options) => {
    request = { url, ...options };
    return new Response(stream([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "hidden" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hidden2" } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "查找资料" } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "search_documents", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query":' } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"backup"}' } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]), { headers: { "content-type": "text/event-stream" } });
  } });
  let text = "";
  const result = await client.complete({ messages: [{ role: "user", content: "backup" }], tools: [], onText: (chunk) => { text += chunk; } });
  assert.equal(text, "查找资料");
  assert.deepEqual(result.content, [{ type: "text", text: "查找资料" }, { type: "tool_use", id: "t1", name: "search_documents", input: { query: "backup" } }]);
  assert.equal(request.redirect, "error");
  assert.equal(JSON.parse(request.body).stream, true);
  assert.equal(request.headers.authorization, "Bearer synthetic-secret");
});
test("upstream errors and truncated streams fail closed without echoing secrets", async () => {
  const failed = createModelClient(config, { fetchImpl: async () => new Response("synthetic-secret private trace", { status: 401 }) });
  await assert.rejects(failed.complete({ messages: [] }), (e) => e.code === "MODEL_HTTP_ERROR" && !e.message.includes("secret"));
  const truncated = createModelClient(config, { fetchImpl: async () => new Response(stream([{ type: "message_start" }]), { headers: { "content-type": "text/event-stream" } }) });
  await assert.rejects(truncated.complete({ messages: [] }), { code: "MODEL_INCOMPLETE" });
});
test("explicit configuration does not read or require Claude settings", async () => {
  const value = await loadModelConfig({ env: { WORKBENCH_KNOWLEDGE_BASE_URL: "https://model.example/v1", WORKBENCH_KNOWLEDGE_API_KEY: "example", WORKBENCH_KNOWLEDGE_MODEL: "fixture" }, settingsPath: "missing-file" });
  assert.equal(value.url, "https://model.example/v1/messages");
  assert.equal(value.model, "fixture");
  assert.equal((await loadModelConfig({ env: {} })).configured, false);
});
