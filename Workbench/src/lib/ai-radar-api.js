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

export const loadRadar = ({ period = "day", state, focus, learning } = {}) => {
  const query = queryParams({ period, state, focus, learning });
  return request(`/api/ai-radar${query ? `?${query}` : ""}`, { method: "GET" });
};
export const loadRadarStatus = () => request("/api/ai-radar/status", { method: "GET" });
export const loadRadarCapabilities = () => request("/api/ai-radar/capabilities", { method: "GET" });
export const collectRadar = () => command("/api/ai-radar/collect", "POST");
export const updateRadarSchedule = (patch) => command("/api/ai-radar/schedule", "PATCH", patch);
export const setRadarDecision = (repositoryId, status) => command(`/api/ai-radar/repositories/${encodeURIComponent(repositoryId)}/decision`, "PUT", { status });
export const loadRadarPreferences = () => request("/api/ai-radar/preferences", { method: "GET" });
export const addRadarPreference = (input) => command("/api/ai-radar/preferences", "POST", input);
export const revertRadarPreference = (id) => command(`/api/ai-radar/preferences/${encodeURIComponent(id)}/revert`, "POST");
export const resetRadarPreferences = () => command("/api/ai-radar/preferences", "DELETE");

// The collect endpoint answers HTTP 200 even for business failures, carrying
// `{ persisted, run, error }`. Interpret that shape into an explicit outcome so
// the UI can distinguish success, partial and failed collection instead of
// treating every 200 as success. Returns { level, message }.
export function describeRadarCollectResult(result) {
  const safeError = (error) => {
    if (!error) return null;
    if (typeof error === "string") return error.trim() || null;
    if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
    if (typeof error?.code === "string" && error.code.trim()) return error.code.trim();
    return null;
  };

  if (result?.persisted === true) {
    // Only an explicit success run is a clean success. The collector can
    // durably commit a run whose status is still "failed" or "partial", so the
    // persisted flag alone must never be read as success.
    if (result?.run?.status === "success") {
      return { level: "success", message: "采集完成，数据已保存。" };
    }
    if (result?.run?.status === "partial") {
      return { level: "partial", message: "部分成功：部分仓库未能采集，其余结果已保存。" };
    }
    // Persisted but failed, or a missing/unknown run status: do not claim
    // success. Surface the recorded error when present.
    const failure = safeError(result?.error) || safeError(result?.run?.errors?.[0]);
    if (failure) {
      return { level: "failed", message: `采集失败：${failure}` };
    }
    return { level: "failed", message: "采集结果不完整，数据未能全部保存。" };
  }

  // Not persisted. The run recorded a completed-but-unpersisted failure, the
  // collector hit a cooldown/skip, or the scheduler itself failed.
  const failure = safeError(result?.error) || safeError(result?.run?.errors?.[0]);
  if (failure) {
    if (result?.run?.status === "skipped") {
      return { level: "failed", message: `采集被暂缓：${failure}` };
    }
    return { level: "failed", message: `采集失败：${failure}` };
  }
  return { level: "failed", message: "采集失败，数据未能保存。" };
}