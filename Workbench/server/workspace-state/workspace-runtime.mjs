import { AsyncLocalStorage } from "node:async_hooks";

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

function workspaceBinding(workspace, fingerprint) {
  if (!workspace || typeof workspace.workspaceId !== "string" || !workspace.workspaceId) return null;
  return { fingerprint, workspaceId: workspace.workspaceId };
}

function matchesBinding(workspace, binding) {
  return workspace?.workspaceId === binding?.workspaceId && workspace?.fingerprint === binding?.fingerprint;
}

// Adapts the concrete persistence registry without making WorkspaceRuntime
// depend on its Vault-specific fingerprint and label inputs. Callers that
// already expose resolve/capture/runBound can inject that compatible contract
// directly instead.
export function createWorkspaceRegistryAdapter({ registry, fingerprint, label } = {}) {
  if (!registry || typeof registry.lookupVault !== "function" || typeof registry.resolveVault !== "function" || typeof registry.withBoundWorkspace !== "function") {
    throw new TypeError("workspace registry adapter requires lookupVault, resolveVault, and withBoundWorkspace");
  }
  if (typeof fingerprint !== "string" || !fingerprint) throw new TypeError("workspace registry adapter requires a fingerprint");
  if (typeof label !== "string" && typeof label !== "function") throw new TypeError("workspace registry adapter requires a label");

  const resolveLabel = () => typeof label === "function" ? label() : label;
  const capturedWorkspaces = new WeakMap();

  async function workspaceFor(binding) {
    const captured = typeof binding === "object" && binding !== null ? capturedWorkspaces.get(binding) : null;
    if (matchesBinding(captured, binding)) return captured;
    if (typeof binding?.fingerprint !== "string") return null;
    const workspace = await registry.lookupVault({ fingerprint: binding.fingerprint });
    return matchesBinding(workspace, binding) ? workspace : null;
  }

  return Object.freeze({
    async resolve({ mode } = {}) {
      requireMode(mode);
      return mode === "read"
        ? registry.lookupVault({ fingerprint })
        : registry.resolveVault({ fingerprint, label: resolveLabel() });
    },
    async capture({ mode = "write" } = {}) {
      requireMode(mode);
      const workspace = mode === "read"
        ? await registry.lookupVault({ fingerprint })
        : await registry.resolveVault({ fingerprint, label: resolveLabel() });
      const binding = workspaceBinding(
        workspace,
        fingerprint,
      );
      if (binding) capturedWorkspaces.set(binding, workspace);
      return binding;
    },
    async runBound({ binding, operation } = {}) {
      const workspace = await workspaceFor(binding);
      return registry.withBoundWorkspace(binding, () => operation(Object.freeze({ binding, workspace })));
    },
  });
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
  const inFlight = new Map();
  const boundContext = new AsyncLocalStorage();

  async function resolve({ mode } = {}) {
    requireMode(mode);
    return registry.resolve({ mode });
  }

  async function capture({ mode = "write" } = {}) {
    requireMode(mode);
    return registry.capture({ mode });
  }

  async function runBound({ binding, operation } = {}) {
    if (typeof operation !== "function") throw new TypeError("workspace runtime requires a bound operation");
    return registry.runBound({
      binding,
      operation: (context) => boundContext.run(context ?? null, () => operation(context)),
    });
  }

  function cacheKey(name, workspace) {
    if (typeof workspace?.workspaceId !== "string" || !workspace.workspaceId) return null;
    return JSON.stringify([name, workspace.workspaceId, workspace.fingerprint ?? null]);
  }

  async function repository(name, { mode } = {}) {
    requireMode(mode);
    const workspace = boundContext.getStore()?.workspace ?? await resolve({ mode });
    if (!workspace) return null;

    const key = cacheKey(name, workspace);
    if (key && cache.has(key)) return cache.get(key);
    if (key && inFlight.has(key)) return inFlight.get(key);

    const construction = Promise.resolve(factories[name]({ workspace, mode }))
      .then((instance) => {
        if (key && instance !== null && instance !== undefined) cache.set(key, instance);
        return instance ?? null;
      });
    if (key) inFlight.set(key, construction);
    try {
      return await construction;
    } finally {
      if (key && inFlight.get(key) === construction) inFlight.delete(key);
    }
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
