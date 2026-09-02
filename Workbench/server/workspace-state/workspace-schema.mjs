import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const workspaceRecordSchema = z.object({
  workspaceId: workspaceIdSchema,
  label: z.string().min(1).max(120),
  fingerprint: fingerprintSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const pendingRebindSchema = z.object({
  workspaceId: workspaceIdSchema,
  fingerprint: fingerprintSchema,
  requestedAt: timestampSchema,
  expiresAt: timestampSchema,
  confirmationHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const workspaceRegistrySchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
  workspaces: z.array(workspaceRecordSchema),
  pendingRebinds: z.array(pendingRebindSchema),
}).strict().superRefine((store, context) => {
  const ids = new Set();
  const fingerprints = new Set();
  for (const [index, workspace] of store.workspaces.entries()) {
    if (ids.has(workspace.workspaceId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaces", index, "workspaceId"], message: "duplicate workspace id" });
    }
    if (fingerprints.has(workspace.fingerprint)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaces", index, "fingerprint"], message: "duplicate fingerprint" });
    }
    ids.add(workspace.workspaceId);
    fingerprints.add(workspace.fingerprint);
  }
  for (const [index, pending] of store.pendingRebinds.entries()) {
    if (!ids.has(pending.workspaceId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["pendingRebinds", index, "workspaceId"], message: "unknown workspace id" });
    }
  }
});

export function emptyWorkspaceRegistry(timestamp) {
  return {
    version: 1,
    revision: 0,
    updatedAt: timestamp,
    workspaces: [],
    pendingRebinds: [],
  };
}
