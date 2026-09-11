import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Renders the real AppShell under the obsidian profile env (local, not
// hosted: VITE_WORKBENCH_HOSTED stays unset, so the local Workbench gate
// keeps /projects, /ai-radar and /learning in the navigation).
const filename = fileURLToPath(new URL("./appshell-nav-render.cjs", import.meta.url));
const result = await build({
  stdin: {
    contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { MemoryRouter } from "react-router-dom";
      import { AppShell } from "../src/components/AppShell.jsx";
      const renderNav = () =>
        renderToStaticMarkup(
          <MemoryRouter>
            <AppShell onOpenKnowledge={() => {}} onOpenSearch={() => {}} sync={{ status: "watching" }} />
          </MemoryRouter>
        );
      exports.renderNav = renderNav;
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    loader: "jsx",
  },
  define: {
    "import.meta.env": JSON.stringify({ VITE_WORKBENCH_PROFILE: "obsidian" }),
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  packages: "external",
  plugins: [
    {
      name: "ignore-css",
      setup(buildContext) {
        buildContext.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      },
    },
  ],
  write: false,
});
const compiled = new Module(filename);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(fileURLToPath(new URL(".", import.meta.url)));
compiled.require = createRequire(import.meta.url);
compiled._compile(result.outputFiles[0].text, filename);

test("obsidian profile nav shows every implemented public feature", () => {
  const html = compiled.exports.renderNav();
  const entries = [
    ["/", "总览"],
    ["/graph", "知识星图"],
    ["/wiki", "Wiki 层"],
    ["/materials", "DBA 资料与脚本"],
    ["/books", "书架"],
    ["/daily-hot", "每日热点"],
    ["/projects", "项目"],
    ["/ai-radar", "AI 雷达"],
    ["/learning", "学习任务"],
    ["/topics", "灵感库"],
    ["/content", "内容中心"],
  ];
  for (const [to, label] of entries) {
    const escaped = to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(html, new RegExp(`href="${escaped}"`), `obsidian nav must link to ${to}`);
    assert.ok(html.includes(label), `obsidian nav must show the ${to} entry label`);
  }
});

test("obsidian profile nav omits removed social media modules but keeps assistant and branding", () => {
  const html = compiled.exports.renderNav();
  for (const fragment of ["/social-insights", "/douyin", "社媒洞察", "抖音数据"]) {
    assert.ok(!html.includes(fragment), `removed social module fragment must not appear: ${fragment}`);
  }
  assert.ok(html.includes("知识库助手"), "knowledge assistant entry must stay");
  assert.ok(html.includes("个人 AI"), "current brand must stay");
  assert.ok(html.includes("系统状态"), "system status link must stay");
});
