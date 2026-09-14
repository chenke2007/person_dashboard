import { z } from "zod";
import path from "node:path";

export const MAX_SUMMARY_BYTES = 32 * 1024 * 1024;

const timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const nullableTimestamp = timestamp.nullable();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const repositoryIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// Summary content is generated from untrusted repository evidence (README), so
// the same privacy guardrails as radar/learning metadata apply: reject absolute
// paths and credential-like assignments so a README example can never be
// persisted as a stored credential or local path, even if the model quotes it.
export function summarySafeText(maximum) {
  return z.string().max(maximum).refine((value) => {
    const text = value.trim();
    return !path.win32.isAbsolute(text) && !path.posix.isAbsolute(text) &&
      !/(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/[A-Za-z0-9_.-]+\/)/i.test(text) &&
      !/\b(?:authorization|cookie|set-cookie)\s*:/i.test(text) &&
      !/\b(?:token|api[_-]?key|password|secret)\s*[:=]\s*\S+/i.test(text) &&
      !/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text);
  }, "absolute paths are not summary metadata");
}

const fullNameSchema = z.string().max(240).regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/);
const sourceUrlSchema = z.string().max(300).regex(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/);
const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const blobShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const readmePathSchema = z.string().max(240).regex(/^[A-Za-z0-9_. /-]{1,240}$/).optional().nullable();
const refSchema = z.string().max(240).optional().nullable();

export const SUMMARY_SECTION_KEYS = Object.freeze([
  "problemSolved",
  "coreCapabilities",
  "techStack",
  "keyModules",
  "suitableUseCases",
  "unsuitableUseCases",
  "learningGoalCandidates",
  "risksAndBoundaries",
]);

export const summarySectionsSchema = z.object({
  problemSolved: summarySafeText(4_000),
  coreCapabilities: summarySafeText(4_000),
  techStack: summarySafeText(4_000),
  keyModules: summarySafeText(4_000),
  suitableUseCases: summarySafeText(4_000),
  unsuitableUseCases: summarySafeText(4_000),
  learningGoalCandidates: summarySafeText(4_000),
  risksAndBoundaries: summarySafeText(4_000),
}).strict();

export function summaryGenerationKey(item) {
  return `${item.repositoryId}:${item.sourceCommitSha}:${item.readmeSha ?? ""}`;
}

const summaryRecordShape = {
  repositoryId: repositoryIdSchema,
  fullName: fullNameSchema,
  sourceUrl: sourceUrlSchema,
  sourceCommitSha: commitShaSchema,
  readmeSha: blobShaSchema.nullable().default(null),
  readmeRef: refSchema,
  readmePath: readmePathSchema,
  sections: summarySectionsSchema,
  model: z.object({
    providerId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
    modelId: z.string().min(1).max(120),
  }).strict(),
  workflowVersion: z.literal(1),
};

const summaryIdentityRefine = (schema) => schema
  .refine((item) => item.sourceUrl.toLowerCase() === `https://github.com/${item.fullName}`.toLowerCase(), "source URL must match full name")
  .refine((item) => (item.readmeSha === null) === (item.readmeRef === null), "readme identity is either fully present or absent")
  .refine((item) => item.readmeSha === null || item.readmeRef !== null, "readme ref required when readme sha present");

export const summaryRecordInputSchema = summaryIdentityRefine(z.object(summaryRecordShape).strict());

export const summaryRecordSchema = summaryIdentityRefine(z.object({
  summaryId: z.string().uuid(),
  generatedAt: timestamp,
  ...summaryRecordShape,
}).strict());

export const summaryStoreSchema = z.object({
  version: z.literal(1),
  revision: count,
  updatedAt: nullableTimestamp,
  summaries: z.array(summaryRecordSchema).max(50_000),
}).strict().superRefine((store, context) => {
  const issue = (field, index, message) => context.addIssue({ code: z.ZodIssueCode.custom, path: [field, index], message });
  const seenId = new Set();
  const seenKey = new Set();
  store.summaries.forEach((summary, index) => {
    if (seenId.has(summary.summaryId)) issue("summaries", index, "duplicate summary identity");
    seenId.add(summary.summaryId);
    const key = summaryGenerationKey(summary);
    if (seenKey.has(key)) issue("summaries", index, "duplicate generation key");
    seenKey.add(key);
  });
});

export function emptySummaryStore() {
  return summaryStoreSchema.parse({ version: 1, revision: 0, updatedAt: null, summaries: [] });
}