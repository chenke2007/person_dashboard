import { z } from "zod";
import path from "node:path";

export const MAX_RADAR_BYTES = 32 * 1024 * 1024;
export const RADAR_RETENTION_DAYS = 400;
const timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const nullableTimestamp = timestamp.nullable();
const repositoryId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metric = count.nullable();
const date = z.string().date();
const safeText = (maximum) => z.string().max(maximum).refine((value) => {
  const text = value.trim();
  return !path.win32.isAbsolute(text) && !path.posix.isAbsolute(text) &&
    !/(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/[A-Za-z0-9_.-]+\/)/i.test(text) &&
    !/\b(?:authorization|cookie|set-cookie)\s*:/i.test(text) &&
    !/\b(?:token|api[_-]?key|password|secret)\s*[:=]\s*\S+/i.test(text) &&
    !/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text);
}, "absolute paths are not radar metadata");
const dateFormatters = new Map();
function dateFormatter(timeZone) {
  if (dateFormatters.has(timeZone)) return dateFormatters.get(timeZone);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  if (dateFormatters.size < 128) dateFormatters.set(timeZone, formatter);
  return formatter;
}
export const radarTimeZoneSchema = z.string().min(1).max(100).refine((value) => {
  try { dateFormatter(value); return true; } catch { return false; }
}, "invalid IANA time zone");

export function radarLocalDate(capturedAt, timeZone) {
  const parts = dateFormatter(timeZone).formatToParts(new Date(capturedAt));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}
const uniqueStrings = (schema, maximum) => z.array(schema).max(maximum).refine((items) => new Set(items).size === items.length, "duplicate values");
const fullName = z.string().max(240).regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/);
export const radarRepositorySchema = z.object({
  id: repositoryId, fullName,
  htmlUrl: z.string().max(300).regex(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/),
  description: safeText(2_000).nullable(), language: safeText(100).nullable(),
  topics: uniqueStrings(z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/), 100),
  focusAreas: uniqueStrings(z.enum(["agent", "ai-coding", "rag-knowledge", "ai-productivity"]), 4).default([]),
  stars: metric, forks: metric, openIssues: metric, archived: z.boolean(), fork: z.boolean(),
  license: safeText(100).nullable(), defaultBranch: safeText(240).nullable(),
  createdAt: nullableTimestamp, updatedAt: nullableTimestamp, pushedAt: nullableTimestamp, observedAt: timestamp,
  preservedAt: nullableTimestamp.default(null),
}).strict().refine((item) => item.htmlUrl.toLowerCase() === `https://github.com/${item.fullName}`.toLowerCase(), "repository URL must match fullName");

export const radarSnapshotInputSchema = z.object({ repositoryId, stars: metric, forks: metric, openIssues: metric }).strict();
export const radarSnapshotSchema = radarSnapshotInputSchema.extend({ capturedAt: timestamp, capturedDate: date, timeZone: radarTimeZoneSchema }).strict().superRefine((item, context) => {
  if (timestamp.safeParse(item.capturedAt).success && radarTimeZoneSchema.safeParse(item.timeZone).success && radarLocalDate(item.capturedAt, item.timeZone) !== item.capturedDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "snapshot date must match observation time zone" });
  }
});
export const radarRunSchema = z.object({
  id: z.string().uuid(), trigger: z.enum(["manual", "schedule", "startup"]),
  startedAt: timestamp, finishedAt: nullableTimestamp,
  status: z.enum(["running", "success", "partial", "failed", "skipped"]),
  localDate: date, timeZone: radarTimeZoneSchema, repositoryCount: count,
  errors: z.array(z.object({ code: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/), message: safeText(500) }).strict()).max(100),
}).strict().superRefine((item, context) => {
  if ((item.status === "running") !== (item.finishedAt === null) || (item.finishedAt && item.finishedAt < item.startedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "run timestamps disagree with status" });
  }
  if (timestamp.safeParse(item.startedAt).success && radarTimeZoneSchema.safeParse(item.timeZone).success && radarLocalDate(item.startedAt, item.timeZone) !== item.localDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "run local date must match its start" });
  }
});
export const radarDecisionStatusSchema = z.enum(["unread", "saved", "summarized", "queued", "learning", "completed", "ignored"]);
export const radarDecisionSchema = z.object({ repositoryId, status: radarDecisionStatusSchema, updatedAt: timestamp }).strict();
export const radarPreferenceInputSchema = z.object({
  repositoryId: repositoryId.nullable(), kind: z.enum(["topic", "language", "repository"]),
  value: safeText(240).refine((value) => value.trim().length > 0), direction: z.enum(["more", "less"]),
}).strict();
export const radarPreferenceSchema = radarPreferenceInputSchema.extend({ id: z.string().uuid(), createdAt: timestamp, revertedAt: nullableTimestamp }).strict();
export const radarScheduleSchema = z.object({
  enabled: z.boolean(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timeZone: radarTimeZoneSchema,
  lastAttemptAt: nullableTimestamp, lastSuccessAt: nullableTimestamp, nextRunAt: nullableTimestamp,
}).strict();
const aggregateSchema = z.object({
  repositoryId, month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  observedDates: uniqueStrings(date, 31).refine((items) => items.length > 0), first: radarSnapshotSchema, last: radarSnapshotSchema,
}).strict().superRefine((item, context) => {
  const dates = [...item.observedDates].sort();
  if (item.observedDates.some((value) => !value.startsWith(`${item.month}-`)) ||
      item.first.repositoryId !== item.repositoryId || item.last.repositoryId !== item.repositoryId ||
      item.first.capturedDate !== dates[0] || item.last.capturedDate !== dates.at(-1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "monthly aggregate observations must belong to repository and month" });
  }
});
export const radarStoreSchema = z.object({
  version: z.literal(1), revision: count, updatedAt: nullableTimestamp,
  repositories: z.array(radarRepositorySchema).max(10_000), snapshots: z.array(radarSnapshotSchema).max(200_000),
  runs: z.array(radarRunSchema).max(10_000), decisions: z.array(radarDecisionSchema).max(10_000),
  preferences: z.array(radarPreferenceSchema).max(20_000), schedule: radarScheduleSchema,
  retention: z.object({ dailyDays: z.literal(RADAR_RETENTION_DAYS), lastAppliedDate: date.nullable() }).strict(),
  monthlyAggregates: z.array(aggregateSchema).max(120_000),
}).strict().superRefine((store, context) => {
  const issue = (field, index, message) => context.addIssue({ code: z.ZodIssueCode.custom, path: [field, index], message });
  const unique = (field, key) => {
    const seen = new Set();
    store[field].forEach((item, index) => {
      const value = key(item); if (seen.has(value)) issue(field, index, "duplicate record identity"); seen.add(value);
    });
  };
  for (const field of ["repositories", "runs", "preferences"]) unique(field, (item) => item.id);
  unique("repositories", (item) => item.fullName.toLowerCase());
  unique("snapshots", (item) => `${item.repositoryId}:${item.capturedDate}`);
  unique("decisions", (item) => item.repositoryId);
  unique("monthlyAggregates", (item) => `${item.repositoryId}:${item.month}`);
  const repositories = new Map(store.repositories.map((item) => [item.id, item]));
  for (const field of ["snapshots", "decisions", "preferences", "monthlyAggregates"]) {
    store[field].forEach((item, index) => {
      if (item.repositoryId !== null && !repositories.has(item.repositoryId)) issue(field, index, "unknown repository");
    });
  }
  store.preferences.forEach((item, index) => {
    if (item.kind === "repository" && (item.repositoryId === null || item.value !== String(item.repositoryId))) issue("preferences", index, "repository preference requires matching id value");
    if (item.revertedAt && item.revertedAt < item.createdAt) issue("preferences", index, "reversion precedes signal");
  });
  store.decisions.forEach((item, index) => {
    if (["saved", "queued", "learning", "completed"].includes(item.status) && !repositories.get(item.repositoryId)?.preservedAt) issue("decisions", index, "saved history must be preserved");
  });
});
export function emptyRadarStore(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return radarStoreSchema.parse({
    version: 1, revision: 0, updatedAt: null, repositories: [], snapshots: [], runs: [], decisions: [], preferences: [],
    schedule: { enabled: false, time: "08:00", timeZone, lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null },
    retention: { dailyDays: RADAR_RETENTION_DAYS, lastAppliedDate: null }, monthlyAggregates: [],
  });
}
