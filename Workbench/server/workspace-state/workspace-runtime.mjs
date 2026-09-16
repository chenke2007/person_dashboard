export class WorkspaceRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceRuntimeError";
    this.code = code;
  }
}

function invalidMode(mode) {
  return new WorkspaceRuntimeError(
    "WORKSPACE_RUNTIME_INVALID_MODE",
    `工作区运行时模式无效：${String(mode)}。`,
  );
}

function requireMode(mode) {
  if (mode !== "read" && mode !== "write") throw invalidMode(mode);
}

function requireFactory(name, factory) {
  if (typeof factory !== "function") throw new TypeError(`${name} factory is required`);
  return factory;
}

export function createWorkspaceRuntime({ registry, repositories, backup } = {}) {
  if (!registry || typeof registry.resolve !== "function" || typeof registry.capture !== "function" || typeof registry.runBound !== "function") {
    throw new TypeError("workspace runtime requires a registry with resolve, capture, and runBound");
  }
  if (!repositories || typeof repositories !== "object") throw new TypeError("workspace runtime requires repository factories");

  const factories = Object.freeze({
    learning: requireFactory("learning repository", repositories.learning),
    summary: requireFactory("summary repository", repositories.summary),
    ingestion: requireFactory("ingestion repository", repositories.ingestion),
    radar: requireFactory("radar repository", repositories.radar),
    backup: requireFactory("backup", backup),
  });
  const cache = new Map();

  async function resolve({ mode } = {}) {
    requireMode(mode);
    return registry.resolve({ mode });
  }

  async function capture() {
    return registry.capture();
  }

  async function runBound({ binding, operation } = {}) {
    if (typeof operation !== "function") throw new TypeError("workspace runtime requires a bound operation");
    return registry.runBound({ binding, operation });
  }

  async function repository(name, { mode } = {}) {
    requireMode(mode);
    if (cache.has(name)) return cache.get(name);

    const workspace = await resolve({ mode });
    if (!workspace) return null;

    const instance = await factories[name]({ workspace, mode });
    if (instance !== null && instance !== undefined) cache.set(name, instance);
    return instance ?? null;
  }

  return Object.freeze({
    resolve,
    capture,
    runBound,
    learning: (options) => repository("learning", options),
    summary: (options) => repository("summary", options),
    ingestion: (options) => repository("ingestion", options),
    radar: (options) => repository("radar", options),
    backup: (options) => repository("backup", options),
  });
}
