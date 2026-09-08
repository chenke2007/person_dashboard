import { RadarRepositoryError } from "./radar-repository.mjs";
import { RadarRoutesError } from "./radar-errors.mjs";

const ROOT = "/api/ai-radar";
const DECISION = /^\/repositories\/([1-9]\d*)\/decision$/;
const PREFERENCE_REVERT = /^\/preferences\/([0-9a-f-]{36})\/revert$/;
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
      throw new RadarRoutesError("RADAR_REQUEST_TOO_LARGE", "请求内容超过容量限制。", 413);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RadarRoutesError("RADAR_INVALID_JSON", "请求内容不是有效 JSON。", 400);
  }
}

function publicError(error) {
  if (error instanceof RadarRepositoryError || error instanceof RadarRoutesError) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    return { code: error.code, message: error.message, status };
  }
  return { code: "RADAR_INTERNAL_ERROR", message: "雷达服务暂时不可用。", status: 500 };
}

export function createRadarRoutes({ repository, scheduler, readOnly = false, capabilities = null } = {}) {
  if (!repository || !scheduler) throw new TypeError("radar repository and scheduler are required");
  const caps = capabilities ?? Object.freeze({ read: true, collect: !readOnly, schedule: !readOnly });
  return {
    matches(_req, url) {
      return url.pathname === ROOT || url.pathname.startsWith(`${ROOT}/`);
    },
    async handle(req, res, url) {
      try {
        const method = req.method || "";
        if (readOnly && MUTATION_METHODS.includes(method)) {
          throw new RadarRoutesError("RADAR_READ_ONLY", "AI 雷达调度在当前工作区不可用。", 403);
        }
        const route = url.pathname.slice(ROOT.length);

        if (method === "GET" && route === "") {
          const dashboard = await repository.getDashboard({
            period: url.searchParams.get("period") || "day",
            state: url.searchParams.get("state") || "all",
            focus: url.searchParams.get("focus") || "all",
          });
          if (dashboard === null || dashboard === undefined) {
            throw new RadarRoutesError("RADAR_UNAVAILABLE", "AI 雷达当前不可用。", 404);
          }
          return sendJson(res, 200, dashboard);
        }

        if (method === "GET" && route === "/status") {
          const status = await scheduler.getStatus();
          if (status === null || status === undefined) {
            return sendJson(res, 200, { running: false, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, error: null });
          }
          return sendJson(res, 200, status);
        }

        if (method === "GET" && route === "/capabilities") {
          return sendJson(res, 200, { capabilities: caps });
        }

        if (method === "POST" && route === "/collect") {
          const result = await scheduler.runNow();
          return sendJson(res, 200, {
            persisted: Boolean(result?.persisted),
            retryAt: result?.retryAt ?? null,
            run: result?.run ?? null,
            error: result?.error ?? null,
          });
        }

        if (method === "PATCH" && route === "/schedule") {
          const patch = await bodyJson(req);
          return sendJson(res, 200, await scheduler.updateSchedule(patch));
        }

        const decision = DECISION.exec(route);
        if (method === "PUT" && decision) {
          const body = await bodyJson(req);
          if (typeof body?.status !== "string") {
            throw new RadarRoutesError("RADAR_INVALID_INPUT", "雷达输入格式无效。");
          }
          return sendJson(res, 200, await repository.setDecision(Number(decision[1]), body.status));
        }

        if (method === "GET" && route === "/preferences") {
          return sendJson(res, 200, await repository.listPreferences());
        }

        if (method === "POST" && route === "/preferences") {
          return sendJson(res, 201, await repository.addPreference(await bodyJson(req)));
        }

        const revert = PREFERENCE_REVERT.exec(route);
        if (method === "POST" && revert) {
          return sendJson(res, 200, await repository.revertPreference(revert[1]));
        }

        if (method === "DELETE" && route === "/preferences") {
          return sendJson(res, 200, await repository.resetPreferences());
        }

        throw new RadarRoutesError("RADAR_ROUTE_NOT_FOUND", "雷达操作不存在。", 404);
      } catch (error) {
        const safe = publicError(error);
        sendJson(res, safe.status, { error: { code: safe.code, message: safe.message } });
      }
    },
  };
}