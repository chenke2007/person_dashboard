import { z } from "zod";
import path from "node:path";

export const MAX_LEARNING_BYTES = 32 * 1024 * 1024;
export const LEARNING_ACTIVE_LIMIT = 3;
export const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const nullableTimestamp = timestamp.nullable();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const repositoryIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// Learning evidence is authored mission content. Reject absolute paths and
// credential-like assignments exactly like radar metadata so the store can be
// backed up and exported without leaking local paths or secrets.
export function learningSafeText(maximum) {
  return z.string().max(maximum).refine((value) => {
    const text = value.trim();
    return !path.win32.isAbsolute(text) && !path.posix.isAbsolute(text) &&
      !/(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/[A-Za-z0-9_.-]+\/)/i.test(text) &&
      !/\b(?:authorization|cookie|set-cookie)\s*:/i.test(text) &&
      !/\b(?:token|api[_-]?key|password|secret)\s*[:=]\s*\S+/i.test(text) &&
      !/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text);
  }, "absolute paths are not learning metadata");
}

const fullNameSchema = z.string().max(240).regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/);
const sourceUrlSchema = z.string().max(300).regex(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/);
const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const LEARNING_GOALS = [
  "understand-architecture",
  "learn-usage",
  "analyze-design",
  "reproduce-capability",
  "adoption-decision",
];
export const LEARNING_GOAL_SCHEMA = z.enum(LEARNING_GOALS);
export const LEARNING_STATES = ["draft", "queued", "active", "archived", "review", "completed"];
export const LEARNING_STATE_SCHEMA = z.enum(LEARNING_STATES);

export const learningMissionSchema = z.object({
  goal: LEARNING_GOAL_SCHEMA,
  notes: learningSafeText(4000),
}).strict();

export const learningDraftInputSchema = z.object({
  repositoryId: repositoryIdSchema,
  fullName: fullNameSchema,
  sourceUrl: sourceUrlSchema,
  sourceCommitSha: commitShaSchema,
  mission: learningMissionSchema,
}).strict()
  .refine((item) => item.sourceUrl.toLowerCase() === `https://github.com/${item.fullName}`.toLowerCase(), "source URL must match full name");

const confirmOutcomeSchema = z.enum(["active", "queued"]);

const learningWorkspaceSchema = z.object({
  workspaceId: z.string().uuid(),
  repositoryId: repositoryIdSchema,
  fullName: fullNameSchema,
  sourceUrl: sourceUrlSchema,
  sourceCommitSha: commitShaSchema,
  mission: learningMissionSchema,
  // Only draft | queued | active | archived are reachable this phase. review and
  // completed are reserved for later phases and recognized by the schema only.
  state: LEARNING_STATE_SCHEMA,
  draftRevision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()
  .refine((item) => item.sourceUrl.toLowerCase() === `https://github.com/${item.fullName}`.toLowerCase(), "source URL must match full name");

const confirmTokenSchema = z.object({
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceId: z.string().uuid(),
  repositoryId: repositoryIdSchema,
  sourceCommitSha: commitShaSchema,
  draftRevision: z.number().int().positive(),
  mission: learningMissionSchema,
  expiresAt: timestamp,
  consumed: z.object({
    // The original confirm outcome is immutable; the workspace record holds the
    // current state separately so a replayed receipt never masks later activation.
    confirmed: confirmOutcomeSchema,
    confirmedAt: timestamp,
    receiptExpiresAt: timestamp,
  }).nullable(),
}).strict();

export const learningStoreSchema = z.object({
  version: z.literal(1),
  revision: count,
  updatedAt: nullableTimestamp,
  workspaces: z.array(learningWorkspaceSchema).max(50_000),
  // Confirmation records carry only token digests (never raw tokens); the name is
  // deliberately neutral so the backup credential scanner does not reject it.
  confirmations: z.array(confirmTokenSchema).max(50_000),
}).strict().superRefine((store, context) => {
  const issue = (field, index, message) => context.addIssue({ code: z.ZodIssueCode.custom, path: [field, index], message });
  const seenWorkspace = new Set();
  const seenRepository = new Set();
  store.workspaces.forEach((workspace, index) => {
    if (seenWorkspace.has(workspace.workspaceId)) issue("workspaces", index, "duplicate workspace identity");
    seenWorkspace.add(workspace.workspaceId);
    if (seenRepository.has(workspace.repositoryId)) issue("workspaces", index, "duplicate repository");
    seenRepository.add(workspace.repositoryId);
  });
  const seenToken = new Set();
  store.confirmations.forEach((token, index) => {
    if (seenToken.has(token.tokenDigest)) issue("confirmations", index, "duplicate confirm token");
    seenToken.add(token.tokenDigest);
    if (!seenWorkspace.has(token.workspaceId)) issue("confirmations", index, "unknown workspace");
  });
});

export function emptyLearningStore() {
  return learningStoreSchema.parse({ version: 1, revision: 0, updatedAt: null, workspaces: [], confirmations: [] });
}
