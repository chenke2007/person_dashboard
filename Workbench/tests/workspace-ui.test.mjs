import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const filename = fileURLToPath(new URL("./workspace-ui-render.cjs", import.meta.url));
const result = await build({
  stdin: {
    contents: `
      import React from "react";
      import { WorkspaceDataPanel, workspaceDataReducer, initialWorkspaceDataState } from "../src/components/system/WorkspaceDataPanel.jsx";
      exports.render = (props) => React.createElement(WorkspaceDataPanel, props);
      exports.workspaceDataReducer = workspaceDataReducer;
      exports.initialWorkspaceDataState = initialWorkspaceDataState;
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  packages: "external",
  plugins: [{
    name: "ignore-css",
    setup(buildContext) {
      buildContext.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
    },
  }],
  write: false,
});
const compiled = new Module(filename);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(fileURLToPath(new URL(".", import.meta.url)));
compiled.require = createRequire(import.meta.url);
compiled._compile(result.outputFiles[0].text, filename);

function render(props) {
  return renderToStaticMarkup(React.createElement(compiled.exports.render, props));
}

test("workspace panel exposes local backup, restore preview, and rebind controls", () => {
  const html = render({ available: true });

  assert.match(html, /导出工作台备份/);
  assert.match(html, /预览恢复/);
  assert.match(html, /重新绑定本地工作区/);
  assert.match(html, /凭据、缓存、绝对路径和 Vault 正文不会进入恢复内容/);
  assert.match(html, /disabled=""/);
});

test("workspace confirmation requires a successful preview token and invalidates it when selection changes", () => {
  let state = compiled.exports.initialWorkspaceDataState;
  assert.equal(state.restore.confirmationEnabled, false);
  assert.equal(state.rebind.confirmationEnabled, false);

  state = compiled.exports.workspaceDataReducer(state, {
    type: "restore-previewed",
    preview: {
      token: "synthetic-restore-token",
      requiresConfirmation: true,
      providers: [{ id: "projects", version: 1, count: 2 }],
      warnings: ["凭据、缓存、绝对路径和 Vault 正文不会进入恢复内容。"],
    },
  });
  assert.equal(state.restore.confirmationEnabled, true);
  assert.deepEqual(state.restore.preview.providers, [{ id: "projects", version: 1, count: 2 }]);
  assert.equal("token" in state.restore.preview, false);

  state = compiled.exports.workspaceDataReducer(state, { type: "restore-selected", name: "replacement.backup.json" });
  assert.equal(state.restore.confirmationEnabled, false);
  assert.equal(state.restore.preview, null);

  state = compiled.exports.workspaceDataReducer(state, {
    type: "rebind-previewed",
    preview: { token: "synthetic-rebind-token", requiresConfirmation: true },
  });
  assert.equal(state.rebind.confirmationEnabled, true);

  state = compiled.exports.workspaceDataReducer(state, { type: "rebind-selected", workspaceId: "workspace-synthetic" });
  assert.equal(state.rebind.confirmationEnabled, false);
  assert.equal(state.rebind.preview, null);
});

test("workspace panel does not expose recovery controls outside the local mutable System page", () => {
  assert.equal(render({ available: false }), "");
});
