import { LearningWorkspaceError } from "./learning-repository.mjs";

// Deep orchestration over the S1 LearningWorkspaceRepository. Owns the parts of
// the flow that cross an adapter seam (radar identity, GitHub head commit) and
// the workspace-binding guard, so the HTTP layer stays a thin router and tests
// can drive the whole no-model flow through one module.

function fail(code, message, status = 400) {
  throw new LearningWorkspaceError(code, message, status);
}

export class LearningServiceError extends LearningWorkspaceError {}

export function createLearningService({
  runtime = null,
  resolveRepository = null,
  getHeadCommit = null,
  mutatable = true,
  readable = true,
  hosted = false,
} = {}) {
  if (!runtime || typeof runtime.capture !== "function" || typeof runtime.runBound !== "function" || typeof runtime.learning !== "function") {
    throw new TypeError("learning service requires a workspace runtime");
  }
  if (resolveRepository !== null && typeof resolveRepository !== "function") throw new TypeError("resolveRepository must be a function or null");
  if (getHeadCommit !== null && typeof getHeadCommit !== "function") throw new TypeError("getHeadCommit must be a function or null");

  // Resolve the store lazily through the runtime so hosted/read-only reads
  // never bind or create a workspace before the capability gate has rejected
  // the request. Reads use the explicit read mode; mutations use write.
  const store = ({ mode = "write" } = {}) => runtime.learning({ mode });

  const mutation = async (operation, binding = null) => {
    if (hosted || !mutatable) {
      fail("LEARNING_READ_ONLY", "当前工作区不允许修改学习项目。", 403);
    }
    const expected = binding ?? await runtime.capture();
    try {
      return await runtime.runBound({ binding: expected, operation });
    } catch (error) {
      if (error?.code === "WORKSPACE_BINDING_CHANGED") {
        fail("WORKSPACE_BINDING_CHANGED", "工作区绑定已改变，请重新加载后重试。", 409);
      }
      throw error;
    }
  };

  function capabilities() {
    return Object.freeze({
      read: readable && !hosted,
      create: !hosted && mutatable,
      edit: !hosted && mutatable,
      preview: !hosted && mutatable,
      confirm: !hosted && mutatable,
      activate: !hosted && mutatable,
      archive: !hosted && mutatable,
    });
  }

  async function list({ includeArchived = false } = {}) {
    if (hosted) fail("LEARNING_UNAVAILABLE", "托管模式下学习数据不可用。", 404);
    const repository = await store({ mode: "read" });
    if (!repository) return { workspaces: [] };
    return repository.list({ includeArchived });
  }

  async function get(workspaceId) {
    if (hosted) fail("LEARNING_UNAVAILABLE", "托管模式下学习数据不可用。", 404);
    const repository = await store({ mode: "read" });
    if (!repository) fail("WORKSPACE_NOT_FOUND", "学习工作区不存在。", 404);
    return repository.get(workspaceId);
  }

  async function createDraft({ repositoryId, mission }) {
    if (hosted) fail("LEARNING_UNAVAILABLE", "托管模式下学习数据不可用。", 404);
    if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
      fail("LEARNING_INVALID_INPUT", "学习工作区输入格式无效。");
    }
    // Capture the expected binding BEFORE any slow remote work. The write at
    // the end of the request is only accepted while THIS binding still owns
    // the fingerprint; a rebind landing during getHeadCommit must reject the
    // stale request instead of re-resolving the new workspace and writing the
    // old draft into it.
    const expected = await runtime.capture();
    // Idempotent path: an existing workspace for this repository is returned
    // without touching GitHub, so transient GitHub unavailability never breaks
    // the "already joined" case. The read uses read-only resolution so it can
    // never create state on its own.
    const read = await store({ mode: "read" });
    if (read) {
      const existing = (await read.list({ includeArchived: true })).workspaces.find((workspace) => workspace.repositoryId === repositoryId);
      if (existing) return { workspace: existing };
    }

    if (!resolveRepository || !getHeadCommit) fail("LEARNING_SOURCE_UNAVAILABLE", "无法解析仓库来源。", 503);
    const repository = await resolveRepository(repositoryId);
    if (!repository) fail("LEARNING_REPOSITORY_NOT_FOUND", "雷达中不存在该仓库。", 404);
    // Slow network work happens BEFORE the registry/store locks so the lock-held
    // section never awaits GitHub.
    let head;
    try {
      head = await getHeadCommit({ fullName: repository.fullName });
    } catch (error) {
      fail("LEARNING_GITHUB_UNAVAILABLE", "无法读取仓库最新提交，请稍后重试。", 503);
    }
    const sourceCommitSha = typeof head?.sha === "string" && /^[a-f0-9]{40}$/.test(head.sha) ? head.sha : null;
    if (!sourceCommitSha) fail("LEARNING_GITHUB_UNAVAILABLE", "无法读取仓库最新提交，请稍后重试。", 503);

    const workspace = await mutation(async () => (await store({ mode: "write" })).createDraft({
      repositoryId,
      fullName: repository.fullName,
      sourceUrl: `https://github.com/${repository.fullName}`,
      sourceCommitSha,
      mission,
    }), expected);
    // The store's createDraft already returns { workspace }; do not re-wrap.
    return workspace;
  }

  async function editDraft({ workspaceId, expectedRevision, mission }) {
    const result = await mutation(async () => (await store({ mode: "write" })).editDraft({ workspaceId, expectedRevision, mission }));
    // The store's editDraft already returns { workspace }; do not re-wrap.
    return result;
  }

  async function preview({ workspaceId }) {
    // The token page and its source complement come from ONE store inside ONE
    // binding guard: leaving the guard between preview and get would let a
    // rebinding splice a second store's data into the same response.
    const { page, workspace } = await mutation(async () => {
      const repository = await store({ mode: "write" });
      const page = await repository.preview({ workspaceId });
      const { workspace } = await repository.get(workspaceId);
      return { page, workspace };
    });
    return {
      ...page,
      repositoryId: workspace.repositoryId,
      fullName: workspace.fullName,
      sourceUrl: workspace.sourceUrl,
    };
  }

  async function confirm({ token }) {
    if (typeof token !== "string" || !token) fail("LEARNING_INVALID_INPUT", "确认凭证无效。");
    const result = await mutation(async () => (await store({ mode: "write" })).confirm({ token }));
    return { confirmed: result.confirmed, workspace: result.workspace };
  }

  async function activate({ workspaceId, expectedRevision }) {
    const result = await mutation(async () => (await store({ mode: "write" })).activate({ workspaceId, expectedRevision }));
    return { workspace: result.workspace, outcome: result.outcome };
  }

  async function archive({ workspaceId }) {
    const result = await mutation(async () => (await store({ mode: "write" })).archive(workspaceId));
    // The store's archive already returns { workspace }; do not re-wrap.
    return result;
  }

  // --- Authored learning content (plan / notes / artifacts) ---
  // Content is bound to the learning workspace's fixed source: the binding is
  // derived HERE from the workspace record (browser-supplied identities are
  // never trusted), then the content store enforces binding equality against
  // the persisted record, so a drifted commit or repository is rejected
  // instead of being silently migrated. Content writes are fast local ops:
  // the expected binding is captured and verified by the same binding guard
  // that serializes every other learning mutation.

  async function readContent(workspaceId, operation) {
    if (hosted) fail("LEARNING_UNAVAILABLE", "托管模式下学习数据不可用。", 404);
    const repository = await store({ mode: "read" });
    if (!repository) fail("WORKSPACE_NOT_FOUND", "学习工作区不存在。", 404);
    await repository.get(workspaceId);
    return operation(repository);
  }

  async function mutateContent({ workspaceId, expectedRevision, payload, save }) {
    return mutation(async () => {
      const repository = await store({ mode: "write" });
      const { workspace } = await repository.get(workspaceId);
      const binding = {
        repositoryId: workspace.repositoryId,
        sourceCommitSha: workspace.sourceCommitSha,
        sourceUrl: workspace.sourceUrl,
      };
      return save(repository.content, { workspaceId, expectedRevision, binding, ...payload });
    });
  }

  async function getContent({ workspaceId }) {
    return readContent(workspaceId, (repository) => repository.content.getContent({ workspaceId }));
  }

  async function listArtifacts({ workspaceId }) {
    return readContent(workspaceId, (repository) => repository.content.listArtifacts({ workspaceId }));
  }

  async function savePlan({ workspaceId, expectedRevision, plan }) {
    return mutateContent({ workspaceId, expectedRevision, payload: { plan }, save: (instance, input) => instance.savePlan(input) });
  }

  async function saveNotes({ workspaceId, expectedRevision, notes }) {
    return mutateContent({ workspaceId, expectedRevision, payload: { notes }, save: (instance, input) => instance.saveNotes(input) });
  }

  async function addArtifact({ workspaceId, expectedRevision, artifact }) {
    return mutateContent({ workspaceId, expectedRevision, payload: { artifact }, save: (instance, input) => instance.addArtifact(input) });
  }

  return Object.freeze({
    capabilities, list, get, createDraft, editDraft, preview, confirm, activate, archive,
    getContent, listArtifacts, savePlan, saveNotes, addArtifact,
  });
}
