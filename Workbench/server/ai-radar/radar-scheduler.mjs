import { radarLocalDate, radarTimeZoneSchema } from "./radar-schema.mjs";

const MAX_TIMER_DELAY_MS = 6 * 60 * 60 * 1000;
const FAILURE_RETRY_DELAY_MS = 15 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULER_ERROR = Object.freeze({
  code: "RADAR_SCHEDULER_RUN_FAILED",
  message: "AI Radar collection failed.",
});

const formatters = new Map();

function formatter(timeZone) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    if (formatters.size < 128) formatters.set(timeZone, value);
  }
  return value;
}

function clockDate(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("radar scheduler clock is invalid");
  return date;
}

function localParts(instant, timeZone) {
  const values = Object.fromEntries(
    formatter(timeZone).formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function localMinute(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) / MINUTE_MS;
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function addLocalDays(value, days) {
  const { year, month, day } = parseDate(value);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// Search minute instants around the nominal UTC wall time. This chooses the
// first occurrence during a fold and, if the requested minute is skipped,
// the first valid wall-clock minute after a DST gap.
function localScheduleInstant(localDate, time, timeZone) {
  const date = parseDate(localDate);
  const [hour, minute] = time.split(":").map(Number);
  const desired = { ...date, hour, minute };
  const desiredMinute = localMinute(desired);
  const nominal = desiredMinute * MINUTE_MS;
  const start = nominal - 18 * 60 * MINUTE_MS;
  const end = nominal + 18 * 60 * MINUTE_MS;
  let gapCandidate = null;
  let gapLocalMinute = Number.POSITIVE_INFINITY;

  for (let instant = start; instant <= end; instant += MINUTE_MS) {
    const parts = localParts(new Date(instant), timeZone);
    if (parts.year !== date.year || parts.month !== date.month || parts.day !== date.day) continue;
    const candidateMinute = localMinute(parts);
    if (candidateMinute === desiredMinute) return new Date(instant);
    if (candidateMinute > desiredMinute && candidateMinute < gapLocalMinute) {
      gapCandidate = instant;
      gapLocalMinute = candidateMinute;
    }
  }
  if (gapCandidate != null) return new Date(gapCandidate);
  throw new TypeError("radar scheduler could not resolve local time");
}

function validFutureTimestamp(value, after) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > after.getTime()
    ? new Date(milliseconds)
    : null;
}

function succeededForDay(run, localDate, timeZone) {
  return run?.status === "success" && run.localDate === localDate && run.timeZone === timeZone;
}

function durableSuccess(result, localDate, timeZone) {
  return result?.persisted === true && succeededForDay(result.run, localDate, timeZone);
}

function validateDependencies({ collect, store, now, setTimeoutImpl, clearTimeoutImpl }) {
  if (
    typeof collect !== "function" ||
    !store ||
    typeof store.getSchedule !== "function" ||
    typeof store.getState !== "function" ||
    typeof store.updateSchedule !== "function" ||
    typeof now !== "function" ||
    typeof setTimeoutImpl !== "function" ||
    typeof clearTimeoutImpl !== "function"
  ) {
    throw new TypeError("radar scheduler dependencies are invalid");
  }
}

export function createRadarScheduler({
  collect,
  store,
  now = () => new Date(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  validateDependencies({ collect, store, now, setTimeoutImpl, clearTimeoutImpl });

  let active = false;
  let generation = 0;
  let timer = null;
  let running = false;
  let activeRun = null;
  let startPromise = null;
  let stopPromise = null;
  let retryAt = null;
  let lastError = null;

  function clearTimer() {
    if (timer != null) clearTimeoutImpl(timer);
    timer = null;
  }

  async function persistNextRun(nextRunAt) {
    const current = await store.getSchedule();
    if (current.nextRunAt !== nextRunAt) await store.updateSchedule({ nextRunAt });
  }

  function arm(target, expectedGeneration) {
    clearTimer();
    if (!active || generation !== expectedGeneration || !target) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, target.getTime() - clockDate(now).getTime()));
    timer = setTimeoutImpl(async () => {
      timer = null;
      try {
        await runDueInternal("schedule");
      } catch {
        lastError = SCHEDULER_ERROR;
      }
    }, delay);
  }

  async function planningState() {
    const state = await store.getState();
    const schedule = state.schedule;
    radarTimeZoneSchema.parse(schedule.timeZone);
    return { state, schedule };
  }

  async function plan({ successResult = null, failureResult = null, expectedGeneration = generation } = {}) {
    if (!active || generation !== expectedGeneration) return null;
    const { state, schedule } = await planningState();
    if (!active || generation !== expectedGeneration) return null;
    if (!schedule.enabled) {
      retryAt = null;
      clearTimer();
      await persistNextRun(null);
      return null;
    }

    const current = clockDate(now);
    const localDate = radarLocalDate(current, schedule.timeZone);
    const todayTarget = localScheduleInstant(localDate, schedule.time, schedule.timeZone);
    const hasSuccess = durableSuccess(successResult, localDate, schedule.timeZone) ||
      state.runs.some((run) => succeededForDay(run, localDate, schedule.timeZone));

    let target;
    if (hasSuccess) {
      retryAt = null;
      target = localScheduleInstant(addLocalDays(localDate, 1), schedule.time, schedule.timeZone);
    } else if (current.getTime() < todayTarget.getTime()) {
      retryAt = null;
      target = todayTarget;
    } else {
      const durableRetry = validFutureTimestamp(state.collection?.retryAt, current);
      const returnedRetry = validFutureTimestamp(failureResult?.retryAt, current);
      if (returnedRetry) retryAt = returnedRetry;
      else if (failureResult && !retryAt) retryAt = new Date(current.getTime() + FAILURE_RETRY_DELAY_MS);
      target = durableRetry || retryAt || todayTarget;
    }

    if (target.getTime() <= current.getTime()) target = new Date(current.getTime() + FAILURE_RETRY_DELAY_MS);
    const nextRunAt = target.toISOString();
    await persistNextRun(nextRunAt);
    if (active && generation === expectedGeneration) arm(target, expectedGeneration);
    return target;
  }

  function runCollector(trigger) {
    if (activeRun) return activeRun;
    const expectedGeneration = generation;
    running = true;
    const attempt = (async () => {
      let result;
      try {
        result = await collect({ trigger });
        const current = clockDate(now);
        const currentSchedule = await store.getSchedule();
        const currentLocalDate = radarLocalDate(current, currentSchedule.timeZone);
        if (durableSuccess(result, currentLocalDate, currentSchedule.timeZone)) {
          lastError = null;
          await plan({ successResult: result, expectedGeneration });
        } else {
          lastError = result?.run?.errors?.[0]
            ? { code: String(result.run.errors[0].code).slice(0, 100), message: String(result.run.errors[0].message).slice(0, 500) }
            : SCHEDULER_ERROR;
          await plan({ failureResult: result ?? {}, expectedGeneration });
        }
        return result;
      } catch (error) {
        lastError = SCHEDULER_ERROR;
        if (error?.code === "WORKSPACE_BINDING_CHANGED") throw error;
        await plan({ failureResult: {}, expectedGeneration }).catch(() => {});
        return { persisted: false, retryAt: null, run: null, error: SCHEDULER_ERROR };
      } finally {
        running = false;
      }
    })();
    activeRun = attempt.finally(() => {
      if (activeRun === wrapped) activeRun = null;
    });
    const wrapped = activeRun;
    return activeRun;
  }

  async function runDueInternal(startupTrigger) {
    if (activeRun) return activeRun;
    const { state, schedule } = await planningState();
    if (!active || !schedule.enabled) {
      if (active) await plan();
      return null;
    }
    const current = clockDate(now);
    const localDate = radarLocalDate(current, schedule.timeZone);
    const target = localScheduleInstant(localDate, schedule.time, schedule.timeZone);
    const hasSuccess = state.runs.some((run) => succeededForDay(run, localDate, schedule.timeZone));
    const deferred = validFutureTimestamp(state.collection?.retryAt, current) ||
      (retryAt && retryAt.getTime() > current.getTime() ? retryAt : null);
    if (hasSuccess || current.getTime() < target.getTime() || deferred) {
      await plan();
      return null;
    }
    return runCollector(startupTrigger);
  }

  async function startInternal() {
    if (active) return;
    active = true;
    generation += 1;
    try {
      await runDueInternal("startup");
    } catch (error) {
      active = false;
      generation += 1;
      clearTimer();
      throw error;
    }
  }

  function start() {
    if (active) return startPromise ?? Promise.resolve();
    if (startPromise) return startPromise;
    startPromise = startInternal().finally(() => { startPromise = null; });
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    active = false;
    generation += 1;
    clearTimer();
    const settling = activeRun;
    stopPromise = (async () => {
      if (settling) await settling.catch(() => {});
      await persistNextRun(null).catch(() => {});
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  }

  async function refreshSchedule() {
    clearTimer();
    retryAt = null;
    if (!active) return null;
    return runDueInternal("schedule");
  }

  async function getStatus() {
    const schedule = await store.getSchedule();
    return {
      running,
      lastAttemptAt: schedule.lastAttemptAt,
      lastSuccessAt: schedule.lastSuccessAt,
      nextRunAt: active && schedule.enabled ? schedule.nextRunAt : null,
      error: lastError ? { ...lastError } : null,
    };
  }

  return Object.freeze({
    start,
    stop,
    refreshSchedule,
    runDue: () => runDueInternal("schedule"),
    runNow: () => runCollector("manual"),
    getStatus,
  });
}
