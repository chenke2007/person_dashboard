import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Module, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import React from "react";

const filename = fileURLToPath(new URL("./learning-content-editor.cjs", import.meta.url));
const result = await build({
  stdin: {
    contents: `
      export { LearningContentEditor } from "../src/components/learning/LearningContentEditor.jsx";
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

const window = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : typeof window[key] === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? window[key].bind(window) : window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const commitSha = (char) => char.repeat(40);
const uuid = (char) => char.repeat(8) + "-2222-4333-8444-555555555555";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await act(async () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  await act(async () => {});
}

const workspace = {
  workspaceId: uuid("1"),
  repositoryId: 101,
  sourceCommitSha: commitSha("b"),
};

function contentRecord(overrides = {}) {
  return {
    workspaceId: uuid("1"),
    repositoryId: 101,
    sourceCommitSha: commitSha("b"),
    sourceUrl: "https://github.com/synthetic/repository-101",
    revision: 1,
    learningPlan: {
      learningGoal: "理解该仓库的核心架构",
      expectedOutcome: "能够说明关键取舍并完成小实验",
      milestones: [
        { milestoneId: "milestone-1", title: "阅读架构文档", done: false },
        { milestoneId: "milestone-2", title: "复现核心流程", done: true },
      ],
      currentMilestone: "milestone-1",
    },
    notes: { markdownText: "笔记正文 v1", updatedAt: "2026-09-02T06:00:00.000Z" },
    artifacts: [
      {
        artifactId: uuid("2"),
        type: "总结",
        title: "架构分析",
        markdownText: "产出正文",
        createdAt: "2026-09-02T06:00:00.000Z",
        updatedAt: "2026-09-02T06:00:00.000Z",
      },
    ],
    updatedAt: "2026-09-02T06:00:00.000Z",
    ...overrides,
  };
}

function summaryFixture() {
  return {
    summary: {
      repositoryId: 101,
      fullName: "synthetic/repository-101",
      sourceUrl: "https://github.com/synthetic/repository-101",
      sourceCommitSha: commitSha("b"),
      sections: {
        problemSolved: "为个人 AI 工作流提供可解释的本地雷达。",
        coreCapabilities: "候选发现、本地涨星观察、三榜单。",
        techStack: "Node.js ESM、React 19。",
        keyModules: "radar-repository。",
        suitableUseCases: "想快速了解 AI 仓库的人\n需要固定版本做深度学习的人",
        unsuitableUseCases: "不适合抓取 Trending。",
        learningGoalCandidates: "理解雷达的确定性排名设计\n复刻三榜单的排序逻辑",
        risksAndBoundaries: "不自动写 Wiki。",
      },
      model: { providerId: "synthetic", modelId: "demo" },
      workflowVersion: 1,
      generatedAt: "2026-09-02T06:00:00.000Z",
    },
  };
}

async function mountEditor(t, { props = {}, fns = {} } = {}) {
  const calls = [];
  const defaults = {
    onLoadContent: async () => ({ content: null }),
    onLoadSummary: async (_repositoryId, _sourceCommitSha) => ({ summary: null }),
    onSavePlan: async (_revision, plan) => ({ content: contentRecord({ learningPlan: plan }) }),
    onSaveNotes: async (_revision, markdownText) => ({ content: contentRecord({ notes: { markdownText, updatedAt: "2026-09-02T07:00:00.000Z" } }) }),
    onAddArtifact: async (_revision, artifact) => ({ content: contentRecord({ artifacts: [{ artifactId: uuid("2"), createdAt: "2026-09-02T06:00:00.000Z", updatedAt: "2026-09-02T06:00:00.000Z", ...artifact }] }) }),
  };
  const inputs = { ...defaults, ...fns };
  for (const [name, fn] of Object.entries(inputs)) {
    const tracked = async (...args) => { calls.push({ name, args }); return fn(...args); };
    inputs[name] = tracked;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => {
    root.render(React.createElement(compiled.exports.LearningContentEditor, {
      workspace,
      readOnly: false,
      ...props,
      ...inputs,
    }));
  });
  t.after(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, calls, inputs };
}

const button = (container, text) => [...container.querySelectorAll("button")].find((b) => b.textContent.trim().includes(text));
const setTextarea = async (container, name, value) => {
  const field = container.querySelector(`textarea[name="${name}"]`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(() => { setter.call(field, value); field.dispatchEvent(new window.Event("input", { bubbles: true })); });
};
const setInput = async (container, name, value) => {
  const field = container.querySelector(`input[name="${name}"]`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  await act(() => { setter.call(field, value); field.dispatchEvent(new window.Event("input", { bubbles: true })); });
};

test("renders plan, notes and artifacts sections and saves each with the current revision", async (t) => {
  const { container, calls } = await mountEditor(t, {
    fns: {
      onLoadContent: async () => ({ content: null }),
    },
  });
  await settle();
  assert.match(container.textContent, /学习计划/);
  assert.match(container.textContent, /学习笔记/);
  assert.match(container.textContent, /学习产出/);
  assert.ok(button(container, "保存计划"));
  assert.ok(button(container, "保存笔记"));
  assert.ok(button(container, "添加产出"));
  assert.ok(button(container, "从摘要创建计划"));

  await setTextarea(container, "learningGoal", "手工填写的学习目标");
  await setTextarea(container, "expectedOutcome", "手工填写的预期成果");
  await act(() => button(container, "保存计划").click());
  await settle();
  const planCall = calls.find((call) => call.name === "onSavePlan");
  assert.deepEqual(planCall.args[0], null); // first save carries no prior revision
  assert.equal(planCall.args[1].learningGoal, "手工填写的学习目标");
  assert.equal(planCall.args[1].expectedOutcome, "手工填写的预期成果");
  assert.match(container.textContent, /计划已保存/);

  const planCallsBeforeNotes = calls.filter((call) => call.name === "onSavePlan").length;
  await setTextarea(container, "notesText", "手写的学习笔记");
  await act(() => button(container, "保存笔记").click());
  await settle();
  const noteCall = calls.find((call) => call.name === "onSaveNotes");
  assert.equal(noteCall.args[1], "手写的学习笔记");
  assert.equal(calls.filter((call) => call.name === "onSavePlan").length, planCallsBeforeNotes);
  assert.match(container.textContent, /笔记已保存/);

  await setInput(container, "artifactType", "实验报告");
  await setInput(container, "artifactTitle", "第一个小实验");
  await setTextarea(container, "artifactMarkdown", "实验正文");
  await act(() => button(container, "添加产出").click());
  await settle();
  const artifactCall = calls.find((call) => call.name === "onAddArtifact");
  assert.deepEqual(artifactCall.args[1], { type: "实验报告", title: "第一个小实验", markdownText: "实验正文" });
  assert.match(container.textContent, /产出已添加/);
});

test("an existing record loads into editable fields and saves bump the displayed revision", async (t) => {
  let saved = false;
  const { container, calls } = await mountEditor(t, {
    fns: {
      onLoadContent: async () => ({ content: contentRecord() }),
      onSavePlan: async (revision, plan) => { saved = true; return { content: contentRecord({ revision: 2, learningPlan: plan }) }; },
    },
  });
  await settle();
  const goal = container.querySelector('textarea[name="learningGoal"]');
  assert.equal(goal.value, "理解该仓库的核心架构");
  assert.equal(container.querySelector('textarea[name="notesText"]').value, "笔记正文 v1");
  assert.equal(container.querySelector('input[name="artifactTitle"]').value, ""); // artifact form is never prefilled
  assert.match(container.textContent, /架构分析/);
  assert.match(container.textContent, /里程碑/);

  await setTextarea(container, "learningGoal", "更新后的目标");
  await act(() => button(container, "保存计划").click());
  await settle();
  assert.equal(saved, true);
  const planCall = calls.find((call) => call.name === "onSavePlan");
  assert.equal(planCall.args[0], 1); // existing revision is sent back
  assert.equal(planCall.args[1].learningGoal, "更新后的目标");
  assert.match(container.textContent, /计划已保存/);
});

test("plan save failure surfaces an error and the retry button saves again", async (t) => {
  let attempts = 0;
  const { container, calls } = await mountEditor(t, {
    fns: {
      onLoadContent: async () => ({ content: null }),
      onSavePlan: async (revision, plan) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("计划保存失败，请重试。");
          error.code = "LEARNING_STORAGE_CORRUPT";
          throw error;
        }
        return { content: contentRecord({ revision, learningPlan: plan }) };
      },
    },
  });
  await settle();
  await setTextarea(container, "learningGoal", "需要重试的目标");
  await act(() => button(container, "保存计划").click());
  await settle();
  assert.match(container.textContent, /保存失败/);
  assert.ok(button(container, "重试保存计划"));

  await act(() => button(container, "重试保存计划").click());
  await settle();
  assert.equal(calls.filter((call) => call.name === "onSavePlan").length, 2);
  assert.match(container.textContent, /计划已保存/);
});

test("revision conflict keeps the user's input and retries against the refreshed revision", async (t) => {
  let attempts = 0;
  let loads = 0;
  const userGoal = "用户在冲突中没有丢失的输入";
  const { container, calls } = await mountEditor(t, {
    fns: {
      onLoadContent: async () => {
        loads += 1;
        return { content: contentRecord({ revision: loads === 1 ? 1 : 3, learningPlan: contentRecord().learningPlan }) };
      },
      onSavePlan: async (revision, plan) => {
        attempts += 1;
        if (attempts === 1) {
          assert.equal(revision, 1);
          const error = new Error("学习内容已更新，请刷新后重试。");
          error.code = "REVISION_CONFLICT";
          throw error;
        }
        return { content: contentRecord({ revision: 3, learningPlan: plan }) };
      },
    },
  });
  await settle();
  await setTextarea(container, "learningGoal", userGoal);
  await act(() => button(container, "保存计划").click());
  await settle();

  assert.equal(attempts, 1);
  assert.match(container.textContent, /已更新|冲突/);
  // The latest revision was fetched after the conflict (second load), but the
  // user's in-progress input stays in the field — never overwritten.
  assert.equal(loads, 2);
  assert.equal(container.querySelector('textarea[name="learningGoal"]').value, userGoal);

  await act(() => button(container, "重试保存计划").click());
  await settle();
  const planCalls = calls.filter((call) => call.name === "onSavePlan");
  assert.equal(planCalls.length, 2);
  assert.equal(planCalls[1].args[0], 3); // retried against the refreshed revision
  assert.equal(planCalls[1].args[1].learningGoal, userGoal);
  assert.match(container.textContent, /计划已保存/);
});

test("read-only viewing renders the record without any save controls", async (t) => {
  const { container, calls } = await mountEditor(t, {
    props: { readOnly: true },
    fns: {
      onLoadContent: async () => ({ content: contentRecord() }),
    },
  });
  await settle();
  assert.match(container.textContent, /理解该仓库的核心架构/);
  assert.match(container.textContent, /笔记正文 v1/);
  assert.match(container.textContent, /架构分析/);
  assert.equal(button(container, "保存计划"), undefined);
  assert.equal(button(container, "保存笔记"), undefined);
  assert.equal(button(container, "添加产出"), undefined);
  assert.equal(button(container, "从摘要创建计划"), undefined);
  assert.equal(container.querySelector('textarea[name="learningGoal"]').disabled, true);
  assert.equal(container.querySelector('textarea[name="notesText"]').disabled, true);
  const saves = calls.filter((call) => ["onSavePlan", "onSaveNotes", "onAddArtifact"].includes(call.name));
  assert.equal(saves.length, 0);
});

test("from-summary plan draft fills the editable plan form from learningGoalCandidates", async (t) => {
  const { container, calls } = await mountEditor(t, {
    fns: {
      onLoadContent: async () => ({ content: contentRecord({ learningPlan: { learningGoal: "", expectedOutcome: "", milestones: [], currentMilestone: null } }) }),
      onLoadSummary: async (repositoryId, sourceCommitSha) => {
        assert.equal(repositoryId, 101);
        assert.equal(sourceCommitSha, commitSha("b"));
        return summaryFixture();
      },
    },
  });
  await settle();
  await act(() => button(container, "从摘要创建计划").click());
  await settle();
  const summaryCalls = calls.filter((call) => call.name === "onLoadSummary");
  assert.equal(summaryCalls.length, 1);
  assert.equal(container.querySelector('textarea[name="learningGoal"]').value, "理解雷达的确定性排名设计\n复刻三榜单的排序逻辑");
  assert.match(container.querySelector('textarea[name="expectedOutcome"]').value, /可解释的本地雷达/);
  // The draft is editable: the user can change it before saving.
  await setTextarea(container, "learningGoal", "用户修改后的学习目标");
  await act(() => button(container, "保存计划").click());
  await settle();
  const planCall = calls.find((call) => call.name === "onSavePlan");
  assert.equal(planCall.args[1].learningGoal, "用户修改后的学习目标");
});

test("manual plan entry still works when no summary exists", async (t) => {
  const { container } = await mountEditor(t, {
    fns: {
      onLoadContent: async () => ({ content: null }),
      onLoadSummary: async () => ({ summary: null }),
    },
  });
  await settle();
  await act(() => button(container, "从摘要创建计划").click());
  await settle();
  assert.match(container.textContent, /没有.*固定版本.*摘要|手工填写/);
  // The manual path is never blocked.
  await setTextarea(container, "learningGoal", "没有摘要也能手工填写");
  await act(() => button(container, "保存计划").click());
  await settle();
  assert.match(container.textContent, /计划已保存/);
});