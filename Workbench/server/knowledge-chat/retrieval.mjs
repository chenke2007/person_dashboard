import { createHash } from "node:crypto";
import { getDocument, searchIndex } from "../vault-index.mjs";
import { extractObsidianText, isObsidianPath, readIndexedFile } from "../obsidian-vault.mjs";
import { fail } from "./errors.mjs";

const STOP_WORDS = new Set(["请问", "帮我", "查找", "资料", "相关", "根据", "如何", "怎么", "我的", "这个", "哪些", "需要", "进行", "整理", "生成", "文档", "知识库", "所有"]);
export function createEvidenceContext({ getIndex, vaultRoot }) {
  const evidence = [], cache = new Map();
  let consumed = 0;
  return {
    sources: () => structuredClone(evidence),
    async search(query) {
      if (typeof query !== "string" || !query.trim() || query.length > 1000) fail("INVALID_TOOL_INPUT", "检索关键词无效。");
      const index = await getIndex();
      const terms = [...new Set([...new Intl.Segmenter("zh", { granularity: "word" }).segment(query)].filter((part) => part.isWordLike && part.segment.length >= 2 && !STOP_WORDS.has(part.segment)).map((part) => part.segment))].slice(0, 10);
      const queries = [query, ...terms];
      const merged = new Map();
      for (const [position, term] of queries.entries()) {
        for (const hit of searchIndex(index, term, { limit: 60 })) {
          if (!isObsidianPath(hit.path)) continue;
          const prior = merged.get(hit.id);
          merged.set(hit.id, { ...hit, rank: (prior?.rank || 0) + 100 + hit.score + (position === 0 ? 500 : 0) });
        }
      }
      return [...merged.values()].sort((a, b) => b.rank - a.rank).slice(0, 12).map(({ id, title, path, snippet }) => ({ id, title, path, snippet: String(snippet || "").slice(0, 420) }));
    },
    async read(documentId, start = 0, length = 8000) {
      if (typeof documentId !== "string" || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1 || length > 8000) fail("INVALID_TOOL_INPUT", "文档读取范围无效。");
      const document = getDocument(await getIndex(), documentId);
      if (!document || !isObsidianPath(document.path)) fail("SOURCE_UNAVAILABLE", "资料不存在或不允许访问。", 404);
      let entry = cache.get(document.id);
      if (!entry) {
        try {
          const buffer = await readIndexedFile(vaultRoot, document.path, 64 * 1024 * 1024);
          const hash = createHash("sha256").update(buffer).digest("hex");
          const parsed = await extractObsidianText(vaultRoot, document.path, buffer.length);
          const after = await readIndexedFile(vaultRoot, document.path, 64 * 1024 * 1024);
          if (createHash("sha256").update(after).digest("hex") !== hash) fail("SOURCE_CHANGED", "资料在读取期间发生变化，请重试。", 409);
          if (!parsed.content) fail("SOURCE_NO_TEXT", "该资料没有可提取正文，请选择其他资料。");
          entry = { hash, text: parsed.content, status: parsed.contentStatus };
          cache.set(document.id, entry);
        } catch (error) {
          if (error?.status) throw error;
          fail("SOURCE_UNAVAILABLE", "资料当前无法安全读取。", 404);
        }
      }
      if (start >= entry.text.length) fail("INVALID_TOOL_INPUT", "读取起点超出文档正文。");
      const text = entry.text.slice(start, start + length);
      if (consumed + text.length > 64000) fail("EVIDENCE_LIMIT", "本轮资料读取额度已用完，请缩小问题范围。");
      consumed += text.length;
      let source = evidence.find((item) => item.documentId === document.id && item.start === start && item.end === start + text.length);
      if (!source) {
        source = { key: `S${evidence.length + 1}`, documentId: document.id, title: document.title, path: document.path, hash: entry.hash, start, end: start + text.length, excerpt: text.slice(0, 220) };
        evidence.push(source);
      }
      return { ...source, text, totalLength: entry.text.length, contentStatus: entry.status };
    },
  };
}
