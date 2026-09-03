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
      import { systemRecoveryAvailable } from "../src/pages/SystemPage.jsx";
      exports.render = (props) => React.createElement(WorkspaceDataPanel, props);
      exports.workspaceDataReducer = workspaceDataReducer;
      exports.initialWorkspaceDataState = initialWorkspaceDataState;
      exports.systemRecoveryAvailable = systemRecoveryAvailable;
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  define: { "import.meta.env": "{}" },
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
    inputIdentity: null,
    requestGeneration: 0,
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

  state = compiled.exports.workspaceDataReducer(state, {
    type: "restore-selected",
    name: "replacement.backup.json",
    inputIdentity: "replacement.backup.json",
    requestGeneration: 1,
  });
  assert.equal(state.restore.confirmationEnabled, false);
  assert.equal(state.restore.preview, null);

  state = compiled.exports.workspaceDataReducer(state, {
    type: "rebind-previewed",
    workspaceId: "",
    requestGeneration: 0,
    preview: { token: "synthetic-rebind-token", requiresConfirmation: true },
  });
  assert.equal(state.rebind.confirmationEnabled, true);

  state = compiled.exports.workspaceDataReducer(state, {
    type: "rebind-selected",
    workspaceId: "workspace-synthetic",
    requestGeneration: 1,
  });
  assert.equal(state.rebind.confirmationEnabled, false);
  assert.equal(state.rebind.preview, null);
});

test("restore preview ignores an older selected bundle after a newer file is selected", () => {
  let state = compiled.exports.workspaceDataReducer(compiled.exports.initialWorkspaceDataState, {
    type: "restore-selected",
    inputIdentity: "bundle-a.json",
    requestGeneration: 1,
  });
  state = compiled.exports.workspaceDataReducer(state, {
    type: "restore-selected",
    inputIdentity: "bundle-b.json",
    requestGeneration: 2,
  });
  state = compiled.exports.workspaceDataReducer(state, {
    type: "restore-previewed",
    inputIdentity: "bundle-a.json",
    requestGeneration: 1,
    preview: { token: "stale-a", requiresConfirmation: true },
  });

  assert.equal(state.restore.confirmationEnabled, false);
  assert.equal(state.restore.token, null);
  assert.equal(state.restore.preview, null);

  state = compiled.exports.workspaceDataReducer(state, {
    type: "restore-previewed",
    inputIdentity: "bundle-b.json",
    requestGeneration: 2,
    preview: { token: "fresh-b", requiresConfirmation: true },
  });
  assert.equal(state.restore.confirmationEnabled, true);
  assert.equal(state.restore.token, "fresh-b");
});

test("rebind preview ignores an older candidate after a newer workspace is selected", () => {
  let state = compiled.exports.workspaceDataReducer(compiled.exports.initialWorkspaceDataState, {
    type: "rebind-selected",
    workspaceId: "workspace-a",
    requestGeneration: 1,
  });
  state = compiled.exports.workspaceDataReducer(state, {
    type: "rebind-selected",
    workspaceId: "workspace-b",
    requestGeneration: 2,
  });
  state = compiled.exports.workspaceDataReducer(state, {
    type: "rebind-previewed",
    workspaceId: "workspace-a",
    requestGeneration: 1,
    preview: { token: "stale-a", requiresConfirmation: true },
  });

  assert.equal(state.rebind.confirmationEnabled, false);
  assert.equal(state.rebind.token, null);
  assert.equal(state.rebind.preview, null);

  state = compiled.exports.workspaceDataReducer(state, {
    type: "rebind-previewed",
    workspaceId: "workspace-b",
    requestGeneration: 2,
    preview: { token: "fresh-b", requiresConfirmation: true },
  });
  assert.equal(state.rebind.confirmationEnabled, true);
  assert.equal(state.rebind.token, "fresh-b");
});

test("hosted System pages do not enable local workspace recovery", () => {
  const liveMutableRuntime = { source: "live", data: { readOnly: false } };
  assert.equal(compiled.exports.systemRecoveryAvailable(liveMutableRuntime, false), false);
  assert.equal(compiled.exports.systemRecoveryAvailable(liveMutableRuntime, true), true);
  assert.equal(compiled.exports.systemRecoveryAvailable({ source: "live", data: { readOnly: true } }, true), false);
});

test("workspace panel does not expose recovery controls outside the local mutable System page", () => {
  assert.equal(render({ available: false }), "");
});
