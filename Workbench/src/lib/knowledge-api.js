import { consumeSse } from "../../shared/knowledge-sse.mjs";
const ROOT = "/api/knowledge-chat";
export async function knowledgeRequest(route, body, signal) {
  const response = await fetch(ROOT + route, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal || AbortSignal.timeout(route.endsWith("/commit") ? 180000 : 45000) });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("无法连接本地知识库助手，请确认工作台已启动。"); }
  if (!response.ok) throw new Error(payload.error?.message || "请求未完成，请重试。");
  return payload;
}
export async function streamQuestion(sessionId, body, signal, onEvent) {
  const response = await fetch(`${ROOT}/sessions/${encodeURIComponent(sessionId)}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error?.message || "问答暂不可用。"); }
  let ended = false;
  await consumeSse(response.body, (event) => { if (["done", "error"].includes(event.type)) ended = true; onEvent(event); }, { maxBytes: 6 * 1024 * 1024 });
  if (!ended) throw new Error("连接中断，回复未完成，请重试。");
}
