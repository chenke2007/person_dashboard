import { SummaryRepositoryError } from "./summary-repository.mjs";

const ROOT = "/api/summaries";
const REPOSITORY_ID = /^\/repository\/([1-9]\d*)$/;
const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

async function bodyJson(req, maximum = MAX_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximum) {
      throw new SummaryRepositoryError("SUMMARY_REQUEST_TOO_LARGE", "请求内容超过容量限制。", 413);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new SummaryRepositoryError("SUMMARY_INVALID_JSON", "请求内容不是有效 JSON。", 400);
  }
}

function publicError(error) {
  if (error instanceof SummaryRepositoryError) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    return { code: error.code, message: error.message, status };
  }
  // Unknown exceptions never leak raw code/status/message: a fixed safe error only.
  return { code: "SUMMARY_INTERNAL_ERROR", message: "摘要服务暂时不可用。", status: 500 };
}

function requireObject(body, allowed = new Set()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SummaryRepositoryError("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
  }
  if (allowed.size && !Object.keys(body).every((key) => allowed.has(key))) {
    throw new SummaryRepositoryError("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
  }
  return body;
}

export function createSummaryRoutes({ service, readOnly = false, hosted = false } = {}) {
  if (!service) throw new TypeError("summary service is required");

  function requireMutable() {
    if (hosted) throw new SummaryRepositoryError("SUMMARY_UNAVAILABLE", "托管模式下仓库摘要不可用。", 404);
    if (readOnly) throw new SummaryRepositoryError("SUMMARY_READ_ONLY", "当前工作区不允许生成仓库摘要。", 403);
  }

  return {
    matches(_req, url) {
      return url.pathname === ROOT || url.pathname.startsWith(`${ROOT}/`);
    },
    async handle(req, res, url) {
      try {
        const method = req.method || "";
        if (readOnly && MUTATION_METHODS.includes(method)) {
          throw new SummaryRepositoryError("SUMMARY_READ_ONLY", "当前工作区不允许生成仓库摘要。", 403);
        }
        const route = url.pathname.slice(ROOT.length);

        if (method === "GET" && route === "/capabilities") {
          return sendJson(res, 200, { capabilities: service.summaryCapabilities() });
        }

        if (method === "GET" && route === "") {
          const repositoryId = Number(url.searchParams.get("repositoryId"));
          if (!url.searchParams.has("repositoryId") || !Number.isInteger(repositoryId) || repositoryId <= 0) {
            throw new SummaryRepositoryError("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
          }
          return sendJson(res, 200, await service.listSummaries({ repositoryId }));
        }

        const repositoryMatch = REPOSITORY_ID.exec(route);
        if (method === "GET" && repositoryMatch) {
          return sendJson(res, 200, await service.getSummary({ repositoryId: Number(repositoryMatch[1]) }));
        }

        if (method === "POST" && route === "/generate") {
          requireMutable();
          const body = requireObject(await bodyJson(req), new Set(["repositoryId", "sourceCommitSha", "sourceUrl", "readme"]));
          const result = await service.generateSummary({
            repositoryId: body.repositoryId,
            sourceCommitSha: body.sourceCommitSha,
            sourceUrl: body.sourceUrl,
            readme: body.readme,
          });
          return sendJson(res, 200, result);
        }

        throw new SummaryRepositoryError("SUMMARY_ROUTE_NOT_FOUND", "摘要操作不存在。", 404);
      } catch (error) {
        const safe = publicError(error);
        sendJson(res, safe.status, { error: { code: safe.code, message: safe.message } });
      }
    },
  };
}