import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(new URL("./summary-ui-render.cjs", import.meta.url));
const result = await build({
  stdin: {
    contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { AiRadarCard } from "../src/components/ai-radar/AiRadarCard.jsx";
      import { SummaryDialog } from "../src/components/summaries/SummaryDialog.jsx";
      exports.AiRadarCard = AiRadarCard;
      exports.SummaryDialog = SummaryDialog;
      exports.renderCard = (props) => renderToStaticMarkup(React.createElement(AiRadarCard, props));
      exports.renderDialog = (props) => renderToStaticMarkup(React.createElement(SummaryDialog, props));
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    loader: "jsx",
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
const { renderCard, renderDialog } = compiled.exports;

const commitSha = (char) => char.repeat(40);

const cardProps = (overrides = {}) => ({
  card: {
    repositoryId: 101,
    fullName: "synthetic/repository-101",
    htmlUrl: "https://github.com/synthetic/repository-101",
    decisionStatus: "unread",
    language: "JavaScript",
    ...(overrides.card ?? {}),
  },
  readOnly: false,
  busy: { decision: null, lessLike: null },
  actionErrors: {},
  onDecide: () => {},
  onLessLike: () => {},
  canJoinLearning: true,
  onJoinLearning: () => {},
  onOpenLearning: () => {},
  canGenerateSummary: false,
  onGenerateSummary: () => {},
  onViewSummary: () => {},
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "card")),
});

const summaryFixture = {
  summaryId: "b84c8e7e-65ae-4f1d-9a16-0b8c4b96c111",
  repositoryId: 101,
  fullName: "synthetic/repository-101",
  sourceUrl: "https://github.com/synthetic/repository-101",
  sourceCommitSha: commitSha("c"),
  readmeSha: "2".repeat(40),
  readmeRef: commitSha("c"),
  readmePath: "README.md",
  generatedAt: "2026-09-02T06:00:00.000Z",
  model: { providerId: "fake-provider", modelId: "fake-model-v1" },
  workflowVersion: 1,
  sections: {
    problemSolved: "Solves synthesis of local AI dashboards",
    coreCapabilities: "Radar, learning workspaces, repositories",
    techStack: "Node, React, Vite",
    keyModules: "server/ai-radar, server/learning",
    suitableUseCases: "Single-user local knowledge work",
    unsuitableUseCases: "Multi-tenant production hosting",
    learningGoalCandidates: "Understand architecture; adopt the loop",
    risksAndBoundaries: "Loopback-only; no cloud persistence",
  },
};

test("radar card with a summary offers 查看摘要 instead of the generate action", () => {
  const html = renderCard(cardProps({ card: { summary: { summaryId: "x", sourceCommitSha: commitSha("c"), generatedAt: "2026-09-02T06:00:00.000Z", model: { providerId: "fake-provider", modelId: "fake-model-v1" } } } }));
  assert.match(html, /aria-label="查看摘要 synthetic\/repository-101"/);
  assert.equal(html.includes("查看摘要"), true);
  assert.equal(html.includes("生成摘要"), false, "an existing summary must not offer regeneration from the card");
  assert.equal(html.includes("尚未配置摘要模型"), false);
});

test("radar card without a summary shows 生成摘要 when the model capability is available", () => {
  const html = renderCard(cardProps({ canGenerateSummary: true }));
  assert.match(html, /aria-label="生成摘要 synthetic\/repository-101"/);
  assert.equal(html.includes("尚未配置摘要模型"), false, "the unconfigured hint must not appear when generation is available");
});

test("radar card without a summary and without a model shows the unconfigured hint, never fabricated content", () => {
  const html = renderCard(cardProps({ canGenerateSummary: false }));
  assert.equal(html.includes("尚未配置摘要模型"), true);
  assert.match(html, /aria-label="生成摘要不可用 synthetic\/repository-101"/);
  assert.equal(html.includes("查看摘要"), false, "a missing summary must not pretend a 查看摘要 action");
  assert.equal(html.includes("解决什么问题"), false, "no summary sections may appear in the card without data");
});

test("readOnly radar card hides the generate action but keeps 查看摘要 for an existing summary", () => {
  const withSummary = renderCard(cardProps({ readOnly: true, card: { summary: { summaryId: "x", sourceCommitSha: commitSha("c"), generatedAt: "2026-09-02T06:00:00.000Z", model: { providerId: "fake-provider", modelId: "fake-model-v1" } } } }));
  assert.equal(withSummary.includes("查看摘要"), true);
  assert.equal(withSummary.includes("生成摘要"), false);
  const withoutModel = renderCard(cardProps({ readOnly: true, canGenerateSummary: true }));
  assert.equal(withoutModel.includes("生成摘要"), false, "read-only views never offer mutations");
});

test("summary dialog pins the fixed commit, model identity and all eight sections", () => {
  const html = renderDialog({ repository: { fullName: "synthetic/repository-101", htmlUrl: "https://github.com/synthetic/repository-101" }, summary: summaryFixture });
  assert.match(html, /固定提交 <code[^>]*>ccccccc/);
  assert.match(html, /模型 fake-provider \/ fake-model-v1/);
  assert.match(html, /生成于 2026-09-02 06:00:00/);
  for (const label of ["解决什么问题", "核心能力", "技术栈", "关键目录或模块", "适合的使用场景", "不适合的使用场景", "适合的学习目标候选", "风险和边界"]) {
    assert.equal(html.includes(label), true, `missing section label ${label}`);
  }
});

test("summary dialog without a model shows the unconfigured notice and no fabricated summary", () => {
  const html = renderDialog({ repository: { fullName: "synthetic/repository-101", htmlUrl: "https://github.com/synthetic/repository-101" }, summary: null, notice: "尚未配置摘要模型。" });
  assert.equal(html.includes("尚未配置摘要模型"), true);
  assert.equal(html.includes("解决什么问题"), false, "an unconfigured model must not fabricate summary content");
  assert.equal(html.includes("查看摘要"), false);
});

test("summary dialog keeps the previous valid summary visible on a failed load and offers retry", () => {
  const html = renderDialog({
    repository: { fullName: "synthetic/repository-101", htmlUrl: "https://github.com/synthetic/repository-101" },
    summary: summaryFixture,
    capabilities: { generate: true },
    error: "摘要加载失败，请重试。",
  });
  assert.equal(html.includes("摘要加载失败，请重试。"), true);
  assert.equal(html.includes("保留了上一次有效摘要。"), true);
  assert.match(html, />重新生成</, "a failed load with a stale summary offers regeneration");
  assert.equal(html.includes("尚未配置摘要模型"), false);
});

test("summary dialog never offers joining learning: joining stays a separate explicit action", () => {
  const html = renderDialog({ repository: { fullName: "synthetic/repository-101", htmlUrl: "https://github.com/synthetic/repository-101" }, summary: summaryFixture, capabilities: { generate: true } });
  assert.equal(html.includes(">加入学习<"), false, "the summary dialog must not contain a join-learning control");
});