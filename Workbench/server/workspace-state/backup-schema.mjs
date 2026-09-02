import { z } from "zod";

export const MAX_WORKSPACE_BACKUP_BYTES = 32 * 1024 * 1024;
export const WORKSPACE_RESTORE_PREVIEW_TTL_MS = 15 * 60 * 1000;

const timestampSchema = z.string().datetime({ offset: true });
const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const providerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const providerVersionSchema = z.number().int().positive();

export const backupProviderSchema = z.object({
  version: providerVersionSchema,
  data: z.unknown(),
}).strict();

const workspaceBackupUnsignedBaseSchema = z.object({
  format: z.literal("personal-ai-workbench-backup"),
  version: z.literal(1),
  workspaceId: workspaceIdSchema,
  createdAt: timestampSchema,
  providers: z.record(providerIdSchema, backupProviderSchema),
}).strict();

function requireProviderCount(bundle, context) {
  const count = Object.keys(bundle.providers).length;
  if (count < 1 || count > 64) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providers"],
      message: "backup must contain between 1 and 64 providers",
    });
  }
}

export const workspaceBackupUnsignedSchema = workspaceBackupUnsignedBaseSchema.superRefine(requireProviderCount);

export const workspaceBackupSchema = workspaceBackupUnsignedBaseSchema.extend({
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine(requireProviderCount);
