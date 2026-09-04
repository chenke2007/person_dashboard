const PERIOD_DAYS = Object.freeze({ day: 1, week: 7, month: 30 });
const PERIOD_LIMITS = Object.freeze({ day: 8, week: 12, month: 20 });
const FOCUS_AREAS = new Set(["agent", "ai-coding", "rag-knowledge", "ai-productivity"]);
const RELEVANCE_ORDER = Object.freeze({ low: 1, medium: 2, high: 3 });

function requireTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new RangeError("timeZone must be a valid IANA timezone");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new RangeError("timeZone must be a valid IANA timezone");
  }
  return timeZone;
}

function requireNow(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(date.getTime())) throw new RangeError("now must be a valid date");
  return date;
}

function localDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function dateDistance(olderDate, newerDate) {
  return Math.round((Date.parse(`${newerDate}T00:00:00.000Z`) - Date.parse(`${olderDate}T00:00:00.000Z`)) / 86_400_000);
}

function validMetric(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function tieKey(snapshot) {
  return JSON.stringify([
    snapshot.stars,
    snapshot.forks,
    snapshot.openIssues,
    snapshot.capturedDate ?? null,
    snapshot.timeZone ?? null,
  ]);
}

function projectSnapshots(snapshots, repositoryId, now, timeZone) {
  const perDate = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (!snapshot || snapshot.repositoryId !== repositoryId || !validMetric(snapshot.stars)) continue;
    const capturedAt = new Date(snapshot.capturedAt);
    if (Number.isNaN(capturedAt.getTime()) || capturedAt > now) continue;
    const effectiveDate = localDate(capturedAt, timeZone);
    const candidate = {
      effectiveDate,
      capturedAt: capturedAt.toISOString(),
      sourceCapturedDate: typeof snapshot.capturedDate === "string" ? snapshot.capturedDate : null,
      sourceTimeZone: typeof snapshot.timeZone === "string" ? snapshot.timeZone : null,
      stars: snapshot.stars,
      forks: validMetric(snapshot.forks) ? snapshot.forks : null,
      openIssues: validMetric(snapshot.openIssues) ? snapshot.openIssues : null,
      tieKey: tieKey(snapshot),
    };
    const previous = perDate.get(effectiveDate);
    if (!previous || candidate.capturedAt > previous.capturedAt || (candidate.capturedAt === previous.capturedAt && candidate.tieKey > previous.tieKey)) {
      perDate.set(effectiveDate, candidate);
    }
  }
  return [...perDate.values()]
    .map(({ tieKey: _tieKey, ...observation }) => observation)
    .sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
}

function windowDetails(snapshots, repositoryId, targetDays, now, timeZone) {
  const effectiveNow = localDate(now, timeZone);
  const boundaryDate = shiftDate(effectiveNow, -targetDays);
  const observations = projectSnapshots(snapshots, repositoryId, now, timeZone);
  const baseline = [...observations].reverse().find((item) => item.effectiveDate <= boundaryDate) ?? null;
  const inWindow = observations.filter((item) => item.effectiveDate > boundaryDate && item.effectiveDate <= effectiveNow);
  const latest = inWindow.at(-1) ?? null;
  const coverage = {
    observedDays: inWindow.length,
    expectedDays: targetDays,
    missingDays: targetDays - inWindow.length,
    complete: inWindow.length === targetDays,
  };
  return { effectiveNow, boundaryDate, baseline, latest, coverage };
}

export function observedDelta(snapshots, repositoryId, targetDays, now = new Date(), timeZone = "UTC") {
  const selectedTimeZone = requireTimeZone(timeZone);
  const selectedNow = requireNow(now);
  if (!Number.isInteger(targetDays) || targetDays < 1) throw new RangeError("targetDays must be a positive integer");
  const { effectiveNow, boundaryDate, baseline, latest } = windowDetails(snapshots, repositoryId, targetDays, selectedNow, selectedTimeZone);
  if (!baseline || !latest || baseline.stars === null || latest.stars === null) return null;
  const observedWindowDays = dateDistance(baseline.effectiveDate, latest.effectiveDate);
  return {
    observedStarDelta: latest.stars - baseline.stars,
    baselineDate: baseline.effectiveDate,
    currentDate: latest.effectiveDate,
    observedWindowDays,
    exactWindow: baseline.effectiveDate === boundaryDate && latest.effectiveDate === effectiveNow && observedWindowDays === targetDays,
  };
}

function periodConfig(period) {
  if (!Object.hasOwn(PERIOD_DAYS, period)) throw new RangeError("period must be day, week, or month");
  return { targetDays: PERIOD_DAYS[period], limit: PERIOD_LIMITS[period] };
}

function availability(repository) {
  return repository.archived || repository.fork ? 1 : 0;
}

function repositoryReasons(repository) {
  const reasons = [];
  if (repository.archived) reasons.push("仓库已归档，已降级展示。");
  if (repository.fork) reasons.push("Fork 仓库，已降级展示。");
  return reasons;
}

function coverageReason(coverage) {
  return coverage.complete
    ? `覆盖 ${coverage.observedDays}/${coverage.expectedDays} 天。`
    : `覆盖 ${coverage.observedDays}/${coverage.expectedDays} 天，缺少 ${coverage.missingDays} 天。`;
}

function trendEntry(repository, snapshots, targetDays, now, timeZone) {
  const { effectiveNow, boundaryDate, baseline, latest, coverage } = windowDetails(snapshots, repository.id, targetDays, now, timeZone);
  const delta = baseline && latest && baseline.stars !== null && latest.stars !== null
    ? latest.stars - baseline.stars
    : null;
  const observedWindowDays = baseline && latest ? dateDistance(baseline.effectiveDate, latest.effectiveDate) : null;
  const exactWindow = Boolean(
    baseline
    && latest
    && baseline.effectiveDate === boundaryDate
    && latest.effectiveDate === effectiveNow
    && observedWindowDays === targetDays,
  );
  const reasons = [coverageReason(coverage)];
  if (!latest) reasons.push("当前窗口没有实际观测，继续收集。");
  else if (!baseline) reasons.push("缺少合格的历史基线，继续收集。");
  else if (baseline.stars === null || latest.stars === null) reasons.push("基线或当前 Star 缺失，继续收集。");
  else if (exactWindow) reasons.push(`与 ${targetDays} 天前基线相比。`);
  else reasons.push(`与 ${baseline.effectiveDate} 基线相比（实际 ${observedWindowDays} 天窗口，非请求的精确窗口）。`);
  if (delta !== null) reasons.push(`观测 Star 变化：${delta >= 0 ? "+" : ""}${delta}。`);
  reasons.push(...repositoryReasons(repository));
  return {
    repositoryId: repository.id,
    repository,
    status: delta === null ? "collecting" : coverage.complete && exactWindow ? "complete" : "incomplete",
    observedStarDelta: delta,
    currentStars: latest?.stars ?? null,
    coverage,
    baseline: baseline ? {
      ...baseline,
      observedWindowDays,
      exactWindow,
    } : null,
    latest,
    reasons,
  };
}

function trendStatusOrder(entry) {
  return entry.status === "complete" ? 0 : entry.status === "incomplete" ? 1 : 2;
}

export function rankRising(input = {}) {
  const { targetDays, limit } = periodConfig(input.period ?? "week");
  const timeZone = requireTimeZone(input.timeZone ?? "UTC");
  const now = requireNow(input.now ?? new Date());
  return (Array.isArray(input.repositories) ? input.repositories : [])
    .filter((repository) => repository && Number.isSafeInteger(repository.id) && repository.id > 0)
    .map((repository) => trendEntry(repository, input.snapshots, targetDays, now, timeZone))
    .sort((left, right) => (
      trendStatusOrder(left) - trendStatusOrder(right)
      || availability(left.repository) - availability(right.repository)
      || (right.observedStarDelta ?? -Infinity) - (left.observedStarDelta ?? -Infinity)
      || (right.currentStars ?? -Infinity) - (left.currentStars ?? -Infinity)
      || left.repositoryId - right.repositoryId
    ))
    .slice(0, limit);
}

function maintenanceTimestamp(repository) {
  const timestamp = new Date(repository.pushedAt ?? repository.updatedAt ?? 0).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function rankEstablished(input = {}) {
  const { limit } = periodConfig(input.period ?? "week");
  return (Array.isArray(input.repositories) ? input.repositories : [])
    .filter((repository) => repository && Number.isSafeInteger(repository.id) && repository.id > 0)
    .map((repository) => {
      const reasons = [];
      if (typeof repository.stars === "number") reasons.push(`当前 Star：${repository.stars}。`);
      else reasons.push("当前 Star 缺失。");
      if (repository.pushedAt || repository.updatedAt) reasons.push(`最近维护：${(repository.pushedAt ?? repository.updatedAt).slice(0, 10)}。`);
      if (repository.license) reasons.push(`许可证：${repository.license}。`);
      reasons.push(...repositoryReasons(repository));
      return {
        repositoryId: repository.id,
        repository,
        currentStars: typeof repository.stars === "number" ? repository.stars : null,
        maintainedAt: repository.pushedAt ?? repository.updatedAt ?? null,
        license: repository.license ?? null,
        preservedHistory: repository.preservedAt !== null && repository.preservedAt !== undefined,
        reasons,
      };
    })
    .sort((left, right) => (
      availability(left.repository) - availability(right.repository)
      || (right.currentStars ?? -Infinity) - (left.currentStars ?? -Infinity)
      || maintenanceTimestamp(right.repository) - maintenanceTimestamp(left.repository)
      || left.repositoryId - right.repositoryId
    ))
    .slice(0, limit);
}

function matchingPreferences(repository, preferences) {
  const more = [];
  const less = [];
  for (const preference of Array.isArray(preferences) ? preferences : []) {
    if (!preference || preference.revertedAt !== null || (preference.direction !== "more" && preference.direction !== "less")) continue;
    const scopedElsewhere = preference.repositoryId !== null && preference.repositoryId !== undefined && preference.repositoryId !== repository.id;
    if (scopedElsewhere) continue;
    const value = typeof preference.value === "string" ? preference.value.trim() : "";
    let matched = false;
    let label = "";
    if (preference.kind === "repository" && preference.repositoryId === repository.id && value === String(repository.id)) {
      matched = true;
      label = `仓库 ${repository.fullName}`;
    } else if (preference.kind === "topic" && Array.isArray(repository.topics) && repository.topics.some((topic) => topic.toLowerCase() === value.toLowerCase())) {
      matched = true;
      label = `主题 ${value}`;
    } else if (preference.kind === "language" && typeof repository.language === "string" && repository.language.toLowerCase() === value.toLowerCase()) {
      matched = true;
      label = `语言 ${value}`;
    }
    if (matched) (preference.direction === "more" ? more : less).push(label);
  }
  return { more: [...new Set(more)].sort(), less: [...new Set(less)].sort() };
}

function validRelevance(entry) {
  return entry
    && Number.isSafeInteger(entry.repositoryId)
    && entry.repositoryId > 0
    && FOCUS_AREAS.has(entry.direction)
    && Object.hasOwn(RELEVANCE_ORDER, entry.relevance)
    && typeof entry.reasonCode === "string"
    && /^[A-Z0-9_]{1,64}$/.test(entry.reasonCode)
    && typeof entry.reason === "string"
    && entry.reason.trim().length > 0
    && entry.reason.trim().length <= 200;
}

function relevanceByRepository(relevance) {
  const result = new Map();
  for (const entry of Array.isArray(relevance) ? relevance : []) {
    if (!validRelevance(entry)) continue;
    const normalized = {
      repositoryId: entry.repositoryId,
      direction: entry.direction,
      relevance: entry.relevance,
      reasonCode: entry.reasonCode,
      reason: entry.reason.trim(),
    };
    const previous = result.get(normalized.repositoryId);
    if (!previous || RELEVANCE_ORDER[normalized.relevance] > RELEVANCE_ORDER[previous.relevance]
      || (RELEVANCE_ORDER[normalized.relevance] === RELEVANCE_ORDER[previous.relevance]
        && `${normalized.reasonCode}:${normalized.reason}` < `${previous.reasonCode}:${previous.reason}`)) {
      result.set(normalized.repositoryId, normalized);
    }
  }
  return result;
}

export function rankRelevant(input = {}) {
  const { limit } = periodConfig(input.period ?? "week");
  const relevance = relevanceByRepository(input.relevance);
  return (Array.isArray(input.repositories) ? input.repositories : [])
    .filter((repository) => repository && Number.isSafeInteger(repository.id) && repository.id > 0)
    .map((repository) => {
      const preferences = matchingPreferences(repository, input.preferences);
      const classifier = relevance.get(repository.id) ?? null;
      const reasons = [];
      for (const focus of Array.isArray(repository.focusAreas) ? [...new Set(repository.focusAreas)].sort() : []) {
        if (FOCUS_AREAS.has(focus)) reasons.push(`关注方向：${focus}。`);
      }
      for (const match of preferences.more) reasons.push(`偏好更多：${match}。`);
      for (const match of preferences.less) reasons.push(`偏好更少：${match}。`);
      if (classifier) reasons.push(`分类器（${classifier.relevance}）：${classifier.reason}`);
      reasons.push(...repositoryReasons(repository));
      return {
        repositoryId: repository.id,
        repository,
        focusAreas: Array.isArray(repository.focusAreas) ? [...new Set(repository.focusAreas)].filter((focus) => FOCUS_AREAS.has(focus)).sort() : [],
        preferenceMatches: preferences,
        classifierRelevance: classifier,
        reasons,
      };
    })
    .sort((left, right) => (
      availability(left.repository) - availability(right.repository)
      || Number(right.preferenceMatches.more.length > 0) - Number(left.preferenceMatches.more.length > 0)
      || Number(left.preferenceMatches.less.length > 0) - Number(right.preferenceMatches.less.length > 0)
      || (RELEVANCE_ORDER[right.classifierRelevance?.relevance] ?? 0) - (RELEVANCE_ORDER[left.classifierRelevance?.relevance] ?? 0)
      || left.repositoryId - right.repositoryId
    ))
    .slice(0, limit);
}

export function rankRadar(input = {}) {
  return {
    rising: rankRising(input),
    established: rankEstablished(input),
    relevant: rankRelevant(input),
  };
}
