import { request } from "./api-request.js";

function command(path, method, body = {}) {
  return request(path, { method, body: JSON.stringify(body) });
}

export const loadLearningCapabilities = () => request("/api/learning/capabilities", { method: "GET" });
export const loadLearningWorkspaces = ({ includeArchived = false } = {}) =>
  request(`/api/learning${includeArchived ? "?includeArchived=1" : ""}`, { method: "GET" });
export const loadLearningWorkspace = (workspaceId) => request(`/api/learning/${encodeURIComponent(workspaceId)}`, { method: "GET" });
export const createLearningDraft = (repositoryId, mission) => command("/api/learning/drafts", "POST", { repositoryId, mission });
export const editLearningDraft = (workspaceId, expectedRevision, mission) =>
  command(`/api/learning/${encodeURIComponent(workspaceId)}/draft`, "PATCH", { expectedRevision, mission });
export const previewLearningDraft = (workspaceId) => command(`/api/learning/${encodeURIComponent(workspaceId)}/preview`, "POST");
export const confirmLearning = (token) => command("/api/learning/confirm", "POST", { token });
export const activateLearning = (workspaceId, expectedRevision) =>
  command(`/api/learning/${encodeURIComponent(workspaceId)}/activate`, "POST", { expectedRevision });
export const archiveLearning = (workspaceId) => command(`/api/learning/${encodeURIComponent(workspaceId)}/archive`, "POST");
export const loadLearningContent = (workspaceId) => request(`/api/learning/${encodeURIComponent(workspaceId)}/content`, { method: "GET" });
export const loadLearningArtifacts = (workspaceId) => request(`/api/learning/${encodeURIComponent(workspaceId)}/artifacts`, { method: "GET" });
export const saveLearningPlan = (workspaceId, expectedRevision, plan) =>
  command(`/api/learning/${encodeURIComponent(workspaceId)}/plan`, "PATCH", { expectedRevision, plan });
export const saveLearningNotes = (workspaceId, expectedRevision, notes) =>
  command(`/api/learning/${encodeURIComponent(workspaceId)}/notes`, "PATCH", { expectedRevision, notes });
export const addLearningArtifact = (workspaceId, expectedRevision, artifact) =>
  command(`/api/learning/${encodeURIComponent(workspaceId)}/artifacts`, "POST", { expectedRevision, artifact });
export const loadLearningTargets = (workspaceId) => request(`/api/learning/${encodeURIComponent(workspaceId)}/targets`, { method: "GET" });
export const setLearningTarget = (workspaceId, vaultId) =>
  command(`/api/learning/${encodeURIComponent(workspaceId)}/target`, "POST", { vaultId });
export const previewLearningIngestion = (workspaceId, selectedContentTypes, targetVaultId) =>
  command(`/api/learning/${encodeURIComponent(workspaceId)}/ingestions/preview`, "POST", { selectedContentTypes, targetVaultId });
export const confirmLearningIngestion = (workspaceId, token, conflictResolution) => {
  const body = { token };
  if (conflictResolution !== undefined) body.conflictResolution = conflictResolution;
  return command(`/api/learning/${encodeURIComponent(workspaceId)}/ingestions/confirm`, "POST", body);
};
export const loadLearningIngestions = (workspaceId) => request(`/api/learning/${encodeURIComponent(workspaceId)}/ingestions`, { method: "GET" });