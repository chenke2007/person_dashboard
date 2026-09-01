import { request } from "./api-request.js";

function command(path, method, body = {}) {
  return request(path, { method, body: JSON.stringify(body) });
}

export const loadProjects = () => request("/api/projects");
export const createProject = (input) => command("/api/projects", "POST", input);
export const loadProject = (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}`);
export const updateProject = (projectId, patch) => command(`/api/projects/${encodeURIComponent(projectId)}`, "PATCH", patch);
export const archiveProject = (projectId) => command(`/api/projects/${encodeURIComponent(projectId)}/archive`, "POST");
export const createColumn = (projectId, input) => command(`/api/projects/${encodeURIComponent(projectId)}/columns`, "POST", input);
export const updateColumn = (projectId, columnId, patch) => command(`/api/projects/${encodeURIComponent(projectId)}/columns/${encodeURIComponent(columnId)}`, "PATCH", patch);
export const reorderColumns = (projectId, orderedIds) => command(`/api/projects/${encodeURIComponent(projectId)}/columns/order`, "PUT", { orderedIds });
export const createTask = (projectId, input) => command(`/api/projects/${encodeURIComponent(projectId)}/tasks`, "POST", input);
export const updateTask = (taskId, patch) => command(`/api/tasks/${encodeURIComponent(taskId)}`, "PATCH", patch);
export const moveTask = (taskId, input) => command(`/api/tasks/${encodeURIComponent(taskId)}/move`, "POST", input);
export const archiveTask = (taskId) => command(`/api/tasks/${encodeURIComponent(taskId)}/archive`, "POST");
export const createLabel = (input) => command("/api/projects/labels", "POST", input);
export const setTaskLabels = (taskId, labelIds) => command(`/api/tasks/${encodeURIComponent(taskId)}/labels`, "PUT", { labelIds });
export const addTaskLink = (taskId, documentId) => command(`/api/tasks/${encodeURIComponent(taskId)}/links`, "POST", { documentId });
export const removeTaskLink = (linkId) => command(`/api/task-links/${encodeURIComponent(linkId)}`, "DELETE");
