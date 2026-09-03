import { request } from "./api-request.js";

function command(path, payload) {
  return request(path, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export const exportWorkspaceBackup = () => request("/api/workspace/backup");
export const previewWorkspaceRestore = (bundle) => command("/api/workspace/restore/preview", bundle);
export const confirmWorkspaceRestore = (token) => command("/api/workspace/restore/confirm", { token });

export const loadWorkspaceRebindCandidates = () => request("/api/workspace/rebind/candidates");
export const previewWorkspaceRebind = (workspaceId) => command("/api/workspace/rebind/preview", { workspaceId });
export const confirmWorkspaceRebind = (token) => command("/api/workspace/rebind/confirm", { token });
