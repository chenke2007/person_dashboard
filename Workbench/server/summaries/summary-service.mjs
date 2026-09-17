import { SummaryRepositoryError } from "./summary-repository.mjs";
import { summarySectionsSchema } from "./summary-schema.mjs";
import { SUMMARY_SYSTEM_PROMPT } from "./summary-model.mjs";

// Deep orchestration over the S1 summary store. Owns the parts of the flow that
// cross an adapter seam (radar identity, GitHub head/readme at the fixed commit,
// the optional model) and the workspace-binding guard, so the HTTP layer stays a
// thin router and tests drive the whole flow through one module with an
// injected fake model adapter.

function fail(code, message, status = 400) {
  throw new SummaryRepositoryError(code, message, status);
}

const README_BODY_MAX_CHARS = 120_000;
const README_SHA = /^[a-f0-9]{40}$/;

export class SummaryServiceError extends SummaryRepositoryError {}

export function createRepositorySummaryService({
  runtime = null,
  resolveRepository = null,
  getHeadCommit = null,
  getReadme = null,
  model = null,
  mutatable = true,
  readable = true,
  hosted = false,
} = {}) {
  if (!runtime || typeof runtime.capture !== "function" || typeof runtime.runBound !== "function" || typeof runtime.summary !== "function") {
    throw new TypeError("summary service requires a workspace runtime");
  }
  if (resolveRepository !== null && typeof resolveRepository !== "function") throw new TypeError("resolveRepository must be a function or null");
  if (getHeadCommit !== null && typeof getHeadCommit !== "function") throw new TypeError("getHeadCommit must be a function or null");
  if (getReadme !== null && typeof getReadme !== "function") throw new TypeError("getReadme must be a function or null");
  if (model !== null && (typeof model !== "object" || typeof model.generate !== "function")) throw new TypeError("model must be a summary model adapter or null");

  // Resolve the store lazily so hosted/read-only reads never bind or create a
  // workspace before the capability gate has rejected the request. Reads use a
  // read-only resolution (never creates the summaries directory); mutations ask
  // for a writable one.
  const store = ({ mode = "read" } = {}) => runtime.summary({ mode });

  const modelConfigured = () => Boolean(model && (typeof model.capabilities !== "function" || Boolean(model.capabilities().configured)));

  const mutation = async (operation, binding) => {
    if (hosted) fail("SUMMARY_UNAVAILABLE", "托管模式下仓库摘要不可用。", 404);
    if (!mutatable) fail("SUMMARY_READ_ONLY", "当前工作区不允许生成仓库摘要。", 403);
    try {
      return await runtime.runBound({ binding, operation });
    } catch (error) {
      if (error?.code === "WORKSPACE_BINDING_CHANGED") {
        fail("WORKSPACE_BINDING_CHANGED", "工作区绑定已改变，请重新加载后重试。", 409);
      }
      throw error;
    }
  };

  function summaryCapabilities() {
    return Object.freeze({
      read: readable && !hosted,
      list: readable && !hosted,
      generate: !hosted && mutatable && modelConfigured(),
      modelConfigured: modelConfigured(),
    });
  }

  function requireRepositoryId(repositoryId) {
    if (!Number.isInteger(repositoryId) || repositoryId <= 0) fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
  }

  async function readRepository(repositoryId) {
    if (!resolveRepository) fail("SUMMARY_SOURCE_UNAVAILABLE", "无法解析仓库来源。", 503);
    const repository = await resolveRepository(repositoryId);
    if (!repository) fail("SUMMARY_REPOSITORY_NOT_FOUND", "雷达中不存在该仓库。", 404);
    if (typeof repository?.fullName !== "string") fail("SUMMARY_REPOSITORY_NOT_FOUND", "雷达中不存在该仓库。", 404);
    return repository;
  }

  async function generateSummary({ repositoryId, sourceCommitSha = null, sourceUrl = null, readme = null } = {}) {
    if (hosted) fail("SUMMARY_UNAVAILABLE", "托管模式下仓库摘要不可用。", 404);
    if (!mutatable) fail("SUMMARY_READ_ONLY", "当前工作区不允许生成仓库摘要。", 403);
    requireRepositoryId(repositoryId);
    if (sourceCommitSha !== null && !README_SHA.test(sourceCommitSha)) fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
    if (sourceUrl !== null && (typeof sourceUrl !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/.test(sourceUrl))) {
      fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
    }

    // No model configured: an explicit unavailable state, never a fabricated
    // summary and never a blocked learning/draft flow.
    if (!modelConfigured()) {
      return { status: "unavailable", summary: null, message: "尚未配置摘要模型。" };
    }

    // Capture the expected binding BEFORE any slow remote work, so a rebind
    // landing during GitHub/model calls rejects the stale write instead of
    // writing the old summary into the new workspace.
    const expected = await runtime.capture();

    const repository = await readRepository(repositoryId);
    const fullName = repository.fullName;
    const url = sourceUrl ?? `https://github.com/${fullName}`;
    if (url.toLowerCase() !== `https://github.com/${fullName.toLowerCase()}`) fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");

    // Slow work happens BEFORE the registry/store locks: pin the commit, read
    // the bounded README at exactly that ref, and only then persist.
    let sha = sourceCommitSha;
    if (!sha) {
      let head;
      try {
        head = getHeadCommit ? await getHeadCommit({ fullName }) : null;
      } catch {
        fail("SUMMARY_GITHUB_UNAVAILABLE", "无法读取仓库最新提交，请稍后重试。", 503);
      }
      sha = typeof head?.sha === "string" && README_SHA.test(head.sha) ? head.sha : null;
      if (!sha) fail("SUMMARY_GITHUB_UNAVAILABLE", "无法读取仓库最新提交，请稍后重试。", 503);
    }

    let readmeDoc = readme ?? null;
    if (readmeDoc === null) {
      if (!getReadme) fail("SUMMARY_SOURCE_UNAVAILABLE", "无法读取仓库 README。", 503);
      try {
        readmeDoc = await getReadme({ fullName, ref: sha });
      } catch (error) {
        // A missing README is a legitimate no-readme state, not a failure: the
        // summary stays bound to the commit with a null readme identity.
        if (error?.code === "GITHUB_NOT_FOUND") readmeDoc = null;
        else fail("SUMMARY_GITHUB_UNAVAILABLE", "无法读取仓库 README，请稍后重试。", 503);
      }
    }
    if (readmeDoc !== null && (typeof readmeDoc !== "object" || Array.isArray(readmeDoc))) fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
    const readmeSha = readmeDoc?.sha ? String(readmeDoc.sha) : null;
    const readmeRef = readmeDoc?.ref ? String(readmeDoc.ref) : null;
    const readmePath = readmeDoc?.path ? String(readmeDoc.path) : null;
    if (readmeSha !== null && !README_SHA.test(readmeSha)) fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
    if (typeof readmeDoc?.content === "string" && readmeDoc.content.length > README_BODY_MAX_CHARS) {
      fail("SUMMARY_INVALID_INPUT", "README 内容超过容量限制。", 413);
    }

    // Idempotent fast path: an existing valid summary for this generation key
    // (repositoryId + fixed commit + readme version) returns without re-running
    // the model and without writing a duplicate.
    const read = await store({ mode: "read" });
    if (read) {
      const cached = await read.getSummaryByCommit({ repositoryId, sourceCommitSha: sha });
      if (cached.summary && cached.summary.readmeSha === readmeSha) {
        return mutation(() => ({ status: "ok", summary: cached.summary }), expected);
      }
    }

    let generated;
    try {
      generated = await model.generate({
        repository: {
          fullName: repository.fullName,
          description: repository.description ?? null,
          language: repository.language ?? null,
          topics: Array.isArray(repository.topics) ? repository.topics : [],
          stars: repository.stars ?? null,
          license: repository.license ?? null,
          defaultBranch: repository.defaultBranch ?? null,
          archived: Boolean(repository.archived),
          pushedAt: repository.pushedAt ?? null,
        },
        readme: readmeDoc && typeof readmeDoc.content === "string"
          ? { sha: readmeSha, path: readmePath, content: readmeDoc.content }
          : null,
        system: SUMMARY_SYSTEM_PROMPT,
      });
    } catch (error) {
      if (error?.code === "SUMMARY_MODEL_INVALID_OUTPUT") {
        fail("SUMMARY_MODEL_INVALID_OUTPUT", "模型输出无效，已拒绝保存，请重试。", 502);
      }
      fail("SUMMARY_MODEL_CALL_FAILED", "模型生成失败，请稍后重试。", 502);
    }

    // Validate the untrusted model output against the structured schema
    // (including credential/absolute-path rejection) BEFORE it can touch the
    // store, so an invalid output never overwrites a previous valid summary.
    const parsed = summarySectionsSchema.safeParse(generated?.content);
    if (!parsed.success) {
      fail("SUMMARY_MODEL_INVALID_OUTPUT", "模型输出格式无效，已拒绝保存，请重试。", 502);
    }
    const providerId = typeof generated?.providerId === "string" && generated.providerId ? generated.providerId : "unknown";
    const modelId = typeof generated?.modelId === "string" && generated.modelId ? generated.modelId : "unknown";

    const record = await mutation(async () => {
      const repository = await store({ mode: "write" });
      const result = await repository.persistSummary({
        repositoryId,
        fullName,
        sourceUrl: url,
        sourceCommitSha: sha,
        readmeSha,
        readmeRef,
        readmePath,
        sections: parsed.data,
        model: { providerId, modelId },
        workflowVersion: 1,
      });
      return result.summary;
    }, expected);

    return { status: "ok", summary: record };
  }

  async function getSummary({ repositoryId } = {}) {
    if (hosted) fail("SUMMARY_UNAVAILABLE", "托管模式下仓库摘要不可用。", 404);
    requireRepositoryId(repositoryId);
    const repository = await store({ mode: "read" });
    if (!repository) return { summary: null };
    return repository.getSummary({ repositoryId });
  }

  async function getSummaryByCommit({ repositoryId, sourceCommitSha } = {}) {
    if (hosted) fail("SUMMARY_UNAVAILABLE", "托管模式下仓库摘要不可用。", 404);
    requireRepositoryId(repositoryId);
    if (typeof sourceCommitSha !== "string" || !README_SHA.test(sourceCommitSha)) fail("SUMMARY_INVALID_INPUT", "仓库摘要输入格式无效。");
    const repository = await store({ mode: "read" });
    if (!repository) return { summary: null };
    return repository.getSummaryByCommit({ repositoryId, sourceCommitSha });
  }

  async function listSummaries({ repositoryId } = {}) {
    if (hosted) fail("SUMMARY_UNAVAILABLE", "托管模式下仓库摘要不可用。", 404);
    requireRepositoryId(repositoryId);
    const repository = await store({ mode: "read" });
    if (!repository) return { summaries: [] };
    return repository.listSummaries({ repositoryId });
  }

  return Object.freeze({
    summaryCapabilities, generateSummary, getSummary, getSummaryByCommit, listSummaries,
  });
}
