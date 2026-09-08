import { request } from "./api-request.js";

function command(path, method, body = {}) {
  return request(path, { method, body: JSON.stringify(body) });
}

function queryParams(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "all") params.set(key, value);
  }
  return params.toString();
}

export const loadRadar = ({ period = "day", state, focus } = {}) => {
  const query = queryParams({ period, state, focus });
  return request(`/api/ai-radar${query ? `?${query}` : ""}`, { method: "GET" });
};
export const loadRadarStatus = () => request("/api/ai-radar/status", { method: "GET" });
export const collectRadar = () => command("/api/ai-radar/collect", "POST");
export const updateRadarSchedule = (patch) => command("/api/ai-radar/schedule", "PATCH", patch);
export const setRadarDecision = (repositoryId, status) => command(`/api/ai-radar/repositories/${encodeURIComponent(repositoryId)}/decision`, "PUT", { status });
export const loadRadarPreferences = () => request("/api/ai-radar/preferences", { method: "GET" });
export const addRadarPreference = (input) => command("/api/ai-radar/preferences", "POST", input);
export const revertRadarPreference = (id) => command(`/api/ai-radar/preferences/${encodeURIComponent(id)}/revert`, "POST");
export const resetRadarPreferences = () => command("/api/ai-radar/preferences", "DELETE");