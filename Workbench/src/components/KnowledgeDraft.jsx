import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { knowledgeRequest } from "../lib/knowledge-api";
import { canConfirmDraft, draftFields, refreshDraftForm, sameDraftContent, safeChatUrl } from "../lib/knowledge-state";

export function KnowledgeDraft({ draft, sessionId, disabled = false, createEnabled = false, onSaved, onUpdated }) {
  const [form, setForm] = useState(draftFields(draft));
  const baseline = useRef(draft);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState(draft.receipt || null);
  const [recoveryPending, setRecoveryPending] = useState(Boolean(draft.recoveryPending));
  useEffect(() => {
    const previous = baseline.current;
    setForm((current) => previous.id === draft.id ? refreshDraftForm(current, previous, draft) : draftFields(draft));
    setPreview((current) => current?.version === draft.version ? current : null);
    setReceipt(draft.receipt || null); setRecoveryPending(Boolean(draft.recoveryPending)); baseline.current = draft;
  }, [draft.id, draft.version, draft.receipt, draft.recoveryPending]);
  const route = `/sessions/${sessionId}/drafts/${draft.id}`;
  async function review() {
    setBusy(true); setError(""); setPreview(null);
    try {
      if (!sameDraftContent(form, baseline.current)) baseline.current = await knowledgeRequest(`${route}/revise`, form);
      const result = await knowledgeRequest(`${route}/preview`, {});
      baseline.current = result; setPreview(result); setRecoveryPending(Boolean(result.recoveryOnly));
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function commit() {
    if (!canConfirmDraft(form, preview, busy || disabled || !createEnabled)) return;
    setBusy(true); setError("");
    try {
      const result = await knowledgeRequest(`${route}/commit`, { version: preview.version, confirmationToken: preview.confirmationToken });
      setReceipt(result); setPreview(null); onUpdated?.();
    } catch (error) {
      setError(error.message);
      // Keep the exact confirmation for a safe idempotent retry after a lost response.
      try {
        const restored = await knowledgeRequest(`/sessions/${sessionId}`);
        const current = restored.drafts.find((item) => item.id === draft.id);
        if (current?.receipt) { setReceipt(current.receipt); setPreview(null); onUpdated?.(); }
        setRecoveryPending(Boolean(current?.recoveryPending));
      } catch { /* The reviewed token stays available when the service is offline. */ }
    }
    finally { setBusy(false); }
  }
  function edit(key, value) { setForm((old) => ({ ...old, [key]: value })); setPreview(null); }
  return <section className="knowledge-draft" aria-label="知识库文档草稿">
    <div className="knowledge-draft__heading"><strong>整理入库 · 草稿</strong><span>仅新建，不覆盖原文</span></div>
    {receipt ? <div className="knowledge-success" role="status">已保存：{receipt.path}{receipt.indexPending ? "（索引更新中，稍后刷新）" : ""}<button type="button" onClick={() => onSaved(receipt)}>打开新文档</button></div> : <>
      {recoveryPending && <p role="status">上次保存尚待核验。内容已锁定，请重新预览并确认恢复保存状态；不会覆盖或重复创建文件。</p>}
      <label>文档标题<input value={form.title} maxLength={120} disabled={busy || disabled || recoveryPending} onChange={(event) => edit("title", event.target.value)} /></label>
      <label>保存分类<select value={form.category} disabled={busy || disabled || recoveryPending} onChange={(event) => edit("category", event.target.value)}><option value="concepts">概念与操作手册 · wiki/concepts</option><option value="references">参考资料 · wiki/references</option><option value="questions">问题与解答 · wiki/questions</option></select></label>
      <label>Markdown 正文<textarea rows={12} value={form.body} disabled={busy || disabled || recoveryPending} onChange={(event) => edit("body", event.target.value)} /></label>
      {preview && <div className="knowledge-draft__preview"><p><strong>即将创建：</strong>{preview.path}</p><div className="knowledge-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeChatUrl} components={{ img: () => <span>［图片不自动加载］</span> }}>{preview.documentBody}</ReactMarkdown></div><p>请核对内容、来源和路径。确认后会新增一个 Markdown 文件。</p></div>}
      {!createEnabled && <p>确认入库未启用；仍可编辑和预览草稿。</p>}
      <div className="knowledge-draft__actions"><button type="button" disabled={busy || disabled || !form.title.trim() || !form.body.trim()} onClick={review}>{busy ? "处理中…" : recoveryPending ? "恢复核验 / 预览" : "预览保存内容"}</button><button className="knowledge-primary" type="button" disabled={!canConfirmDraft(form, preview, busy || disabled || !createEnabled)} onClick={commit}>{recoveryPending ? "确认恢复保存状态" : "确认入库"}</button></div>
    </>}
    {error && <p className="knowledge-error" role="alert">{error}</p>}
  </section>;
}
