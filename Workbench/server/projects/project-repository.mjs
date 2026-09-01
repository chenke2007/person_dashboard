import { constants, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { emptyProjectStore, projectStoreSchema } from "./project-schema.mjs";

const FILE_NAME = "projects.json";
const MAX_BYTES = 32 * 1024 * 1024;

export class ProjectRepositoryError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "ProjectRepositoryError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, status = 400, details) {
  throw new ProjectRepositoryError(code, message, status, details);
}

function normalizedText(value, label, maximum) {
  if (typeof value !== "string") fail("PROJECT_INVALID_INPUT", `${label}格式无效。`);
  const result = value.normalize("NFC").trim();
  if (!result || result.length > maximum) fail("PROJECT_INVALID_INPUT", `${label}为空或过长。`);
  return result;
}

function normalizeProjectKey(value) {
  const key = normalizedText(value, "项目缩写", 12).toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{1,11}$/.test(key)) {
    fail("PROJECT_INVALID_KEY", "项目缩写必须以字母开头，并只包含大写字母、数字或连字符。");
  }
  return key;
}

function optionalDate(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail("PROJECT_INVALID_INPUT", `${label}格式无效。`);
  }
  return value;
}

function validateDateRange(startDate, dueDate) {
  if (startDate && dueDate && startDate > dueDate) {
    fail("PROJECT_DATE_RANGE_INVALID", "开始日期不能晚于截止日期。");
  }
}

function requireProject(store, projectId) {
  const project = store.projects.find((item) => item.id === projectId);
  if (!project) fail("PROJECT_NOT_FOUND", "项目不存在。", 404);
  return project;
}

function requireTask(store, taskId) {
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task) fail("PROJECT_TASK_NOT_FOUND", "任务不存在。", 404);
  return task;
}

function requireColumn(store, columnId, projectId) {
  if (columnId == null) return null;
  const column = store.columns.find((item) => item.id === columnId);
  if (!column) fail("PROJECT_COLUMN_NOT_FOUND", "状态列不存在。", 404);
  if (column.projectId !== projectId) fail("PROJECT_COLUMN_MISMATCH", "状态列不属于当前项目。");
  return column;
}

function normalizeTaskPositions(store, projectId, columnId) {
  store.tasks
    .filter((item) => item.projectId === projectId && item.columnId === columnId && !item.archivedAt)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
    .forEach((item, position) => { item.position = position; });
}

function metricsFor(store, project) {
  const columns = new Map(store.columns.filter((item) => item.projectId === project.id).map((item) => [item.id, item]));
  const tasks = store.tasks.filter((item) => item.projectId === project.id && !item.archivedAt);
  const completed = tasks.filter((item) => columns.get(item.columnId)?.isFinal).length;
  const today = new Date().toISOString().slice(0, 10);
  return {
    activeTasks: tasks.length,
    completedTasks: completed,
    completion: tasks.length ? completed / tasks.length : 0,
    overdueTasks: tasks.filter((item) => item.dueDate && item.dueDate < today && !columns.get(item.columnId)?.isFinal).length,
  };
}

export function createProjectRepository({
  directory,
  now = () => new Date(),
  makeId = randomUUID,
  resolveDocument = async () => null,
} = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    fail("PROJECT_STORAGE_PATH_INVALID", "项目存储目录无效。", 500);
  }
  const root = path.resolve(directory);
  const target = path.join(root, FILE_NAME);
  let queue = Promise.resolve();
  let canonicalRoot = null;

  async function ensureDirectory() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const details = await lstat(root);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      fail("PROJECT_STORAGE_PATH_UNSAFE", "项目存储目录不安全。", 500);
    }
    const actual = path.resolve(await realpath(root));
    const comparable = process.platform === "win32" ? actual.toLowerCase() : actual;
    if (canonicalRoot && canonicalRoot !== comparable) {
      fail("PROJECT_STORAGE_PATH_UNSAFE", "项目存储目录不安全。", 500);
    }
    canonicalRoot = comparable;
  }

  async function readStore() {
    await ensureDirectory();
    let details;
    try {
      details = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") return emptyProjectStore();
      throw error;
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_BYTES) {
      fail("PROJECT_STORAGE_CORRUPT", "项目数据文件无效或超过容量限制。", 500);
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(target, "utf8"));
    } catch {
      fail("PROJECT_STORAGE_CORRUPT", "项目数据文件无法解析。", 500);
    }
    if (parsed?.version !== 1) {
      fail("PROJECT_STORAGE_VERSION_UNSUPPORTED", "项目数据版本不受支持。", 500, {
        version: parsed?.version ?? null,
      });
    }
    const result = projectStoreSchema.safeParse(parsed);
    if (!result.success) fail("PROJECT_STORAGE_CORRUPT", "项目数据文件格式无效。", 500);
    return result.data;
  }

  async function writeStore(store) {
    const checked = projectStoreSchema.safeParse(store);
    if (!checked.success) fail("PROJECT_STORAGE_CORRUPT", "项目数据未通过完整性检查。", 500);
    const body = `${JSON.stringify(checked.data, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("PROJECT_STORAGE_TOO_LARGE", "项目数据超过容量限制。", 413);
    const temporary = path.join(root, `.${FILE_NAME}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await ensureDirectory();
      await rename(temporary, target);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
    return checked.data;
  }

  function serialized(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  function projectProjection(store, projectId) {
    const project = store.projects.find((item) => item.id === projectId);
    if (!project) fail("PROJECT_NOT_FOUND", "项目不存在。", 404);
    const taskIds = new Set(store.tasks.filter((item) => item.projectId === projectId).map((item) => item.id));
    return structuredClone({
      version: store.version,
      revision: store.revision,
      updatedAt: store.updatedAt,
      project,
      columns: store.columns.filter((item) => item.projectId === projectId).sort((a, b) => a.position - b.position),
      tasks: store.tasks.filter((item) => item.projectId === projectId).sort((a, b) => a.position - b.position),
      labels: store.labels,
      taskLabels: store.taskLabels.filter((item) => taskIds.has(item.taskId)),
      taskLinks: store.taskLinks.filter((item) => taskIds.has(item.taskId)),
      activities: store.activities.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    });
  }

  async function mutate(operation, expectedRevision = null) {
    return serialized(async () => {
      const store = structuredClone(await readStore());
      if (expectedRevision != null && store.revision !== expectedRevision) {
        fail("PROJECT_REVISION_CONFLICT", "项目已更新，请重新加载后重试。", 409, {
          expected: expectedRevision,
          actual: store.revision,
        });
      }
      const result = await operation(store);
      store.revision += 1;
      store.updatedAt = now().toISOString();
      await writeStore(store);
      return typeof result === "function" ? result(store) : result;
    });
  }

  return Object.freeze({
    async getWorkspace() {
      return serialized(async () => {
        const store = await readStore();
        return structuredClone({
          version: store.version,
          revision: store.revision,
          updatedAt: store.updatedAt,
          projects: store.projects.filter((item) => !item.archivedAt).sort((a, b) => a.position - b.position),
          metrics: Object.fromEntries(store.projects.map((project) => [project.id, metricsFor(store, project)])),
        });
      });
    },
    async getProject(projectId) {
      return serialized(async () => {
        const snapshot = projectProjection(await readStore(), projectId);
        snapshot.taskLinks = await Promise.all(snapshot.taskLinks.map(async (link) => {
          const document = await resolveDocument(link.documentId);
          return {
            ...link,
            missing: !document,
            ...(document?.title ? { title: String(document.title).slice(0, 240) } : {}),
          };
        }));
        return snapshot;
      });
    },
    createProject(input) {
      return mutate((store) => {
        const key = normalizeProjectKey(input?.key);
        const name = normalizedText(input?.name, "项目名称", 120);
        const description = input?.description == null ? "" : String(input.description).normalize("NFC").trim();
        if (description.length > 4_000) fail("PROJECT_INVALID_INPUT", "项目描述过长。");
        if (store.projects.some((item) => item.key === key)) fail("PROJECT_KEY_CONFLICT", "项目缩写已存在。", 409);
        const timestamp = now().toISOString();
        const project = {
          id: makeId(), key, name, description,
          position: store.projects.length, lastTaskNumber: 0, archivedAt: null,
          createdAt: timestamp, updatedAt: timestamp,
        };
        const defaults = [
          ["待办", false, "#77839a"],
          ["进行中", false, "#4d82d8"],
          ["已完成", true, "#3d9a72"],
        ];
        const columns = defaults.map(([columnName, isFinal, color], position) => ({
          id: makeId(), projectId: project.id, name: columnName, color, position, isFinal,
          createdAt: timestamp, updatedAt: timestamp,
        }));
        store.projects.push(project);
        store.columns.push(...columns);
        return (saved) => ({ revision: saved.revision, project: structuredClone(project), columns: structuredClone(columns) });
      });
    },
    updateProject(projectId, patch) {
      return mutate((store) => {
        const project = requireProject(store, projectId);
        if (patch?.key !== undefined) {
          const key = normalizeProjectKey(patch.key);
          if (store.projects.some((item) => item.id !== project.id && item.key === key)) {
            fail("PROJECT_KEY_CONFLICT", "项目缩写已存在。", 409);
          }
          project.key = key;
        }
        if (patch?.name !== undefined) project.name = normalizedText(patch.name, "项目名称", 120);
        if (patch?.description !== undefined) {
          const description = String(patch.description ?? "").normalize("NFC").trim();
          if (description.length > 4_000) fail("PROJECT_INVALID_INPUT", "项目描述过长。");
          project.description = description;
        }
        project.updatedAt = now().toISOString();
        return (saved) => ({ revision: saved.revision, project: structuredClone(project) });
      });
    },
    archiveProject(projectId) {
      return mutate((store) => {
        const project = requireProject(store, projectId);
        const timestamp = now().toISOString();
        project.archivedAt = project.archivedAt ?? timestamp;
        project.updatedAt = timestamp;
        return (saved) => ({ revision: saved.revision, project: structuredClone(project) });
      });
    },
    createColumn(input) {
      return mutate((store) => {
        const project = requireProject(store, input?.projectId);
        const timestamp = now().toISOString();
        const column = {
          id: makeId(), projectId: project.id,
          name: normalizedText(input?.name, "状态列名称", 80),
          color: input?.color == null ? null : normalizedText(input.color, "状态列颜色", 32),
          position: store.columns.filter((item) => item.projectId === project.id).length,
          isFinal: Boolean(input?.isFinal), createdAt: timestamp, updatedAt: timestamp,
        };
        store.columns.push(column);
        return (saved) => ({ revision: saved.revision, column: structuredClone(column) });
      });
    },
    updateColumn(columnId, patch) {
      return mutate((store) => {
        const column = store.columns.find((item) => item.id === columnId);
        if (!column) fail("PROJECT_COLUMN_NOT_FOUND", "状态列不存在。", 404);
        if (patch?.name !== undefined) column.name = normalizedText(patch.name, "状态列名称", 80);
        if (patch?.color !== undefined) column.color = patch.color == null ? null : normalizedText(patch.color, "状态列颜色", 32);
        if (patch?.isFinal !== undefined) column.isFinal = Boolean(patch.isFinal);
        column.updatedAt = now().toISOString();
        return (saved) => ({ revision: saved.revision, column: structuredClone(column) });
      });
    },
    reorderColumns(input) {
      return mutate((store) => {
        const project = requireProject(store, input?.projectId);
        const columns = store.columns.filter((item) => item.projectId === project.id);
        const orderedIds = Array.isArray(input?.orderedIds) ? input.orderedIds : [];
        if (orderedIds.length !== columns.length || new Set(orderedIds).size !== columns.length || orderedIds.some((id) => !columns.some((column) => column.id === id))) {
          fail("PROJECT_COLUMN_ORDER_INVALID", "状态列顺序不完整或包含其他项目的状态列。");
        }
        const timestamp = now().toISOString();
        orderedIds.forEach((id, position) => {
          const column = columns.find((item) => item.id === id);
          column.position = position;
          column.updatedAt = timestamp;
        });
        return (saved) => ({
          revision: saved.revision,
          columns: structuredClone(columns.sort((a, b) => a.position - b.position)),
        });
      });
    },
    createTask(input) {
      return mutate((store) => {
        const project = requireProject(store, input?.projectId);
        if (project.archivedAt) fail("PROJECT_ARCHIVED", "归档项目不能创建任务。", 409);
        const columnId = input?.columnId ?? null;
        requireColumn(store, columnId, project.id);
        const title = normalizedText(input?.title, "任务标题", 240);
        const description = input?.description == null ? "" : String(input.description).normalize("NFC");
        if (description.length > 40_000) fail("PROJECT_INVALID_INPUT", "任务描述过长。");
        const priority = input?.priority ?? "none";
        if (!["none", "low", "medium", "high", "urgent"].includes(priority)) fail("PROJECT_INVALID_INPUT", "任务优先级无效。");
        const startDate = optionalDate(input?.startDate, "开始日期");
        const dueDate = optionalDate(input?.dueDate, "截止日期");
        validateDateRange(startDate, dueDate);
        const timestamp = now().toISOString();
        project.lastTaskNumber += 1;
        project.updatedAt = timestamp;
        const task = {
          id: makeId(), projectId: project.id, columnId, number: project.lastTaskNumber,
          title, description, priority, startDate, dueDate,
          position: store.tasks.filter((item) => item.projectId === project.id && item.columnId === columnId && !item.archivedAt).length,
          archivedAt: null, createdAt: timestamp, updatedAt: timestamp,
        };
        store.tasks.push(task);
        store.activities.push({
          id: makeId(), projectId: project.id, taskId: task.id,
          type: "task.created", data: { title: task.title }, createdAt: timestamp,
        });
        return (saved) => ({ revision: saved.revision, task: structuredClone(task) });
      });
    },
    updateTask(taskId, patch) {
      return mutate((store) => {
        const task = requireTask(store, taskId);
        const changed = {};
        if (patch?.title !== undefined) {
          const title = normalizedText(patch.title, "任务标题", 240);
          if (title !== task.title) changed.title = [task.title, title];
          task.title = title;
        }
        if (patch?.description !== undefined) {
          const description = String(patch.description ?? "").normalize("NFC");
          if (description.length > 40_000) fail("PROJECT_INVALID_INPUT", "任务描述过长。");
          if (description !== task.description) changed.description = true;
          task.description = description;
        }
        if (patch?.priority !== undefined) {
          if (!["none", "low", "medium", "high", "urgent"].includes(patch.priority)) fail("PROJECT_INVALID_INPUT", "任务优先级无效。");
          if (patch.priority !== task.priority) changed.priority = [task.priority, patch.priority];
          task.priority = patch.priority;
        }
        const startDate = patch?.startDate === undefined ? task.startDate : optionalDate(patch.startDate, "开始日期");
        const dueDate = patch?.dueDate === undefined ? task.dueDate : optionalDate(patch.dueDate, "截止日期");
        validateDateRange(startDate, dueDate);
        if (startDate !== task.startDate) changed.startDate = [task.startDate, startDate];
        if (dueDate !== task.dueDate) changed.dueDate = [task.dueDate, dueDate];
        task.startDate = startDate;
        task.dueDate = dueDate;
        const timestamp = now().toISOString();
        task.updatedAt = timestamp;
        if (Object.keys(changed).length) {
          store.activities.push({
            id: makeId(), projectId: task.projectId, taskId: task.id, type: "task.updated",
            data: { fields: changed }, createdAt: timestamp,
          });
        }
        return (saved) => ({ revision: saved.revision, task: structuredClone(task) });
      });
    },
    moveTask(input) {
      return mutate((store) => {
        const task = requireTask(store, input?.taskId);
        const previousColumnId = task.columnId;
        const columnId = input?.columnId ?? null;
        requireColumn(store, columnId, task.projectId);
        const target = store.tasks
          .filter((item) => item.id !== task.id && item.projectId === task.projectId && item.columnId === columnId && !item.archivedAt)
          .sort((a, b) => a.position - b.position);
        const requestedIndex = Number(input?.index);
        if (!Number.isInteger(requestedIndex) || requestedIndex < 0) fail("PROJECT_INVALID_INPUT", "任务位置无效。");
        target.splice(Math.min(requestedIndex, target.length), 0, task);
        task.columnId = columnId;
        task.updatedAt = now().toISOString();
        target.forEach((item, position) => { item.position = position; });
        if (previousColumnId !== columnId) normalizeTaskPositions(store, task.projectId, previousColumnId);
        store.activities.push({
          id: makeId(), projectId: task.projectId, taskId: task.id, type: "task.moved",
          data: { fromColumnId: previousColumnId, toColumnId: columnId, position: task.position }, createdAt: task.updatedAt,
        });
        return (saved) => ({ ...projectProjection(saved, task.projectId), task: structuredClone(task) });
      }, input?.revision);
    },
    createLabel(input) {
      return mutate((store) => {
        const name = normalizedText(input?.name, "标签名称", 60);
        const comparable = name.toLocaleLowerCase("zh-CN");
        if (store.labels.some((item) => item.name.toLocaleLowerCase("zh-CN") === comparable)) {
          fail("PROJECT_LABEL_CONFLICT", "标签名称已存在。", 409);
        }
        const color = normalizedText(input?.color, "标签颜色", 32);
        const timestamp = now().toISOString();
        const label = { id: makeId(), name, color, createdAt: timestamp, updatedAt: timestamp };
        store.labels.push(label);
        return (saved) => ({ revision: saved.revision, label: structuredClone(label) });
      });
    },
    setTaskLabels(input) {
      return mutate((store) => {
        const task = requireTask(store, input?.taskId);
        const labelIds = [...new Set(Array.isArray(input?.labelIds) ? input.labelIds : [])];
        if (labelIds.some((id) => !store.labels.some((label) => label.id === id))) {
          fail("PROJECT_LABEL_NOT_FOUND", "标签不存在。", 404);
        }
        store.taskLabels = store.taskLabels.filter((item) => item.taskId !== task.id);
        const taskLabels = labelIds.map((labelId) => ({ taskId: task.id, labelId }));
        store.taskLabels.push(...taskLabels);
        const timestamp = now().toISOString();
        task.updatedAt = timestamp;
        store.activities.push({
          id: makeId(), projectId: task.projectId, taskId: task.id, type: "task.labels_changed",
          data: { labelIds }, createdAt: timestamp,
        });
        return (saved) => ({ revision: saved.revision, taskLabels: structuredClone(taskLabels) });
      });
    },
    addTaskLink(input) {
      return mutate(async (store) => {
        const task = requireTask(store, input?.taskId);
        const documentId = normalizedText(input?.documentId, "文档标识", 512);
        const document = await resolveDocument(documentId);
        if (!document) fail("PROJECT_DOCUMENT_NOT_FOUND", "关联文档不存在。", 404);
        const relativePath = String(document.path ?? document.relativePath ?? "").replace(/\\/g, "/");
        if (!relativePath || path.posix.isAbsolute(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
          fail("PROJECT_DOCUMENT_PATH_INVALID", "关联文档路径无效。");
        }
        if (store.taskLinks.some((item) => item.taskId === task.id && item.documentId === documentId)) {
          fail("PROJECT_LINK_CONFLICT", "该文档已经关联。", 409);
        }
        const timestamp = now().toISOString();
        const link = {
          id: makeId(), taskId: task.id, documentId, relativePath,
          kind: String(document.kind ?? document.collection ?? "document").slice(0, 40), createdAt: timestamp,
        };
        store.taskLinks.push(link);
        store.activities.push({
          id: makeId(), projectId: task.projectId, taskId: task.id, type: "task.linked",
          data: { documentId, relativePath }, createdAt: timestamp,
        });
        return (saved) => ({ revision: saved.revision, link: structuredClone(link) });
      });
    },
    removeTaskLink(linkId) {
      return mutate((store) => {
        const index = store.taskLinks.findIndex((item) => item.id === linkId);
        if (index < 0) fail("PROJECT_LINK_NOT_FOUND", "文档关联不存在。", 404);
        const [link] = store.taskLinks.splice(index, 1);
        const task = requireTask(store, link.taskId);
        const timestamp = now().toISOString();
        store.activities.push({
          id: makeId(), projectId: task.projectId, taskId: task.id, type: "task.unlinked",
          data: { documentId: link.documentId, relativePath: link.relativePath }, createdAt: timestamp,
        });
        return (saved) => ({ revision: saved.revision, removedLinkId: link.id });
      });
    },
    archiveTask(taskId) {
      return mutate((store) => {
        const task = requireTask(store, taskId);
        if (task.archivedAt) return (saved) => ({ revision: saved.revision, task: structuredClone(task) });
        const timestamp = now().toISOString();
        task.archivedAt = timestamp;
        task.updatedAt = timestamp;
        normalizeTaskPositions(store, task.projectId, task.columnId);
        store.activities.push({
          id: makeId(), projectId: task.projectId, taskId: task.id, type: "task.archived", data: {}, createdAt: timestamp,
        });
        return (saved) => ({ revision: saved.revision, task: structuredClone(task) });
      });
    },
  });
}
