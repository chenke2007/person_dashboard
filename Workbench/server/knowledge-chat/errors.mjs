export class KnowledgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function fail(code, message, status = 400) { throw new KnowledgeError(code, message, status); }
export function publicError(error) {
  return error instanceof KnowledgeError || (error?.code?.startsWith("KNOWLEDGE_") && error.status)
    ? { code: error.code, message: error.message }
    : { code: "KNOWLEDGE_ERROR", message: "知识库助手暂时无法完成操作，请重试。" };
}
export function objectKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail("INVALID_INPUT", "请求字段无效。");
}
