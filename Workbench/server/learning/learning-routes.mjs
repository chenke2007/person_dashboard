import { LearningContentError } from "./learning-content-repository.mjs";
import { LearningIngestionError } from "./learning-ingestion-repository.mjs";
import { LearningWorkspaceError } from "./learning-repository.mjs";

const ROOT = "/api/learning";
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
      throw new LearningWorkspaceError("LEARNING_REQUEST_TOO_LARGE", "请求内容超过容量限制。", 413);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new LearningWorkspaceError("LEARNING_INVALID_JSON", "请求内容不是有效 JSON。", 400);
  }
}

function publicError(error) {
  if (error instanceof LearningWorkspaceError || error instanceof LearningContentError || error instanceof LearningIngestionError) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    return { code: error.code, message: error.message, status };
  }
  // Unknown exceptions never leak raw code/status/message: a fixed safe error only.
  return { code: "LEARNING_INTERNAL_ERROR", message: "学习服务暂时不可用。", status: 500 };
}

function requireObject(body, allowed = new Set()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LearningWorkspaceError("LEARNING_INVALID_INPUT", "学习工作区输入格式无效。");
  }
  if (allowed.size && !Object.keys(body).every((key) => allowed.has(key))) {
    throw new LearningWorkspaceError("LEARNING_INVALID_INPUT", "学习工作区输入格式无效。");
  }
  return body;
}

export function createLearningRoutes({ service, ingest = null, readOnly = false, hosted = false } = {}) {
  if (!service) throw new TypeError("learning service is required");

  function requireMutable() {
    if (hosted) throw new LearningWorkspaceError("LEARNING_UNAVAILABLE", "托管模式下学习数据不可用。", 404);
    if (readOnly) throw new LearningWorkspaceError("LEARNING_READ_ONLY", "当前工作区不允许修改学习项目。", 403);
  }

  return {
    matches(_req, url) {
      return url.pathname === ROOT || url.pathname.startsWith(`${ROOT}/`);
    },
    async handle(req, res, url) {
      try {
        const method = req.method || "";
        const route = url.pathname.slice(ROOT.length);
        // Read-only mode still allows an ingestion preview (a pure read that
        // mints no token); every other mutation stays blocked.
        const isIngestPreview = Boolean(
          ingest && method === "POST" && /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/ingestions\/preview$/.test(route),
        );
        if (readOnly && MUTATION_METHODS.includes(method) && !isIngestPreview) {
          throw new LearningWorkspaceError("LEARNING_READ_ONLY", "当前工作区不允许修改学习项目。", 403);
        }

        if (method === "GET" && route === "/capabilities") {
          const capabilities = { ...service.capabilities() };
          if (ingest) capabilities.ingest = ingest.capabilities();
          return sendJson(res, 200, { capabilities });
        }
        if (method === "GET" && route === "") {
          const includeArchived = url.searchParams.get("includeArchived") === "1" || url.searchParams.get("includeArchived") === "true";
          return sendJson(res, 200, await service.list({ includeArchived }));
        }

        // Obsidian ingestion surface: target selection, preview/confirm and
        // history. Matched before the generic workspace routes so suffixed
        // paths never fall through to them.
        const ingestMatch = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(targets|target|ingestions\/preview|ingestions\/confirm|ingestions)$/.exec(route);
        if (ingest && ingestMatch) {
          const [, id, action] = ingestMatch;
          if (method === "GET" && action === "targets") {
            return sendJson(res, 200, await ingest.listTargets({ workspaceId: id }));
          }
          if (method === "POST" && action === "target") {
            requireMutable();
            const body = requireObject(await bodyJson(req), new Set(["vaultId"]));
            return sendJson(res, 200, await ingest.setTarget({ workspaceId: id, vaultId: body.vaultId }));
          }
          if (method === "POST" && action === "ingestions/preview") {
            if (hosted) throw new LearningWorkspaceError("INGESTION_UNAVAILABLE", "托管模式下学习摄取不可用。", 404);
            const body = requireObject(await bodyJson(req), new Set(["selectedContentTypes", "targetVaultId"]));
            return sendJson(res, 200, await ingest.preview({
              workspaceId: id,
              selectedContentTypes: body.selectedContentTypes,
              targetVaultId: body.targetVaultId,
            }));
          }
          if (method === "POST" && action === "ingestions/confirm") {
            requireMutable();
            const body = requireObject(await bodyJson(req), new Set(["token", "conflictResolution"]));
            return sendJson(res, 200, await ingest.confirm({ token: body.token, conflictResolution: body.conflictResolution }));
          }
          if (method === "GET" && action === "ingestions") {
            return sendJson(res, 200, await ingest.listIngestions({ workspaceId: id }));
          }
        }

        if (method === "GET" && WORKSPACE_ID.test(route.slice(1))) {
          return sendJson(res, 200, await service.get(route.slice(1)));
        }
        if (method === "POST" && route === "/drafts") {
          requireMutable();
          const body = requireObject(await bodyJson(req), new Set(["repositoryId", "mission"]));
          return sendJson(res, 201, await service.createDraft({ repositoryId: body.repositoryId, mission: body.mission }));
        }
        if (method === "POST" && route === "/confirm") {
          requireMutable();
          const body = requireObject(await bodyJson(req), new Set(["token"]));
          return sendJson(res, 200, await service.confirm({ token: body.token }));
        }

        const match = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(draft|preview|activate|archive)$/.exec(route);
        if (match) {
          const [, id, action] = match;
          requireMutable();
          if (method === "PATCH" && action === "draft") {
            const body = requireObject(await bodyJson(req), new Set(["expectedRevision", "mission"]));
            return sendJson(res, 200, await service.editDraft({ workspaceId: id, expectedRevision: body.expectedRevision, mission: body.mission }));
          }
          if (method === "POST" && action === "preview") return sendJson(res, 200, await service.preview({ workspaceId: id }));
          if (method === "POST" && action === "activate") {
            const body = requireObject(await bodyJson(req), new Set(["expectedRevision"]));
            return sendJson(res, 200, await service.activate({ workspaceId: id, expectedRevision: body.expectedRevision }));
          }
          if (method === "POST" && action === "archive") return sendJson(res, 200, await service.archive({ workspaceId: id }));
        }

        // Authored content endpoints: plan / notes / artifacts are versioned by
        // the content revision and stay bound to the workspace's fixed source.
        const contentMatch = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(content|plan|notes|artifacts)$/.exec(route);
        if (contentMatch) {
          const [, id, action] = contentMatch;
          if (method === "GET" && action === "content") return sendJson(res, 200, await service.getContent({ workspaceId: id }));
          if (method === "GET" && action === "artifacts") return sendJson(res, 200, await service.listArtifacts({ workspaceId: id }));
          requireMutable();
          if (method === "PATCH" && action === "plan") {
            const body = requireObject(await bodyJson(req), new Set(["expectedRevision", "plan"]));
            return sendJson(res, 200, await service.savePlan({ workspaceId: id, expectedRevision: body.expectedRevision, plan: body.plan }));
          }
          if (method === "PATCH" && action === "notes") {
            const body = requireObject(await bodyJson(req), new Set(["expectedRevision", "notes"]));
            return sendJson(res, 200, await service.saveNotes({ workspaceId: id, expectedRevision: body.expectedRevision, notes: body.notes }));
          }
          if (method === "POST" && action === "artifacts") {
            const body = requireObject(await bodyJson(req), new Set(["expectedRevision", "artifact"]));
            return sendJson(res, 200, await service.addArtifact({ workspaceId: id, expectedRevision: body.expectedRevision, artifact: body.artifact }));
          }
        }

        throw new LearningWorkspaceError("LEARNING_ROUTE_NOT_FOUND", "学习操作不存在。", 404);
      } catch (error) {
        const safe = publicError(error);
        sendJson(res, safe.status, { error: { code: safe.code, message: safe.message } });
      }
    },
  };
}
