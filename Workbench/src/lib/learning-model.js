// Pure display projections for the learning workspace API. The server contract
// is authoritative for lifecycle and capacity; this module only normalizes the
// records for rendering and never truncates or invents state.

export const LEARNING_GOALS = Object.freeze([
  "understand-architecture",
  "learn-usage",
  "analyze-design",
  "reproduce-capability",
  "adoption-decision",
]);

export const LEARNING_GOAL_LABELS = Object.freeze({
  "understand-architecture": "理解架构",
  "learn-usage": "学会使用",
  "analyze-design": "分析设计",
  "reproduce-capability": "复刻核心能力",
  "adoption-decision": "判断是否采用",
});

// States reachable this phase: draft | queued | active | archived. review and
// completed are reserved by the schema but unreachable, so labels stay here for
// completeness without any UI path to them.
export const LEARNING_STATES = Object.freeze(["draft", "queued", "active", "archived", "review", "completed"]);

export const LEARNING_STATE_LABELS = Object.freeze({
  draft: "草稿",
  queued: "排队",
  active: "学习中",
  archived: "学习已归档",
  review: "审核",
  completed: "已完成",
});

// Radar-card overlay copy. "学习已归档" describes a learning workspace's
// archive and stays distinct from the repository's own GitHub `archived` flag.
export const LEARNING_CARD_BADGES = Object.freeze({
  draft: "学习（草稿）",
  queued: "学习中（排队）",
  active: "学习中",
  archived: "学习已归档",
});

export function projectLearningWorkspace(workspace) {
  const mission = workspace?.mission && typeof workspace.mission === "object" ? workspace.mission : {};
  const goal = typeof mission.goal === "string" ? mission.goal : (typeof workspace?.goal === "string" ? workspace.goal : null);
  const notes = typeof mission.notes === "string" ? mission.notes : (typeof workspace?.notes === "string" ? workspace.notes : "");
  return {
    workspaceId: workspace?.workspaceId ?? null,
    repositoryId: workspace?.repositoryId ?? null,
    fullName: workspace?.fullName ?? null,
    sourceUrl: workspace?.sourceUrl ?? null,
    sourceCommitSha: workspace?.sourceCommitSha ?? null,
    goal,
    notes,
    state: workspace?.state ?? null,
    draftRevision: typeof workspace?.draftRevision === "number" ? workspace.draftRevision : 1,
    createdAt: workspace?.createdAt ?? null,
    updatedAt: workspace?.updatedAt ?? null,
  };
}

// Groups every returned workspace under its reachable state. The UI renders
// the full server list — a grouped section never clips entries — and flags a
// data anomaly when the server ever reports more than three active workspaces.
export function projectLearningList(payload) {
  const workspaces = Array.isArray(payload?.workspaces)
    ? payload.workspaces.map(projectLearningWorkspace)
    : [];
  const groups = { draft: [], queued: [], active: [], archived: [], other: [] };
  for (const workspace of workspaces) {
    const bucket = groups[workspace.state] ?? groups.other;
    bucket.push(workspace);
  }
  for (const bucket of Object.values(groups)) {
    bucket.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  }
  return {
    workspaces,
    groups,
    total: workspaces.length,
    anomaly: groups.active.length > 3,
  };
}