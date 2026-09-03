import { MAX_WORKSPACE_BACKUP_BYTES } from "./backup-schema.mjs";

const ROOT = "/api/workspace/";

class WorkspaceRouteError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "WorkspaceRouteError";
    this.code = code;
    this.status = status;
  }
}
function requireObject(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceRouteError("INVALID_WORKSPACE_REQUEST", "请求必须是 JSON 对象。", 400);
  }
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new WorkspaceRouteError("INVALID_WORKSPACE_REQUEST", "请求包含不支持的字段。", 400);
  }
  return value;
}

function requireMutable(readOnly) {
  if (readOnly) {
    throw new WorkspaceRouteError("VAULT_READ_ONLY", "当前工作区为只读接入，不允许恢复或重新绑定。", 403);
  }
}

export function createWorkspaceRoutes({
  getBackup,
  registry,
  currentFingerprint,
  readOnly = false,
  hosted = false,
  readJson,
  onRebind = async () => {},
} = {}) {
  if (typeof getBackup !== "function" || typeof readJson !== "function") {
    throw new TypeError("workspace routes require backup and JSON readers");
  }
  return Object.freeze({
    capabilities: Object.freeze({ export: !hosted, list: !hosted && Boolean(registry), restore: !hosted && !readOnly, rebind: !hosted && !readOnly && Boolean(registry) }),
    matches(_req, url) {
      return !hosted && url.pathname.startsWith(ROOT);
    },
    async handle(req, res, url, sendJson) {
      if (req.method === "GET" && url.pathname === "/api/workspace/backup") {
        return sendJson(res, 200, await (await getBackup()).exportBundle());
      }
      if (req.method === "POST" && url.pathname === "/api/workspace/restore/preview") {
        requireMutable(readOnly);
        const bundle = await readJson(req, MAX_WORKSPACE_BACKUP_BYTES);
        return sendJson(res, 200, await (await getBackup()).previewImport(bundle));
      }
      if (req.method === "POST" && url.pathname === "/api/workspace/restore/confirm") {
        requireMutable(readOnly);
        const body = requireObject(await readJson(req, 8 * 1024), new Set(["token"]));
        return sendJson(res, 200, await (await getBackup()).confirmImport(body.token));
      }
      if (req.method === "GET" && url.pathname === "/api/workspace/rebind/candidates") {
        if (!registry) throw new WorkspaceRouteError("WORKSPACE_REBIND_UNAVAILABLE", "当前工作区不支持重新绑定。", 404);
        const [items, current] = await Promise.all([
          registry.listWorkspaces(),
          registry.lookupVault({ fingerprint: currentFingerprint }),
        ]);
        return sendJson(res, 200, {
          items: items.map((item) => ({
            workspaceId: item.workspaceId,
            label: item.label,
            updatedAt: item.updatedAt,
            isCurrent: item.workspaceId === current?.workspaceId,
          })),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/workspace/rebind/preview") {
        requireMutable(readOnly);
        if (!registry) throw new WorkspaceRouteError("WORKSPACE_REBIND_UNAVAILABLE", "当前工作区不支持重新绑定。", 404);
        const body = requireObject(await readJson(req, 8 * 1024), new Set(["workspaceId"]));
        return sendJson(res, 200, await registry.previewRebind({
          currentFingerprint,
          workspaceId: body.workspaceId,
        }));
      }
      if (req.method === "POST" && url.pathname === "/api/workspace/rebind/confirm") {
        requireMutable(readOnly);
        if (!registry) throw new WorkspaceRouteError("WORKSPACE_REBIND_UNAVAILABLE", "当前工作区不支持重新绑定。", 404);
        const body = requireObject(await readJson(req, 8 * 1024), new Set(["token"]));
        const workspace = await registry.confirmRebind({ token: body.token });
        await onRebind(workspace);
        return sendJson(res, 200, {
          workspaceId: workspace.workspaceId,
          label: workspace.label,
          updatedAt: workspace.updatedAt,
        });
      }
      throw new WorkspaceRouteError("WORKSPACE_ROUTE_NOT_FOUND", "工作区操作不存在。", 404);
    },
  });
}
