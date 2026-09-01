export function applyChatEvent(state, event) {
  if (event.type === "start") return { text: "", sources: [], status: "开始检索…", runId: event.runId };
  if (event.runId && state.runId && event.runId !== state.runId) return state;
  if (event.type === "text") return { ...state, text: (state.text || "") + event.text };
  if (event.type === "sources") return { ...state, sources: event.sources };
  if (event.type === "status") return { ...state, status: event.message };
  if (event.type === "tool") return { ...state, status: event.label, activity: [...(state.activity || []), event.label].slice(-16) };
  if (event.type === "draft") return { ...state, draft: event.draft };
  if (event.type === "done") return { ...state, done: true, session: event.session, status: "完成" };
  if (event.type === "error") return { ...state, error: event.error, status: "未完成" };
  return state;
}
export function canConfirmDraft(form, preview, busy) {
  return Boolean(!busy && preview?.confirmationToken && Date.parse(preview.expiresAt) > Date.now() && ["title", "category", "body"].every((key) => form[key] === preview[key]));
}
export function draftFields(draft) {
  return { title: draft.title, category: draft.category, body: draft.body };
}
export function sameDraftContent(left, right) {
  return ["title", "category", "body"].every((key) => left[key] === right[key]);
}
export function refreshDraftForm(form, previous, current) {
  return sameDraftContent(form, previous) ? draftFields(current) : form;
}
export function refreshActiveSession(current, updated) {
  return current?.id === updated.id ? updated : current;
}
export function safeChatUrl(url = "") {
  if (/^#source-S\d+$/.test(url) || /^https?:\/\/[^\s]+$/i.test(url)) return url;
  return "";
}
