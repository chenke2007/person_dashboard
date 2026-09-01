import test from "node:test";
import assert from "node:assert/strict";
import { applyChatEvent, canConfirmDraft, safeChatUrl } from "../src/lib/knowledge-state.js";
import * as editorState from "../src/lib/knowledge-state.js";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

test("stream state replaces partial answer on completion and keeps verified sources", () => {
  let state = applyChatEvent({}, { type: "start", runId: "one" });
  state = applyChatEvent(state, { type: "text", runId: "one", text: "partial [S9]" });
  state = applyChatEvent(state, { type: "sources", runId: "one", sources: [{ key: "S1" }] });
  state = applyChatEvent(state, { type: "done", runId: "one", session: { messages: [{ content: "verified [S1]", sources: [{ key: "S1" }] }] } });
  assert.equal(state.session.messages[0].content, "verified [S1]");
  assert.equal(state.done, true);
  assert.equal(applyChatEvent(state, { type: "text", runId: "old", text: "wrong" }).text, state.text);
});
test("changing any reviewed draft field disables confirmation", () => {
  const form = { title: "Backup", category: "concepts", body: "# Backup" };
  const preview = { ...form, confirmationToken: "fixture", version: 1, expiresAt: "2999-01-01T00:00:00Z" };
  assert.equal(canConfirmDraft(form, preview, false), true);
  for (const change of [{ title: "Other" }, { category: "questions" }, { body: "different" }]) assert.equal(canConfirmDraft({ ...form, ...change }, preview, false), false);
  assert.equal(canConfirmDraft(form, preview, true), false);
  assert.equal(canConfirmDraft(form, { ...preview, expiresAt: "2000-01-01T00:00:00Z" }, false), false);
});
test("chat links reject executable protocols and arbitrary local paths", () => {
  assert.equal(safeChatUrl("javascript:alert(1)"), "");
  assert.equal(safeChatUrl("file:///private/file"), "");
  assert.equal(safeChatUrl("data:text/html,test"), "");
  assert.equal(safeChatUrl("#source-S1"), "#source-S1");
  assert.equal(safeChatUrl("https://example.com/docs"), "https://example.com/docs");
});

test("draft editor stays mounted through follow-up and cancel; refresh preserves unsaved fields", async () => {
  const source = await readFile(new URL("../src/components/KnowledgeAssistant.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /!busy\s*&&\s*latestDraft\s*&&/);
  assert.doesNotMatch(source, /disabled=\{!runtime\?\.createEnabled\}/);
  const base = { title: "Backup", category: "concepts", body: "original" };
  const edited = { ...base, body: "my unsaved edit" };
  assert.deepEqual(editorState.refreshDraftForm(edited, base, { ...base, version: 2 }), edited);
  assert.deepEqual(editorState.refreshDraftForm(base, base, { ...base, body: "server revision" }), { ...base, body: "server revision" });
});

test("a delayed draft save cannot switch back to a previously selected session", () => {
  const current = { id: "new-session", messages: [] };
  assert.equal(editorState.refreshActiveSession(current, { id: "old-session", messages: ["saved"] }), current);
  const updated = { ...current, messages: ["saved"] };
  assert.equal(editorState.refreshActiveSession(current, updated), updated);
});

test("create-disabled draft still renders editable fields and preview but no confirmation", async () => {
  const filename = fileURLToPath(new URL("./knowledge-ui-render.cjs", import.meta.url));
  const result = await build({ stdin: { contents: 'import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import { KnowledgeDraft } from "../src/components/KnowledgeDraft.jsx"; exports.renderDraft = (props) => renderToStaticMarkup(React.createElement(KnowledgeDraft, props));', resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "jsx" }, bundle: true, platform: "node", format: "cjs", jsx: "automatic", packages: "external", write: false });
  const compiled = new Module(filename); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(fileURLToPath(new URL(".", import.meta.url))); compiled.require = createRequire(import.meta.url); compiled._compile(result.outputFiles[0].text, filename);
  const html = compiled.exports.renderDraft({ draft: { id: "draft", version: 1, title: "Backup", category: "concepts", body: "body" }, sessionId: "session", createEnabled: false });
  assert.doesNotMatch(html, /<(?:input|textarea|select)[^>]*disabled/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>确认入库<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>预览保存内容<\/button>/);
});
