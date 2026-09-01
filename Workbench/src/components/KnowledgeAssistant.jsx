import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconX, IconPlus, IconSend, IconPlayerStop, IconMessageChatbot, IconFileText } from "@tabler/icons-react";
import { knowledgeRequest, streamQuestion } from "../lib/knowledge-api";
import { applyChatEvent, refreshActiveSession, safeChatUrl } from "../lib/knowledge-state";
import { KnowledgeDraft } from "./KnowledgeDraft";
import "../styles/knowledge-assistant.css";

export function KnowledgeAssistant({ open, onClose, incomingDocument, onOpenDocument }) {
  const [runtime, setRuntime] = useState(null), [sessions, setSessions] = useState([]), [session, setSession] = useState(null);
  const [question, setQuestion] = useState(""), [mode, setMode] = useState("ask"), [documents, setDocuments] = useState([]);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [stream, setStream] = useState({}), [picker, setPicker] = useState(false), [query, setQuery] = useState(""), [hits, setHits] = useState([]);
  const abortRef = useRef(null), pendingRef = useRef(null), inputRef = useRef(null), scrollRef = useRef(null), autoScroll = useRef(true);
  async function refreshHistory() { const value = await knowledgeRequest("/sessions"); setSessions(value.items || []); }
  async function initialize() {
    setLoading(true); setError("");
    try { const status = await knowledgeRequest("/status"); setRuntime(status); if (status.enabled) await refreshHistory(); }
    catch (error) { setError(error.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (open && !runtime) initialize(); }, [open]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useEffect(() => { if (incomingDocument) setDocuments((current) => current.some((doc) => doc.id === incomingDocument.id) ? current : [...current, incomingDocument].slice(-8)); }, [incomingDocument]);
  useEffect(() => {
    if (!picker) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try { const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=12`, { signal: controller.signal }); if (!response.ok) throw new Error("资料搜索失败"); const result = await response.json(); setHits(result.items || []); }
      catch (error) { if (!controller.signal.aborted) setError(error.message); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, picker]);
  useEffect(() => { if (autoScroll.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [stream, session, open]);
  async function stopAndWait() { abortRef.current?.abort(); await pendingRef.current?.catch(() => {}); }
  async function newSession() {
    await stopAndWait(); setLoading(true); setError("");
    try { const created = await knowledgeRequest("/sessions", {}); setSession(created); setStream({}); setQuestion(""); setDocuments([]); await refreshHistory(); }
    catch (error) { setError(error.message); } finally { setLoading(false); }
  }
  async function selectSession(id) {
    await stopAndWait(); setLoading(true); setError("");
    try { setSession(await knowledgeRequest(`/sessions/${id}`)); setStream({}); setQuestion(""); setDocuments([]); }
    catch (error) { setError(error.message); } finally { setLoading(false); }
  }
  async function send() {
    if (busy || loading || !question.trim() || !runtime?.configured) return;
    const prompt = question.trim(); setBusy(true); setError(""); setStream({ text: "", status: "准备检索…" }); autoScroll.current = true;
    const controller = new AbortController(); abortRef.current = controller;
    const task = (async () => {
      let active = session;
      try {
        if (!active) active = await knowledgeRequest("/sessions", {}, controller.signal);
        const request = { question: prompt, mode, documentIds: documents.map((doc) => doc.id) };
        setSession({ ...active, messages: [...active.messages, { id: "pending-user", role: "user", content: prompt }] }); setQuestion("");
        await streamQuestion(active.id, request, controller.signal, (event) => {
          setStream((current) => applyChatEvent(current, event));
          if (event.type === "done") setSession(event.session);
          if (event.type === "error") setError(event.error.message);
        });
      } catch (error) { setError(controller.signal.aborted ? "生成已停止，未完成的内容不会入库。" : error.message); }
      finally {
        if (active) { try { setSession(await knowledgeRequest(`/sessions/${active.id}`)); } catch {} }
        try { await refreshHistory(); } catch {}
        setBusy(false); abortRef.current = null; pendingRef.current = null;
      }
    })();
    pendingRef.current = task;
    await task;
  }
  async function openSource(source) {
    try { setError(""); const verified = await knowledgeRequest(`/source?id=${encodeURIComponent(source.documentId)}&hash=${encodeURIComponent(source.hash)}`); onOpenDocument(verified.id); }
    catch (error) { setError(error.message); }
  }
  function renderText(content, sources = []) {
    return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeChatUrl} components={{ img: () => <span>［图片不自动加载］</span>, a: ({ href, children }) => {
      if (href?.startsWith("#source-")) { const source = sources.find((item) => `#source-${item.key}` === href); return source ? <button className="knowledge-citation" type="button" onClick={() => openSource(source)}>{children}</button> : <span>［来源未核验］</span>; }
      return href ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>;
    } }}>{content || ""}</ReactMarkdown>;
  }
  const latestDraft = session?.drafts?.at(-1);
  const displayedMessages = (session?.messages || []).filter((message) => !(busy && message.role === "assistant" && message.status === "running"));
  return <aside className="knowledge-panel" hidden={!open} aria-label="知识库助手">
    <header className="knowledge-header"><div><IconMessageChatbot aria-hidden="true" /><strong>知识库助手</strong><span>DBA KNOWLEDGE</span></div><button type="button" className="icon-button" aria-label="收起知识库助手" onClick={onClose}><IconX /></button></header>
    <div className="knowledge-sessionbar"><select aria-label="历史会话" value={session?.id || ""} disabled={busy || loading} onChange={(event) => event.target.value && selectSession(event.target.value)}><option value="">新对话 / 选择历史会话</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title || "新对话"}</option>)}</select><button type="button" disabled={loading || !runtime?.enabled} onClick={newSession}><IconPlus size={16} />新建</button></div>
    <div className="knowledge-mode" role="group" aria-label="对话模式"><button type="button" aria-pressed={mode === "ask"} disabled={busy} onClick={() => setMode("ask")}>知识问答</button><button type="button" aria-pressed={mode === "organize"} disabled={busy} onClick={() => setMode("organize")}>整理入库</button></div>
    <div className="knowledge-messages" ref={scrollRef} onScroll={(event) => { const el = event.currentTarget; autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; }}>
      {!session?.messages?.length && <div className="knowledge-welcome"><IconMessageChatbot size={32} /><h2>让资料成为可用的知识</h2><p>从你的文档、脚本中找依据。问清楚，再沉淀。</p>{["检索 Oracle RMAN 备份资料，说明恢复前需要检查什么", "查找 RAC ASM 扩容资料和脚本，整理操作手册"].map((example) => <button type="button" key={example} onClick={() => { setQuestion(example); inputRef.current?.focus(); }}>{example}</button>)}<small>问答只读 · 整理先预览 · 确认后才创建文档</small></div>}
      {displayedMessages.map((message) => <article className={`knowledge-message knowledge-message--${message.role}`} key={message.id}><div className="knowledge-message__label">{message.role === "user" ? "你" : "知识库助手"}</div><div className="knowledge-prose">{message.role === "user" ? <p>{message.content}</p> : renderText(message.content, message.sources)}</div>{message.error && <p className="knowledge-error">{message.error.message}</p>}{message.sources?.length > 0 && <details className="knowledge-sources"><summary>本轮读取的 {message.sources.length} 处资料</summary>{message.sources.map((source) => <button key={source.key} type="button" onClick={() => openSource(source)}><span>[{source.key}] {source.title}</span><small>{source.path}</small></button>)}</details>}</article>)}
      {busy && <article className="knowledge-message"><div className="knowledge-message__label">知识库助手 · 生成中</div><div className="knowledge-prose">{renderText(stream.text, stream.sources)}</div><p className="knowledge-status" role="status">{stream.status}</p>{stream.activity?.length > 0 && <details><summary>检索过程</summary>{stream.activity.map((activity, index) => <div key={index}>{activity}</div>)}</details>}</article>}
      {latestDraft && <KnowledgeDraft key={latestDraft.id} draft={latestDraft} sessionId={session.id} disabled={busy || loading} createEnabled={Boolean(runtime?.createEnabled)} onSaved={(receipt) => onOpenDocument(receipt.documentId)} onUpdated={() => knowledgeRequest(`/sessions/${session.id}`).then((updated) => setSession((current) => refreshActiveSession(current, updated))).catch((error) => setError(error.message))} />}
    </div>
    <footer className="knowledge-composer">
      {error && <p className="knowledge-error" role="alert">{error}</p>}
      {loading && <p role="status">正在连接知识库助手…</p>}
      {runtime && (!runtime.enabled || !runtime.configured) && <p className="knowledge-error">{runtime.enabled ? "模型尚未配置。请检查本地模型连接设置。" : "知识库助手未启用。"}<button type="button" onClick={initialize}>重新检查</button></p>}
      {documents.length > 0 && <div className="knowledge-context">{documents.map((doc) => <button type="button" key={doc.id} disabled={busy} title={doc.path || doc.title} onClick={() => setDocuments((items) => items.filter((item) => item.id !== doc.id))}><IconFileText size={13} />{doc.title}<span>×</span></button>)}</div>}
      {picker && <div className="knowledge-picker"><input aria-label="搜索要引用的文件" placeholder="搜索文件名或关键词" value={query} onChange={(event) => setQuery(event.target.value)} />{hits.map((hit) => <button type="button" disabled={busy || documents.length >= 8} key={hit.id} onClick={() => { setDocuments((items) => items.some((item) => item.id === hit.id) ? items : [...items, hit]); setPicker(false); }}><strong>{hit.title}</strong><small>{hit.path}</small></button>)}</div>}
      <textarea ref={inputRef} aria-label="向知识库提问" placeholder={mode === "organize" ? "描述要整理的文档，生成后可预览并确认入库…" : "提问，或用 @文件 指定资料…"} maxLength={8000} rows={3} value={question} disabled={loading || busy} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "@") setPicker(true); if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} />
      <div className="knowledge-sendbar"><button type="button" aria-expanded={picker} disabled={busy} onClick={() => setPicker(!picker)}>＋ @文件 <small>{documents.length}/8</small></button>{busy ? <button type="button" className="knowledge-stop" onClick={() => abortRef.current?.abort()}><IconPlayerStop size={16} />停止</button> : <button type="button" className="knowledge-primary" disabled={loading || !runtime?.configured || !question.trim()} onClick={send}><IconSend size={16} />{mode === "organize" ? "生成草稿" : "发送"}</button>}</div>
      <p className="knowledge-disclosure">{runtime?.model || "未连接模型"} · 相关资料片段将发送到配置的模型服务{runtime?.configured && !runtime.transportEncrypted ? "（网关使用未加密 HTTP）" : ""}。请勿发送敏感凭据。</p>
    </footer>
  </aside>;
}
