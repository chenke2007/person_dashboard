import { request } from "./api-request.js";

function command(path, method, body = {}) {
  return request(path, { method, body: JSON.stringify(body) });
}

export const loadSummaryCapabilities = () => request("/api/summaries/capabilities", { method: "GET" });
export const loadRepositorySummaries = (repositoryId) =>
  request(`/api/summaries?repositoryId=${encodeURIComponent(repositoryId)}`, { method: "GET" });
export const loadRepositorySummary = (repositoryId) =>
  request(`/api/summaries/repository/${encodeURIComponent(repositoryId)}`, { method: "GET" });
export const loadRepositorySummaryByCommit = (repositoryId, sourceCommitSha) =>
  request(`/api/summaries/repository/${encodeURIComponent(repositoryId)}?sourceCommitSha=${encodeURIComponent(sourceCommitSha)}`, { method: "GET" });
export const generateRepositorySummary = ({ repositoryId, sourceCommitSha } = {}) =>
  command("/api/summaries/generate", "POST", { repositoryId, ...(sourceCommitSha ? { sourceCommitSha } : {}) });