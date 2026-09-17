import { randomUUID } from "node:crypto";
import { z } from "zod";
import { rankRadar } from "../../shared/ai-radar-ranking.mjs";
import { radarLocalDate, radarRepositorySchema, radarTimeZoneSchema } from "./radar-schema.mjs";
import { RadarRepositoryError, safeRadarError } from "./radar-repository.mjs";

const focusSchema = z.array(z.enum(["agent", "ai-coding", "rag-knowledge", "ai-productivity"])).min(1).max(4)
  .refine((items) => new Set(items).size === items.length);
const timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const triggerSchema = z.enum(["manual", "schedule", "startup"]);
function invalid() { throw new RadarRepositoryError("RADAR_INVALID_INPUT", "雷达采集选项无效。"); }
function safeFailureFullName(failure) {
  try {
    const fullName = failure?.fullName;
    return typeof fullName === "string" && fullName.length <= 240 ? fullName.toLowerCase() : null;
  } catch { return null; }
}

// One instance per active workspace. Overlapping calls join the first trigger's
// run; no unbounded request queue and no network request under a storage lock.
export function createRadarCollector({ github, repository, rank = rankRadar, now = () => new Date(), timeZone,
  focusAreas = ["agent", "ai-coding", "rag-knowledge", "ai-productivity"], maxCandidates = 100, maxDetails = 10 } = {}) {
  if (!github?.discoverCandidates || !github?.getRepositories || !repository?.beginCollection || !repository?.commitCollection ||
      !focusSchema.safeParse(focusAreas).success || !radarTimeZoneSchema.safeParse(timeZone).success ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 500 ||
      !Number.isInteger(maxDetails) || maxDetails < 1 || maxDetails > 200 || typeof rank !== "function") invalid();
  focusAreas = [...focusAreas];
  const clock = () => new Date(now()).toISOString();
  let active = null;
  let memoryRetryAt = null;

  function collect({ trigger } = {}) {
    if (!triggerSchema.safeParse(trigger).success) return Promise.reject(new RadarRepositoryError("RADAR_INVALID_INPUT", "雷达采集触发方式无效。"));
    if (active) return active;
    const operation = execute(trigger);
    active = operation.finally(() => { active = null; });
    return active;
  }

  async function execute(trigger) {
    const startedAt = clock();
    let run = { id: randomUUID(), trigger, startedAt, finishedAt: null, status: "running", localDate: radarLocalDate(startedAt, timeZone),
      timeZone, repositoryCount: 0, errors: [], sequence: 0, collection: null };
    let state;
    try { state = await repository.getState(); } catch (error) {
      if (error?.code === "WORKSPACE_BINDING_CHANGED") throw error;
      return persistenceFailure(run);
    }
    let retryAt = [state.collection.retryAt, memoryRetryAt].filter((value) => value && value > startedAt).sort().at(-1) ?? null;
    if (retryAt) {
      return { run: { ...run, status: "skipped", finishedAt: startedAt, errors: [safeRadarError({ code: "RADAR_COOLDOWN" })] }, persisted: false, retryAt };
    }
    try { run = await repository.beginCollection(run); } catch (error) {
      if (error?.code === "WORKSPACE_BINDING_CHANGED") throw error;
      return persistenceFailure(run);
    }
    const trackedIds = new Set(state.decisions.filter((decision) => ["saved", "summarized", "queued", "learning", "completed"].includes(decision.status)).map((decision) => decision.repositoryId));
    const tracked = state.repositories.filter((item) => item.preservedAt || trackedIds.has(item.id)).sort((a, b) => a.id - b.id);
    const observed = new Map();
    const errors = [];
    let partial = false, truncated = false, discoveredCount = 0, detailRequestedCount = 0, failedCount = 0;
    let cursor = state.collection.detailCursorId;
    const attemptedIds = new Set();
    const error = (value) => { failedCount++; partial = true; if (errors.length < 100) errors.push(safeRadarError(value)); };

    async function request(kind, selected = []) {
      let result;
      try {
        if (kind === "discovery") {
          // Rotate search priority even with fixed/backward clocks and tiny budgets.
          const offset = (run.sequence - 1) % focusAreas.length;
          result = await github.discoverCandidates({ focusAreas: [...focusAreas.slice(offset), ...focusAreas.slice(0, offset)],
            maxCandidates, maxPages: 1, perPage: Math.min(25, maxCandidates) });
        } else {
          detailRequestedCount += selected.length;
          result = await github.getRepositories({ repositories: selected.map(({ fullName, focusAreas }) => ({ fullName, focusAreas })) });
        }
        if (!result || !Array.isArray(result.repositories) || !Array.isArray(result.errors) || typeof result.partial !== "boolean" || typeof result.truncated !== "boolean" ||
            (result.retryAt !== null && !timestamp.safeParse(result.retryAt).success)) throw { code: "RADAR_INVALID_BATCH" };
      } catch (failure) {
        error(failure);
        if (selected[0]) { attemptedIds.add(selected[0].id); cursor = selected[0].id; }
        return;
      }
      partial ||= result.partial; truncated ||= result.truncated;
      const parsedRetry = result.retryAt ? timestamp.parse(result.retryAt) : null;
      if (parsedRetry && parsedRetry > clock()) retryAt = !retryAt || parsedRetry > retryAt ? parsedRetry : retryAt;
      const returnedNames = new Set(), returnedIds = new Set();
      const limit = kind === "discovery" ? maxCandidates : selected.length;
      truncated ||= result.repositories.length > limit;
      for (const input of result.repositories.slice(0, limit)) {
        const parsed = radarRepositorySchema.safeParse(input);
        if (!parsed.success) { error({ code: "RADAR_INVALID_BATCH" }); continue; }
        const item = parsed.data;
        if (kind !== "discovery" && !selected.some((entry) => entry.id === item.id || entry.fullName.toLowerCase() === item.fullName.toLowerCase())) {
          error({ code: "RADAR_INVALID_BATCH" }); continue;
        }
        returnedNames.add(item.fullName.toLowerCase()); returnedIds.add(item.id);
        if (item.observedAt < startedAt || item.observedAt > clock()) { error({ code: "RADAR_STALE_OBSERVATION" }); continue; }
        if (kind === "discovery") discoveredCount++;
        const previous = observed.get(item.id);
        if (!previous || item.observedAt >= previous.observedAt) observed.set(item.id, {
          ...item, focusAreas: [...new Set([...(previous?.focusAreas ?? []), ...item.focusAreas])], preservedAt: null,
        });
      }
      for (const failure of result.errors.slice(0, 200)) {
        error(failure);
        const fullName = safeFailureFullName(failure);
        if (fullName) returnedNames.add(fullName);
      }
      if (result.errors.length > 200) partial = true;
      for (const item of selected) {
        const identified = returnedIds.has(item.id) || returnedNames.has(item.fullName.toLowerCase());
        if (identified || !parsedRetry) { attemptedIds.add(item.id); cursor = item.id; }
        if (!identified && !parsedRetry) error({ code: "RADAR_INVALID_BATCH" });
      }
    }

    async function details() {
      if (retryAt) return;
      const missing = tracked.filter((item) => !observed.has(item.id));
      const next = missing.findIndex((item) => cursor === null || item.id > cursor);
      const offset = next === -1 ? 0 : next;
      const selected = [...missing.slice(offset), ...missing.slice(0, offset)].slice(0, maxDetails);
      if (selected.length) await request("details", selected);
    }
    if (state.collection.detailsFirst && tracked.length) {
      await details();
      if (!retryAt) await request("discovery");
    } else {
      await request("discovery");
      await details();
    }
    const finishedAt = [startedAt, clock()].sort().at(-1);
    const items = [...observed.values()];
    const deferredCount = tracked.filter((item) => !observed.has(item.id) && !attemptedIds.has(item.id)).length;
    const coverage = { discoveredCount, trackedCount: tracked.length, detailRequestedCount, observedCount: items.length,
      failedCount, deferredCount, truncated, partial, retryAt };
    run = { ...run, finishedAt, status: partial || retryAt ? items.length ? "partial" : "failed" : "success", repositoryCount: items.length, errors, collection: coverage };
    memoryRetryAt = retryAt;
    try {
      run = await repository.commitCollection({ repositories: items, run, control: { retryAt, detailCursorId: cursor, detailsFirst: !state.collection.detailsFirst } });
    } catch (error) {
      if (error?.code === "WORKSPACE_BINDING_CHANGED") throw error;
      return persistenceFailure(run, retryAt);
    }
    // Ranking is a read-only projection, deliberately outside the commit lock.
    // A later query failure cannot turn a durable successful commit into failure.
    let dashboard = null;
    try { dashboard = await repository.getDashboard({ timeZone, rank }); } catch { /* Routes can retry the read. */ }
    return { run, persisted: true, retryAt, dashboard };
  }

  function persistenceFailure(run, retryAt = memoryRetryAt) {
    return { run: { ...run, status: "failed", finishedAt: [run.startedAt, clock()].sort().at(-1), errors: [safeRadarError(null, "RADAR_PERSISTENCE_FAILED")] }, persisted: false, retryAt };
  }
  return Object.freeze({ collect });
}
