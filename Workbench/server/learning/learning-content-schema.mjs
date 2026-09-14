import { z } from "zod";
import path from "node:path";

// Content of an independent learning workspace. Mirrors the privacy rules of
// the learning/summary stores: authored text goes through the same absolute-
// path and credential-style rejections so a plan, note or artifact can never
// carry a local path or a secret-like assignment, even when a model quoted it.
// Field names deliberately avoid the unified backup scanner's Vault-body keys
// (body/content/markdown/readme), so authored bodies are named `markdownText`
// and the merged learning-provider export embeds content under `contentRecords`.

export const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
export const MAX_LEARNING_PLAN_CHARS = 4_000;
export const MAX_NOTE_CHARS = 200_000;
export const MAX_ARTIFACT_TEXT_CHARS = 100_000;
export const MAX_MILESTONES = 100;
export const MAX_ARTIFACTS = 1_000;

const timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const repositoryIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const workspaceIdSchema = z.string().uuid();

export function contentSafeText(maximum) {
  return z.string().max(maximum).refine((value) => {
    const text = value.trim();
    return !path.win32.isAbsolute(text) && !path.posix.isAbsolute(text) &&
      !/(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/[A-Za-z0-9_.-]+\/)/i.test(text) &&
      !/\b(?:authorization|cookie|set-cookie)\s*:/i.test(text) &&
      !/\b(?:token|api[_-]?key|password|secret)\s*[:=]\s*\S+/i.test(text) &&
      !/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text);
  }, "absolute paths and credential-like text are not learning content");
}

// The binding is derived by the service from the learning workspace that was
// created with a fixed source. The browser never provides it.
export const contentBindingSchema = z.object({
  repositoryId: repositoryIdSchema,
  sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  sourceUrl: z.string().max(300).regex(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/),
}).strict();

// Milestone ids are stable edit keys owned by the client form; a bounded
// readable string keeps the summary-derived draft directly saveable and the
// UI deterministic under tests.
const milestoneIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

const milestoneSchema = z.object({
  milestoneId: milestoneIdSchema,
  title: contentSafeText(200),
  done: z.boolean(),
}).strict();

export const learningPlanInputSchema = z.object({
  learningGoal: contentSafeText(MAX_LEARNING_PLAN_CHARS),
  expectedOutcome: contentSafeText(MAX_LEARNING_PLAN_CHARS),
  milestones: z.array(milestoneSchema).max(MAX_MILESTONES),
  currentMilestone: milestoneIdSchema.nullable(),
}).strict().superRefine((plan, context) => {
  if (plan.currentMilestone === null) return;
  const exists = plan.milestones.some((milestone) => milestone.milestoneId === plan.currentMilestone);
  if (!exists) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["currentMilestone"], message: "current milestone must reference an existing milestone" });
  }
});

export const emptyLearningPlan = () => learningPlanInputSchema.parse({
  learningGoal: "",
  expectedOutcome: "",
  milestones: [],
  currentMilestone: null,
});

export const notesInputSchema = z.object({
  markdownText: contentSafeText(MAX_NOTE_CHARS),
}).strict();

export const artifactInputSchema = z.object({
  type: contentSafeText(40),
  title: contentSafeText(200),
  markdownText: contentSafeText(MAX_ARTIFACT_TEXT_CHARS),
}).strict();

const artifactRecordSchema = artifactInputSchema.extend({
  artifactId: workspaceIdSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const learningPlanRecordSchema = learningPlanInputSchema;

export const contentRecordSchema = z.object({
  workspaceId: workspaceIdSchema,
  repositoryId: repositoryIdSchema,
  sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  sourceUrl: z.string().max(300).regex(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/),
  revision: z.number().int().positive(),
  learningPlan: learningPlanRecordSchema,
  notes: z.object({
    markdownText: contentSafeText(MAX_NOTE_CHARS),
    updatedAt: timestamp,
  }).strict().nullable(),
  artifacts: z.array(artifactRecordSchema).max(MAX_ARTIFACTS),
  updatedAt: timestamp,
}).strict();

export const contentStoreSchema = z.object({
  version: z.literal(1),
  revision: count,
  updatedAt: timestamp.nullable(),
  records: z.array(contentRecordSchema).max(50_000),
}).strict().superRefine((store, context) => {
  const seen = new Set();
  store.records.forEach((record, index) => {
    if (seen.has(record.workspaceId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["records", index], message: "duplicate content workspace" });
    }
    seen.add(record.workspaceId);
  });
});

export function emptyContentStore() {
  return contentStoreSchema.parse({ version: 1, revision: 0, updatedAt: null, records: [] });
}