// Shared bounded decoder: fetch streams may split both UTF-8 characters and SSE frames.
export async function consumeSse(body, onEvent, { maxBytes = 1024 * 1024 } = {}) {
  if (!body?.getReader) throw new Error("SSE_BODY_MISSING");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0, complete = false;
  async function drain() {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data && data !== "[DONE]") await onEvent(JSON.parse(data));
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("SSE_TOO_LARGE");
      buffer += decoder.decode(value, { stream: true });
      await drain();
    }
    buffer += decoder.decode();
    await drain();
    if (buffer.trim() && !buffer.trim().startsWith(":")) throw new Error("SSE_TRUNCATED");
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
