import { ProjectRepositoryError } from "./project-repository.mjs";

const ROOT = "/api/projects";
const PROJECT = /^\/([0-9a-f-]{36})$/i;
const PROJECT_ACTION = /^\/([0-9a-f-]{36})\/(archive|restore|columns|tasks)$/i;
const PROJECT_COLUMN = /^\/([0-9a-f-]{36})\/columns\/([0-9a-f-]{36})$/i;
const PROJECT_COLUMN_ORDER = /^\/([0-9a-f-]{36})\/columns\/order$/i;
const TASK = /^\/api\/tasks\/([0-9a-f-]{36})(?:\/(move|archive|restore|labels|links))?$/i;
const TASK_LINK = /^\/api\/task-links\/([0-9a-f-]{36})$/i;

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

async function bodyJson(req, maximum = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new ProjectRepositoryError("PROJECT_REQUEST_TOO_LARGE", "请求内容超过容量限制。", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ProjectRepositoryError("PROJECT_INVALID_JSON", "请求内容不是有效 JSON。", 400);
  }
}

function publicError(error) {
  if (error instanceof ProjectRepositoryError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  return { code: "PROJECT_STORAGE_ERROR", message: "项目数据暂时不可用。" };
}

export function createProjectRoutes({ repository, readOnly = false } = {}) {
  if (!repository) throw new TypeError("project repository is required");
  return {
    matches(_req, url) {
      return url.pathname === ROOT || url.pathname.startsWith(`${ROOT}/`) || url.pathname.startsWith("/api/tasks/") || url.pathname.startsWith("/api/task-links/");
    },
    async handle(req, res, url) {
      try {
        if (readOnly && !["GET", "HEAD"].includes(req.method || "")) {
          throw new ProjectRepositoryError("VAULT_READ_ONLY", "当前知识库为只读接入，不允许修改项目。", 403);
        }
        const route = url.pathname.slice(ROOT.length);
        if (req.method === "GET" && route === "") return sendJson(res, 200, await repository.getWorkspace({ includeArchived: url.searchParams.get("archived") === "include" }));
        if (req.method === "POST" && route === "") return sendJson(res, 201, await repository.createProject(await bodyJson(req)));
        if (req.method === "POST" && route === "/labels") return sendJson(res, 201, await repository.createLabel(await bodyJson(req)));
        const projectMatch = PROJECT.exec(route);
        if (req.method === "GET" && projectMatch) return sendJson(res, 200, await repository.getProject(projectMatch[1], { includeArchived: url.searchParams.get("archived") === "include" }));
        if (req.method === "PATCH" && projectMatch) return sendJson(res, 200, await repository.updateProject(projectMatch[1], await bodyJson(req)));
        const orderMatch = PROJECT_COLUMN_ORDER.exec(route);
        if (req.method === "PUT" && orderMatch) {
          return sendJson(res, 200, await repository.reorderColumns({ projectId: orderMatch[1], ...(await bodyJson(req)) }));
        }
        const columnMatch = PROJECT_COLUMN.exec(route);
        if (req.method === "PATCH" && columnMatch) {
          return sendJson(res, 200, await repository.updateColumn(columnMatch[2], await bodyJson(req)));
        }
        const actionMatch = PROJECT_ACTION.exec(route);
        if (req.method === "POST" && actionMatch?.[2] === "archive") {
          return sendJson(res, 200, await repository.archiveProject(actionMatch[1]));
        }
        if (req.method === "POST" && actionMatch?.[2] === "restore") {
          return sendJson(res, 200, await repository.restoreProject(actionMatch[1]));
        }
        if (req.method === "POST" && actionMatch?.[2] === "columns") {
          return sendJson(res, 201, await repository.createColumn({ projectId: actionMatch[1], ...(await bodyJson(req)) }));
        }
        if (req.method === "POST" && actionMatch?.[2] === "tasks") {
          return sendJson(res, 201, await repository.createTask({ projectId: actionMatch[1], ...(await bodyJson(req)) }));
        }
        const taskMatch = TASK.exec(url.pathname);
        if (taskMatch && req.method === "PATCH" && !taskMatch[2]) {
          return sendJson(res, 200, await repository.updateTask(taskMatch[1], await bodyJson(req)));
        }
        if (taskMatch && req.method === "POST" && taskMatch[2] === "move") {
          return sendJson(res, 200, await repository.moveTask({ taskId: taskMatch[1], ...(await bodyJson(req)) }));
        }
        if (taskMatch && req.method === "POST" && taskMatch[2] === "archive") {
          await bodyJson(req);
          return sendJson(res, 200, await repository.archiveTask(taskMatch[1]));
        }
        if (taskMatch && req.method === "POST" && taskMatch[2] === "restore") {
          await bodyJson(req);
          return sendJson(res, 200, await repository.restoreTask(taskMatch[1]));
        }
        if (taskMatch && req.method === "PUT" && taskMatch[2] === "labels") {
          return sendJson(res, 200, await repository.setTaskLabels({ taskId: taskMatch[1], ...(await bodyJson(req)) }));
        }
        if (taskMatch && req.method === "POST" && taskMatch[2] === "links") {
          return sendJson(res, 201, await repository.addTaskLink({ taskId: taskMatch[1], ...(await bodyJson(req)) }));
        }
        const linkMatch = TASK_LINK.exec(url.pathname);
        if (linkMatch && req.method === "DELETE") {
          await bodyJson(req);
          return sendJson(res, 200, await repository.removeTaskLink(linkMatch[1]));
        }
        throw new ProjectRepositoryError("PROJECT_ROUTE_NOT_FOUND", "项目操作不存在。", 404);
      } catch (error) {
        sendJson(res, error?.status || 500, { error: publicError(error) });
      }
    },
  };
}
