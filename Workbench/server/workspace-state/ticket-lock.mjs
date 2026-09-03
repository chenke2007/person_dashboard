import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TICKET_MAX_BYTES = 4 * 1024;
const LOCK_RETRY_MS = 20;
const activeLockTokens = new Set();
const comparable = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validLockPayload(value) {
  return Boolean(
    value &&
    value.version === 1 &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.token === "string" &&
    /^[a-f0-9]{64}$/.test(value.token) &&
    typeof value.order === "string" &&
    /^[0-9]{1,32}$/.test(value.order) &&
    ["waiting", "held", "released"].includes(value.status),
  );
}

function processIsProvenDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

// Shared unique-ticket protocol: never reclaim a live owner or an ambiguous ticket.
// Callers retain ownership for the full operation, including staged restore cleanup.
export function createTicketLock({ directory, ensureDirectory, fail, codePrefix = "WORKSPACE_REGISTRY", lockTimeoutMs = 5_000, removeLock = unlink, lockLifecycle = {} }) {
  const lockDirectory = directory;
  const lockFail = (code, message, status) => fail(code.replace("WORKSPACE_REGISTRY", codePrefix), message, status);
  async function withLock(operation) {
    const actualRoot = await ensureDirectory();
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const lockDetails = await lstat(lockDirectory);
    if (!lockDetails.isDirectory() || lockDetails.isSymbolicLink()) {
      lockFail("WORKSPACE_REGISTRY_PATH_UNSAFE", "工作区注册表锁目录不安全。");
    }
    const actualLockDirectory = comparable(await realpath(lockDirectory));
    if (!isPathInside(actualRoot, actualLockDirectory)) {
      lockFail("WORKSPACE_REGISTRY_PATH_UNSAFE", "工作区注册表锁目录越出了应用数据目录。");
    }

    const deadline = Date.now() + lockTimeoutMs;
    const token = randomBytes(32).toString("hex");
    const order = process.hrtime.bigint().toString();
    const ticketPath = path.join(lockDirectory, `${token}.ticket`);
    let handle;
    let status = null;
    let activated = false;
    let enteredLifecycle = false;

    async function writeTicket(nextStatus) {
      const body = Buffer.from(`${JSON.stringify({ version: 1, pid: process.pid, token, order, status: nextStatus })}\n`, "utf8");
      await handle.truncate(0);
      await handle.write(body, 0, body.length, 0);
      await handle.sync();
      status = nextStatus;
    }

    async function inspectTickets() {
      const currentLockDetails = await lstat(lockDirectory);
      if (!currentLockDetails.isDirectory() || currentLockDetails.isSymbolicLink()) {
        lockFail("WORKSPACE_REGISTRY_PATH_UNSAFE", "工作区注册表锁目录不安全。");
      }
      if (comparable(await realpath(lockDirectory)) !== actualLockDirectory) {
        lockFail("WORKSPACE_REGISTRY_PATH_UNSAFE", "工作区注册表锁目录在使用期间发生了变化。");
      }
      const tickets = [];
      for (const entry of await readdir(lockDirectory, { withFileTypes: true })) {
        const match = /^([a-f0-9]{64})\.ticket$/.exec(entry.name);
        if (!match || !entry.isFile() || entry.isSymbolicLink()) {
          lockFail("WORKSPACE_REGISTRY_PATH_UNSAFE", "工作区注册表锁目录包含不安全的条目。");
        }
        const candidate = path.join(lockDirectory, entry.name);
        let details;
        try {
          details = await lstat(candidate);
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        if (!details.isFile() || details.isSymbolicLink() || details.size > TICKET_MAX_BYTES) {
          lockFail("WORKSPACE_REGISTRY_PATH_UNSAFE", "工作区注册表票据不安全。");
        }
        let payload = null;
        try {
          const parsed = JSON.parse(await readFile(candidate, "utf8"));
          if (validLockPayload(parsed) && parsed.token === match[1]) payload = parsed;
        } catch (error) {
          if (error?.code === "ENOENT") continue;
        }
        tickets.push({ path: candidate, payload });
      }
      return tickets;
    }

    function reclaimable(payload) {
      if (!payload) return false;
      if (payload.status === "released") return true;
      if (payload.pid === process.pid) return !activeLockTokens.has(payload.token);
      return processIsProvenDead(payload.pid);
    }

    async function removeTicket(candidate) {
      try {
        await removeLock(candidate);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        return false;
      }
    }

    function ordered(tickets) {
      return [...tickets].sort((left, right) => {
        const orderDifference = BigInt(left.payload.order) - BigInt(right.payload.order);
        if (orderDifference !== 0n) return orderDifference < 0n ? -1 : 1;
        return left.payload.token.localeCompare(right.payload.token);
      });
    }

    async function waitOrFail() {
      if (Date.now() >= deadline) {
        lockFail("WORKSPACE_REGISTRY_BUSY", "工作区注册表正被另一个进程使用。", 503);
      }
      await delay(LOCK_RETRY_MS);
    }

    try {
      handle = await open(ticketPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      activeLockTokens.add(token);
      activated = true;
      await writeTicket("waiting");
      await lockLifecycle.ticketPublished?.();
      await delay(LOCK_RETRY_MS);

      for (;;) {
        const inspected = await inspectTickets();
        await lockLifecycle.ticketsInspected?.();
        let removed = false;
        for (const ticket of inspected) {
          if (ticket.payload?.token !== token && reclaimable(ticket.payload)) {
            removed = await removeTicket(ticket.path) || removed;
          }
        }
        if (removed) continue;
        if (inspected.some((ticket) => !ticket.payload)) {
          await waitOrFail();
          continue;
        }

        const liveTickets = inspected.filter((ticket) => ticket.payload);
        const ownTicket = liveTickets.find((ticket) => ticket.payload.token === token);
        if (!ownTicket) lockFail("WORKSPACE_REGISTRY_LOCK_LOST", "工作区注册表锁票据丢失。");
        const heldByOther = liveTickets.some(
          (ticket) => ticket.payload.token !== token && ticket.payload.status === "held",
        );
        if (heldByOther) {
          if (status === "held") await writeTicket("waiting");
          await waitOrFail();
          continue;
        }

        const waiters = ordered(liveTickets.filter((ticket) => ticket.payload.status === "waiting"));
        if (waiters[0]?.payload.token !== token) {
          await waitOrFail();
          continue;
        }

        await writeTicket("held");
        await delay(LOCK_RETRY_MS);
        const verification = await inspectTickets();
        if (verification.some((ticket) => !ticket.payload)) {
          await writeTicket("waiting");
          await waitOrFail();
          continue;
        }
        const heldTickets = ordered(verification.filter((ticket) => ticket.payload.status === "held"));
        if (heldTickets[0]?.payload.token === token && heldTickets.length === 1) break;
        await writeTicket("waiting");
        await waitOrFail();
      }

      await lockLifecycle.acquired?.();
      enteredLifecycle = true;
      return await operation();
    } finally {
      if (enteredLifecycle) {
        await Promise.resolve()
          .then(() => lockLifecycle.released?.())
          .catch(() => {});
      }
      if (handle && status !== "released") await writeTicket("released").catch(() => {});
      if (activated) activeLockTokens.delete(token);
      await handle?.close().catch(() => {});
      if (handle) await removeTicket(ticketPath).catch(() => {});
    }
  }

  return withLock;
}
