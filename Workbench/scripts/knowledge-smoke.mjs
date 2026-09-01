// Explicit opt-in integration check. Only synthetic temporary documents are sent.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { buildVaultIndex } from "../server/vault-index.mjs";
import { loadModelConfig, createModelClient } from "../server/knowledge-chat/model.mjs";
import { createChatStore } from "../server/knowledge-chat/store.mjs";
import { createDraftService } from "../server/knowledge-chat/drafts.mjs";
import { createKnowledgeService } from "../server/knowledge-chat/service.mjs";

if (process.env.WORKBENCH_KNOWLEDGE_SMOKE !== "true") throw new Error("Explicit WORKBENCH_KNOWLEDGE_SMOKE=true is required");
const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-synthetic-smoke-"));
try {
  const vaultRoot = path.join(root, "vault");
  await mkdir(path.join(vaultRoot, ".raw"), { recursive: true });
  const sourcePath = path.join(vaultRoot, ".raw", "synthetic-backup.md");
  const source = "# 合成测试：备份验证\n本文件仅用于测试，不是真实生产操作。\n步骤：先检查备份清单，再在隔离测试环境验证恢复，最后记录验证结果。\n禁止直接对生产数据库执行。\n";
  await writeFile(sourcePath, source);
  let index = await buildVaultIndex(vaultRoot, { profile: "obsidian" });
  const store = createChatStore({ directory: path.join(root, "state") });
  const getIndex = async () => index;
  const drafts = createDraftService({ store, vaultRoot, getIndex, enabled: true, notifyPaths: async () => { index = await buildVaultIndex(vaultRoot, { profile: "obsidian" }); } });
  const config = await loadModelConfig();
  assert.equal(config.configured, true);
  const service = createKnowledgeService({ store, vaultRoot, getIndex, drafts, model: createModelClient(config) });
  const session = await store.create();
  let textEvents = 0;
  const result = await service.run(session.id, { question: "根据合成测试资料，整理一份简短的备份验证说明。只使用资料中的步骤，不添加命令。输出 Markdown 草稿。", mode: "organize", documentIds: [index.documents[0].id] }, { emit: (event) => { if (event.type === "text") textEvents++; } });
  assert.equal(result.messages.at(-1).status, "complete");
  assert.ok(result.messages.at(-1).sources.length);
  const draft = result.drafts.at(-1);
  assert.ok(draft);
  const preview = await drafts.preview(session.id, draft.id);
  const receipt = await drafts.commit(session.id, draft.id, { version: preview.version, confirmationToken: preview.confirmationToken });
  assert.equal(await readFile(path.join(vaultRoot, receipt.path), "utf8"), preview.documentBody);
  assert.equal(await readFile(sourcePath, "utf8"), source);
  const abort = new AbortController();
  let receivedText = false;
  await assert.rejects(createModelClient(config).complete({ messages: [{ role: "user", content: "这是合成连接测试。请列出一百个编号，每个编号写一句示例说明。" }], signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]), onText() { receivedText = true; abort.abort(); } }));
  assert.equal(receivedText, true);
  console.log(JSON.stringify({ syntheticOnly: true, streamedTextEvents: textEvents, sources: result.messages.at(-1).sources.length, draftGenerated: true, confirmedCreateMatchesPreview: true, originalUnchanged: true, indexed: !receipt.indexPending, liveStreamCancellation: true }));
} finally { await rm(root, { recursive: true, force: true }); }
