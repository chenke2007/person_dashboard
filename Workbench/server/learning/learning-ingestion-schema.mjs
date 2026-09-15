import { z } from "zod";
import { learningSafeText } from "./learning-schema.mjs";

// Ingestion into a target Obsidian Vault. Field names and content avoid the
// unified backup scanner's Vault-body and credential keys: authored text is
// never exported, token digests live only in the store file, and the export
// shape carries records + selections with no authorization material.

export const MAX_INGESTION_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDS = 1_000;
export const MAX_TOKENS = 1_000;
export const MAX_FILES = 128;
export const MAX_SELECTED_TYPES = 64;
// Preview tokens are intentionally short-lived; successful confirms earn a
// separate receipt window for idempotent replay.
export const INGESTION_TOKEN_TTL_MS = 10 * 60 * 1000;
export const INGESTION_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

const timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const nullableTimestamp = timestamp.nullable();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuidSchema = z.string().uuid();
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const bindingWorkspaceIdSchema = z.string().max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const relativePathSchema = z.string().min(1).max(768);
const safeOptionalText = (maximum) => learningSafeText(maximum).nullable();
const contentKeySchema = z.string().min(1).max(160);

export const ingestionStatusSchema = z.enum(["draft", "previewed", "confirmed", "written", "failed"]);
export const ingestionResolutionSchema = z.enum(["skip", "new-version"]);

export const targetSelectionSchema = z.object({
  workspaceId: uuidSchema,
  targetVaultId: fingerprintSchema,
  targetVaultDisplayName: learningSafeText(120),
  targetMaskedPath: learningSafeText(200),
  selectedAt: timestamp,
}).strict();

export const previewFileSchema = z.object({
  relativePath: relativePathSchema
    .refine((value) => !value.startsWith("/") && !value.includes("\\") && !/^[A-Za-z]:/.test(value), "target paths stay relative"),
  kind: z.enum(["plan", "notes", "artifact"]),
  artifactId: uuidSchema.nullable(),
  existed: z.boolean(),
}).strict();

const bindingSchema = z.object({
  fingerprint: fingerprintSchema,
  workspaceId: bindingWorkspaceIdSchema,
}).strict();

export const ingestionTokenSchema = z.object({
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ingestionId: uuidSchema,
  workspaceId: uuidSchema,
  binding: bindingSchema,
  targetVaultId: fingerprintSchema,
  sourceCommitSha: commitShaSchema,
  contentRevision: z.number().int().nonnegative(),
  previewRevision: count,
  selectedContentTypes: z.array(contentKeySchema).max(MAX_SELECTED_TYPES),
  files: z.array(previewFileSchema).max(MAX_FILES),
  filePlanHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: timestamp,
  expiresAt: timestamp,
  lastAttempt: z.object({
    attemptedAt: timestamp,
    errorCode: safeOptionalText(120),
    errorMessage: safeOptionalText(800),
  }).nullable(),
  consumed: z.object({
    status: z.literal("written"),
    writtenFiles: z.array(relativePathSchema).max(MAX_FILES),
    writtenAt: timestamp,
    receiptExpiresAt: timestamp,
  }).nullable(),
}).strict();

export const ingestionRecordSchema = z.object({
  ingestionId: uuidSchema,
  workspaceId: uuidSchema,
  targetVaultId: fingerprintSchema,
  targetVaultDisplayName: learningSafeText(120),
  targetMaskedPath: learningSafeText(200),
  sourceCommitSha: commitShaSchema,
  contentRevision: z.number().int().nonnegative(),
  previewRevision: count,
  selectedContentTypes: z.array(contentKeySchema).max(MAX_SELECTED_TYPES),
  targetFiles: z.array(previewFileSchema).max(MAX_FILES),
  status: ingestionStatusSchema,
  resolution: ingestionResolutionSchema.nullable(),
  writtenFiles: z.array(relativePathSchema).max(MAX_FILES).nullable(),
  writtenAt: nullableTimestamp,
  attempts: z.number().int().nonnegative(),
  errorCode: safeOptionalText(120),
  errorMessage: safeOptionalText(800),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

function refineIngestionStore(store, context) {
  const issue = (field, index, message) => context.addIssue({ code: z.ZodIssueCode.custom, path: [field, index], message });
  const seenWorkspace = new Set();
  store.selections.forEach((selection, index) => {
    if (seenWorkspace.has(selection.workspaceId)) issue("selections", index, "duplicate selection workspace");
    seenWorkspace.add(selection.workspaceId);
  });
  const seenIngestion = new Set();
  store.records.forEach((record, index) => {
    if (seenIngestion.has(record.ingestionId)) issue("records", index, "duplicate ingestion identity");
    seenIngestion.add(record.ingestionId);
  });
  const seenToken = new Set();
  store.tokens.forEach((token, index) => {
    if (seenToken.has(token.tokenDigest)) issue("tokens", index, "duplicate token digest");
    seenToken.add(token.tokenDigest);
  });
}

const ingestionStoreObjectSchema = z.object({
  version: z.literal(1),
  revision: count,
  updatedAt: nullableTimestamp,
  selections: z.array(targetSelectionSchema).max(50_000),
  records: z.array(ingestionRecordSchema).max(50_000),
  tokens: z.array(ingestionTokenSchema).max(50_000),
}).strict();

export const ingestionStoreSchema = ingestionStoreObjectSchema.superRefine(refineIngestionStore);

// The export/import shape carries records + selections and deliberately has no
// tokens key: strict parsing rejects any token material from a bundle.
export const ingestionExportSchema = ingestionStoreObjectSchema.omit({ tokens: true }).superRefine((store, context) => {
  refineIngestionStore({ ...store, tokens: [] }, context);
});

export function emptyIngestionStore() {
  return ingestionStoreSchema.parse({ version: 1, revision: 0, updatedAt: null, selections: [], records: [], tokens: [] });
}