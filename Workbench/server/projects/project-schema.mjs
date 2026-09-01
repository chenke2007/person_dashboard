import { z } from "zod";

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const nullableTimestamp = timestamp.nullable();

export const projectSchema = z.object({
  id,
  key: z.string().regex(/^[A-Z][A-Z0-9-]{1,11}$/),
  name: z.string().min(1).max(120),
  description: z.string().max(4_000),
  position: z.number().int().nonnegative(),
  lastTaskNumber: z.number().int().nonnegative(),
  archivedAt: nullableTimestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const columnSchema = z.object({
  id,
  projectId: id,
  name: z.string().min(1).max(80),
  color: z.string().max(32).nullable(),
  position: z.number().int().nonnegative(),
  isFinal: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const taskSchema = z.object({
  id,
  projectId: id,
  columnId: id.nullable(),
  number: z.number().int().positive(),
  title: z.string().min(1).max(240),
  description: z.string().max(40_000),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]),
  startDate: z.string().date().nullable(),
  dueDate: z.string().date().nullable(),
  position: z.number().int().nonnegative(),
  archivedAt: nullableTimestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const labelSchema = z.object({
  id,
  name: z.string().min(1).max(60),
  color: z.string().min(1).max(32),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const taskLabelSchema = z.object({ taskId: id, labelId: id }).strict();
export const taskLinkSchema = z.object({
  id,
  taskId: id,
  documentId: z.string().min(1).max(512),
  relativePath: z.string().min(1).max(768),
  kind: z.string().min(1).max(40),
  createdAt: timestamp,
}).strict();
export const activitySchema = z.object({
  id,
  projectId: id,
  taskId: id.nullable(),
  type: z.string().min(1).max(80),
  data: z.record(z.unknown()),
  createdAt: timestamp,
}).strict();

export const projectStoreSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  updatedAt: nullableTimestamp,
  projects: z.array(projectSchema).max(500),
  columns: z.array(columnSchema).max(5_000),
  tasks: z.array(taskSchema).max(50_000),
  labels: z.array(labelSchema).max(2_000),
  taskLabels: z.array(taskLabelSchema).max(200_000),
  taskLinks: z.array(taskLinkSchema).max(100_000),
  activities: z.array(activitySchema).max(250_000),
}).strict();

export function emptyProjectStore() {
  return {
    version: 1,
    revision: 0,
    updatedAt: null,
    projects: [],
    columns: [],
    tasks: [],
    labels: [],
    taskLabels: [],
    taskLinks: [],
    activities: [],
  };
}
