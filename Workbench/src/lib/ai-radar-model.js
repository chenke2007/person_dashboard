import { classifyRadarFocus } from "../../shared/ai-radar-ranking.mjs";

export const RADAR_PERIODS = Object.freeze(["day", "week", "month"]);
export const RADAR_LISTS = Object.freeze(["rising", "established", "relevant"]);
export const RADAR_STATES = Object.freeze(["all", "unread", "saved", "summarized", "queued", "learning", "completed", "ignored"]);
export const RADAR_FOCUSES = Object.freeze(["all", "agent", "ai-coding", "rag-knowledge", "ai-productivity"]);
export const RADAR_LEARNING_STATES = Object.freeze(["all", "draft", "queued", "active", "archived"]);
export const RADAR_LEARNING_LABELS = Object.freeze({
  all: "全部",
  draft: "学习草稿",
  queued: "学习队列",
  active: "学习中",
  archived: "学习已归档",
});
export const RADAR_PERIOD_LABELS = Object.freeze({ day: "今日", week: "每周", month: "每月" });
export const RADAR_LIST_LABELS = Object.freeze({ rising: "快速上升", established: "长期热门", relevant: "与你相关" });
export const RADAR_STATE_LABELS = Object.freeze({
  all: "全部",
  unread: "未处理",
  saved: "收藏",
  summarized: "已摘要",
  queued: "学习队列",
  learning: "学习中",
  completed: "已完成",
  ignored: "已忽略",
});
export const RADAR_FOCUS_LABELS = Object.freeze({
  all: "全部",
  agent: "AI Agent",
  "ai-coding": "AI 编程",
  "rag-knowledge": "RAG/知识库",
  "ai-productivity": "AI 应用与生产力",
});
export const RADAR_VIEW_LIMITS = Object.freeze({ day: 8, week: 12, month: 20 });

function requireChoice(value, choices, label) {
  if (!choices.includes(value)) {
    throw new RangeError(`radar dashboard ${label} must be one of: ${choices.join(", ")}`);
  }
  return value;
}

function projectCard(entry) {
  const repository = entry?.repository && typeof entry.repository === "object" ? entry.repository : {};
  const decision = entry?.decision && typeof entry.decision === "object" ? entry.decision : {};
  return {
    repositoryId: entry.repositoryId ?? null,
    fullName: repository.fullName ?? null,
    htmlUrl: repository.htmlUrl ?? null,
    description: repository.description ?? null,
    language: repository.language ?? null,
    topics: Array.isArray(repository.topics) ? repository.topics : [],
    license: repository.license ?? null,
    archived: repository.archived ?? false,
    fork: repository.fork ?? false,
    focusAreas: Array.isArray(repository.focusAreas) ? repository.focusAreas : [],
    stars: typeof entry.currentStars === "number" ? entry.currentStars : repository.stars ?? null,
    observedStarDelta: typeof entry.observedStarDelta === "number" ? entry.observedStarDelta : null,
    trendStatus: entry.status ?? null,
    coverage: entry.coverage ?? null,
    maintainedAt: entry.maintainedAt ?? repository.pushedAt ?? repository.updatedAt ?? null,
    reasons: Array.isArray(entry.reasons) ? entry.reasons : [],
    decisionStatus: decision.status ?? "unread",
    decisionUpdatedAt: decision.updatedAt ?? null,
    // Learning lifecycle is a read-time overlay from the learning store; null
    // means "no learning workspace", never a fabricated state.
    learningState: entry.learning ?? null,
    hasLearning: entry.learning != null,
    learningWorkspaceId: entry.learningWorkspaceId ?? null,
  };
}

function emptyView(view) {
  return {
    ...view,
    cards: [],
    localDate: null,
    timeZone: null,
    filters: null,
    counts: null,
    eligibleCount: null,
    freshness: null,
    coverage: null,
    retryAt: null,
    errors: null,
    run: null,
    empty: true,
  };
}

export function projectRadarDashboard(payload, { period = "day", list = "rising", state = "all", focus = "all", learning = "all" } = {}) {
  requireChoice(period, RADAR_PERIODS, "period");
  requireChoice(list, RADAR_LISTS, "list");
  requireChoice(state, RADAR_STATES, "state");
  requireChoice(focus, RADAR_FOCUSES, "focus");
  requireChoice(learning, RADAR_LEARNING_STATES, "learning");
  const view = { period, list, state, focus, learning, viewLimit: RADAR_VIEW_LIMITS[period] };

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.lists?.[list])) {
    return { ...emptyView(view), learningStatus: payload?.learningStatus ?? "ok" };
  }

  const cards = [];
  for (const entry of payload.lists[list]) {
    if (cards.length >= view.viewLimit) break;
    const status = entry?.decision?.status ?? "unread";
    if (view.state !== "all" && status !== view.state) continue;
    if (view.focus !== "all") {
      // Reuse the server-authoritative classifier so explicit directions,
      // topic aliases, and text patterns never diverge between layers.
      const directions = classifyRadarFocus(entry?.repository ?? entry).directions;
      if (!directions.includes(view.focus)) continue;
    }
    if (view.learning !== "all" && entry?.learning !== view.learning) continue;
    cards.push(projectCard(entry));
  }

  return {
    ...view,
    cards,
    localDate: payload.localDate ?? null,
    timeZone: payload.timeZone ?? null,
    filters: payload.filters ?? null,
    counts: payload.counts ?? null,
    eligibleCount: payload.eligibleCount ?? null,
    freshness: payload.freshness ?? null,
    coverage: payload.coverage ?? null,
    retryAt: payload.retryAt ?? null,
    errors: payload.errors ?? null,
    run: payload.run ?? null,
    learningStatus: payload.learningStatus ?? "ok",
    empty: cards.length === 0,
  };
}