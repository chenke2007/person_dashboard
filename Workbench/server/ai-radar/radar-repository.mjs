import { constants, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createTicketLock } from "../workspace-state/ticket-lock.mjs";
import {
  MAX_RADAR_BYTES, RADAR_RETENTION_DAYS, emptyRadarStore, radarStoreSchema, radarRepositorySchema,
  radarSnapshotInputSchema, radarSnapshotSchema, radarRunSchema, radarDecisionStatusSchema,
  radarPreferenceInputSchema, radarScheduleSchema, radarLocalDate, radarTimeZoneSchema,
} from "./radar-schema.mjs";

const FILE_NAME = "radar.json";
const MAX_BYTES = MAX_RADAR_BYTES;
export class RadarRepositoryError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = "RadarRepositoryError"; this.code = code; this.status = status; }
}
function fail(code, message, status = 400) { throw new RadarRepositoryError(code, message, status); }
function checked(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) fail("RADAR_INVALID_INPUT", "雷达输入格式无效。");
  return result.data;
}

export function createRadarRepository({ directory, now = () => new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("RADAR_STORAGE_PATH_INVALID", "雷达存储目录无效。", 500);
  checked(radarTimeZoneSchema, timeZone);
  const root = path.resolve(directory);
  const target = path.join(root, FILE_NAME);
  let queue = Promise.resolve();
  let canonicalRoot = null;

  async function ensureDirectory({ create = true } = {}) {
    for (let candidate = root; ; candidate = path.dirname(candidate)) {
      try {
        const details = await lstat(candidate);
        if (details.isSymbolicLink() || !details.isDirectory()) fail("RADAR_STORAGE_PATH_UNSAFE", "雷达存储目录不安全。", 500);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (path.dirname(candidate) === candidate) break;
    }
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    let details;
    try { details = await lstat(root); } catch (error) {
      if (!create && error?.code === "ENOENT") return null;
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      fail("RADAR_STORAGE_PATH_UNSAFE", "雷达存储目录不安全。", 500);
    }
    const actual = path.resolve(await realpath(root));
    const comparable = process.platform === "win32" ? actual.toLowerCase() : actual;
    if (canonicalRoot && canonicalRoot !== comparable) {
      fail("RADAR_STORAGE_PATH_UNSAFE", "雷达存储目录不安全。", 500);
    }
    canonicalRoot = comparable;
    return comparable;
  }

  const withWriteLock = createTicketLock({ directory: path.join(root, "radar.lock"), ensureDirectory, fail, codePrefix: "RADAR_STORAGE" });

  async function readRawStore() {
    if (!await ensureDirectory({ create: false })) return null;
    let details;
    try {
      details = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_BYTES) {
      fail("RADAR_STORAGE_CORRUPT", "雷达数据文件无效或超过容量限制。", 500);
    }
    // Use a bounded handle read, recheck file identity and reject links before reading.
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      const current = await lstat(target);
      if (!opened.isFile() || current.isSymbolicLink() || !current.isFile() || opened.ino !== details.ino || current.ino !== opened.ino || opened.size > MAX_BYTES) {
        fail("RADAR_STORAGE_CORRUPT", "雷达数据文件无效或超过容量限制。", 500);
      }
      const bytes = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > opened.size) fail("RADAR_STORAGE_CORRUPT", "雷达数据文件在读取期间发生变化。", 500);
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }

  async function readStore() {
    const raw = await readRawStore();
    if (raw === null) return emptyRadarStore(timeZone);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      fail("RADAR_STORAGE_CORRUPT", "雷达数据文件无法解析。", 500);
    }
    if (parsed?.version !== 1) {
      fail("RADAR_STORAGE_VERSION_UNSUPPORTED", "雷达数据版本不受支持。", 500);
    }
    const result = radarStoreSchema.safeParse(parsed);
    if (!result.success) fail("RADAR_STORAGE_CORRUPT", "雷达数据文件格式无效。", 500);
    return result.data;
  }

  async function writeStore(store) {
    const checked = radarStoreSchema.safeParse(store);
    if (!checked.success) fail("RADAR_STORAGE_CORRUPT", "雷达数据未通过完整性检查。", 500);
    const body = `${JSON.stringify(checked.data, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("RADAR_STORAGE_TOO_LARGE", "雷达数据超过容量限制。", 413);
    const temporary = await writeTemporary(body, "tmp");
    try {
      await ensureDirectory();
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return checked.data;
  }

  async function writeTemporary(body, suffix) {
    const temporary = path.join(root, `.${FILE_NAME}.${randomUUID()}.${suffix}`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      return temporary;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function serialized(operation, { write = false } = {}) {
    const execute = () => write ? withWriteLock(operation) : operation();
    const result = queue.then(execute, execute);
    queue = result.catch(() => {});
    return result;
  }

  async function validatedImport(value) {
    try {
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail("RADAR_STORAGE_TOO_LARGE", "雷达数据超过容量限制。", 413);
      const checked = await radarStoreSchema.parseAsync(value);
      if (Buffer.byteLength(`${JSON.stringify(checked, null, 2)}\n`) > MAX_BYTES) fail("RADAR_STORAGE_TOO_LARGE", "雷达数据超过容量限制。", 413);
      return structuredClone(checked);
    } catch (error) {
      if (error instanceof RadarRepositoryError) throw error;
      fail("RADAR_STORAGE_CORRUPT", "雷达导入数据未通过完整性检查。", 400);
    }
  }

  async function acquireExclusiveTransaction() {
    let acquired, rejected, release;
    const ready = new Promise((resolve, reject) => { acquired = resolve; rejected = reject; });
    const barrier = new Promise((resolve) => { release = resolve; });
    const complete = serialized(async () => { acquired(); await barrier; }, { write: true });
    complete.catch(rejected);
    await ready;
    return async () => { release(); await complete; };
  }

  async function stageImport(value) {
    const checked = await validatedImport(value);
    const body = `${JSON.stringify(checked, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail("RADAR_STORAGE_TOO_LARGE", "雷达数据超过容量限制。", 413);
    const release = await acquireExclusiveTransaction();
    let stagedPath = null;
    let rollbackPath = null;
    let hadOriginal = false;
    let committed = false;
    let preserveRollback = false;
    let closed = false;
    try {
      const previous = await readRawStore();
      hadOriginal = previous !== null;
      if (hadOriginal) {
        // Malformed current bytes are recoverable, but recognized unsupported versions are not downgraded.
        let parsed;
        try { parsed = JSON.parse(previous.toString("utf8")); } catch { /* Preserve corrupt bytes verbatim. */ }
        if (parsed && Object.hasOwn(parsed, "version") && parsed.version !== 1) {
          fail("RADAR_STORAGE_VERSION_UNSUPPORTED", "雷达数据版本不受支持。", 500);
        }
        rollbackPath = await writeTemporary(previous, "rollback");
      }
      stagedPath = await writeTemporary(body, "stage");
    } catch (error) {
      if (stagedPath) await unlink(stagedPath).catch(() => {});
      if (rollbackPath) await unlink(rollbackPath).catch(() => {});
      await release();
      throw error;
    }

    async function commit() {
      if (closed || committed) return;
      await ensureDirectory();
      await rename(stagedPath, target);
      stagedPath = null;
      committed = true;
    }

    async function rollback() {
      if (closed || !committed) return;
      try {
        await ensureDirectory();
        if (hadOriginal) {
          await rename(rollbackPath, target);
          rollbackPath = null;
        } else {
          await unlink(target).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
        }
        committed = false;
      } catch (error) {
        preserveRollback = true;
        throw error;
      }
    }

    async function cleanup() {
      if (closed) return;
      closed = true;
      if (stagedPath) await unlink(stagedPath).catch(() => {});
      if (rollbackPath && !preserveRollback) await unlink(rollbackPath).catch(() => {});
      await release();
    }

    // The caller must always invoke cleanup. Until then this transaction owns
    // the process-safe store lock, so all providers can stage before any provider
    // commits and a later failure can roll committed stores back safely.
    return Object.freeze({ commit, rollback, cleanup });
  }

  const timestampSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
  const clock = () => now().toISOString();
  function requireRepository(store, id) {
    const item = store.repositories.find((repository) => repository.id === id);
    if (!item) fail("RADAR_REPOSITORY_NOT_FOUND", "雷达仓库不存在。", 404);
    return item;
  }
  function mutate(operation) {
    return serialized(async () => {
      const store = await readStore();
      const result = operation(store);
      store.revision += 1;
      store.updatedAt = clock();
      await writeStore(store);
      return structuredClone(result);
    }, { write: true });
  }
  function getState() { return serialized(async () => structuredClone(await readStore())); }

  return Object.freeze({
    id: "ai-radar", schemaVersion: 1, optionalForImport: true,
    getState, exportState: getState, validateImport: validatedImport, stageImport,
    async replaceState(value) {
      const transaction = await stageImport(value);
      try { await transaction.commit(); } finally { await transaction.cleanup(); }
    },
    upsertRepositories(input) {
      return mutate((store) => {
        const items = checked(z.array(radarRepositorySchema).max(10_000), input);
        const byId = new Map(store.repositories.map((item) => [item.id, item]));
        for (const item of items) {
          const existing = byId.get(item.id);
          if (existing && existing.observedAt >= item.observedAt) continue;
          // A remote observation can never erase local history protection.
          byId.set(item.id, { ...item, preservedAt: existing?.preservedAt ?? item.preservedAt });
        }
        store.repositories = [...byId.values()];
        return items.map((item) => byId.get(item.id));
      });
    },
    recordSnapshots(input, capturedAt, snapshotTimeZone = timeZone) {
      return mutate((store) => {
        const observedAt = checked(timestampSchema, capturedAt);
        checked(radarTimeZoneSchema, snapshotTimeZone);
        const items = checked(z.array(radarSnapshotInputSchema).max(10_000), input);
        const byDay = new Map(store.snapshots.map((item) => [`${item.repositoryId}:${item.capturedDate}`, item]));
        const result = [];
        for (const item of items) {
          requireRepository(store, item.repositoryId);
          const value = checked(radarSnapshotSchema, { ...item, capturedAt: observedAt, capturedDate: radarLocalDate(observedAt, snapshotTimeZone), timeZone: snapshotTimeZone });
          const key = `${item.repositoryId}:${value.capturedDate}`;
          if (!byDay.has(key) || byDay.get(key).capturedAt < value.capturedAt) byDay.set(key, value);
          result.push(byDay.get(key));
        }
        store.snapshots = [...byDay.values()];
        return result;
      });
    },
    recordRun(input) {
      return mutate((store) => {
        const item = checked(radarRunSchema, input);
        const index = store.runs.findIndex((run) => run.id === item.id);
        if (index === -1) store.runs.push(item);
        else {
          const existing = store.runs[index];
          if (existing.startedAt !== item.startedAt || existing.trigger !== item.trigger || existing.timeZone !== item.timeZone || existing.localDate !== item.localDate) fail("RADAR_INVALID_INPUT", "运行身份不可更改。");
          if (existing.status !== "running" && JSON.stringify(existing) !== JSON.stringify(item)) fail("RADAR_INVALID_INPUT", "已结束的运行不可更改。");
          store.runs[index] = item;
        }
        return item;
      });
    },
    setDecision(repositoryId, status) {
      return mutate((store) => {
        const repository = requireRepository(store, repositoryId);
        checked(radarDecisionStatusSchema, status);
        const item = { repositoryId, status, updatedAt: clock() };
        if (["saved", "queued", "learning", "completed"].includes(status)) repository.preservedAt ??= item.updatedAt;
        store.decisions = [...store.decisions.filter((decision) => decision.repositoryId !== repositoryId), item];
        return item;
      });
    },
    addPreference(input) {
      return mutate((store) => {
        const value = checked(radarPreferenceInputSchema, input);
        if (value.repositoryId !== null) requireRepository(store, value.repositoryId);
        const item = { ...value, id: randomUUID(), createdAt: clock(), revertedAt: null };
        store.preferences.push(item);
        return item;
      });
    },
    revertPreference(id) {
      return mutate((store) => {
        const item = store.preferences.find((preference) => preference.id === id);
        if (!item) fail("RADAR_PREFERENCE_NOT_FOUND", "偏好记录不存在。", 404);
        item.revertedAt ??= clock(); return item;
      });
    },
    resetPreferences() {
      return mutate((store) => {
        const timestamp = clock();
        for (const item of store.preferences) item.revertedAt ??= timestamp;
        return store.preferences;
      });
    },
    async getSchedule() { return (await getState()).schedule; },
    updateSchedule(patch) {
      return mutate((store) => {
        checked(radarScheduleSchema.partial(), patch);
        store.schedule = checked(radarScheduleSchema, { ...store.schedule, ...patch });
        return store.schedule;
      });
    },
    applyRetention(referenceDate = radarLocalDate(clock(), timeZone)) {
      return mutate((store) => {
        checked(z.string().date(), referenceDate);
        const cutoff = new Date(Date.parse(`${referenceDate}T00:00:00.000Z`) - RADAR_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
        const protectedIds = new Set(store.repositories.filter((item) => item.preservedAt).map((item) => item.id));
        const aggregates = new Map(store.monthlyAggregates.map((item) => [`${item.repositoryId}:${item.month}`, item]));
        const retained = [];
        for (const item of store.snapshots) {
          if (item.capturedDate >= cutoff || protectedIds.has(item.repositoryId)) { retained.push(item); continue; }
          const month = item.capturedDate.slice(0, 7), key = `${item.repositoryId}:${month}`;
          const aggregate = aggregates.get(key);
          if (!aggregate) aggregates.set(key, { repositoryId: item.repositoryId, month, observedDates: [item.capturedDate], first: item, last: item });
          else {
            aggregate.observedDates = [...new Set([...aggregate.observedDates, item.capturedDate])].sort();
            if (item.capturedDate < aggregate.first.capturedDate || (item.capturedDate === aggregate.first.capturedDate && item.capturedAt > aggregate.first.capturedAt)) aggregate.first = item;
            if (item.capturedDate > aggregate.last.capturedDate || (item.capturedDate === aggregate.last.capturedDate && item.capturedAt > aggregate.last.capturedAt)) aggregate.last = item;
          }
        }
        const aggregatedSnapshots = store.snapshots.length - retained.length;
        store.snapshots = retained;
        store.monthlyAggregates = [...aggregates.values()];
        store.retention.lastAppliedDate = referenceDate;
        return { aggregatedSnapshots, retainedSnapshots: retained.length };
      });
    },
  });
}
