import assert from "node:assert/strict";
import test from "node:test";

import { planDraftFromSummary } from "../src/lib/learning-plan.js";

const commitSha = (char) => char.repeat(40);

function summarySections(patch = {}) {
  return {
    problemSolved: "为个人 AI 工作流提供可解释的本地雷达，解决外部项目发现与知识沉淀割裂的问题。",
    coreCapabilities: "候选发现、本地涨星观察、三榜单、摘要与独立学习工作区。",
    techStack: "Node.js ESM、React 19、Vite 6、Zod 3。",
    keyModules: "radar-repository、learning-repository、summary-repository。",
    suitableUseCases: [
      "想快速了解 AI 仓库技术栈的人",
      "需要固定版本做深度学习的人",
    ].join("\n"),
    unsuitableUseCases: "不适合把 Trending 抓取当核心数据源。",
    learningGoalCandidates: "理解雷达的确定性排名设计\n分析学习工作区与备份的绑定关系",
    risksAndBoundaries: "不自动执行仓库脚本，不自动写 Wiki。",
    ...patch,
  };
}

function summary(patch = {}) {
  return {
    repositoryId: 101,
    fullName: "synthetic/reviewed-repository",
    sourceUrl: "https://github.com/synthetic/reviewed-repository",
    sourceCommitSha: commitSha("b"),
    readmeSha: null,
    readmeRef: null,
    readmePath: null,
    sections: summarySections(),
    model: { providerId: "synthetic", modelId: "demo" },
    workflowVersion: 1,
    generatedAt: "2026-09-02T06:00:00.000Z",
    ...patch,
  };
}

test("planDraftFromSummary turns a summary with learningGoalCandidates into an editable draft", () => {
  const draft = planDraftFromSummary(summary());
  assert.ok(draft, "a valid summary must produce a draft");
  assert.equal(draft.learningGoal, "理解雷达的确定性排名设计\n分析学习工作区与备份的绑定关系");
  assert.ok(draft.expectedOutcome.includes("可解释的本地雷达"));
  assert.ok(draft.expectedOutcome.includes("候选发现"));
  assert.deepEqual(draft.milestones.map((m) => m.title), ["想快速了解 AI 仓库技术栈的人", "需要固定版本做深度学习的人"]);
  assert.deepEqual(draft.milestones.map((m) => m.milestoneId), ["milestone-1", "milestone-2"]);
  assert.equal(draft.milestones.every((m) => m.done === false), true);
  assert.equal(draft.currentMilestone, null);
});

test("planDraftFromSummary returns null when there is no summary or no candidates", () => {
  assert.equal(planDraftFromSummary(null), null);
  assert.equal(planDraftFromSummary(undefined), null);
  assert.equal(planDraftFromSummary({}), null);
  assert.equal(planDraftFromSummary(summary({ sections: summarySections({ learningGoalCandidates: "   " }) })), null);
  assert.equal(planDraftFromSummary(summary({ sections: { ...summarySections(), learningGoalCandidates: "" } })), null);
});

test("planDraftFromSummary is a plain-value editable draft, not a persisted or locked plan", () => {
  const draft = planDraftFromSummary(summary());
  assert.equal(typeof draft.learningGoal, "string");
  assert.equal(typeof draft.expectedOutcome, "string");
  assert.equal(Array.isArray(draft.milestones), true);
  // The draft never carries state transitions or completion markers.
  assert.ok(!("state" in draft));
  assert.ok(!("completed" in draft));
  // An empty suitableUseCases yields no milestones but keeps the goal.
  const minimal = planDraftFromSummary(summary({ sections: summarySections({ suitableUseCases: " " }) }));
  assert.deepEqual(minimal.milestones, []);
  assert.equal(minimal.learningGoal, "理解雷达的确定性排名设计\n分析学习工作区与备份的绑定关系");
});

test("planDraftFromSummary strips bullet markers and caps milestone titles", () => {
  const long = "x".repeat(500);
  const draft = planDraftFromSummary(
    summary({ sections: summarySections({ suitableUseCases: ["- 第一类用户", `* ${long}`, "• 第三类"].join("\n") }) }),
  );
  assert.equal(draft.milestones.length, 3);
  assert.equal(draft.milestones[0].title, "第一类用户");
  assert.equal(draft.milestones[1].title.length, 200);
  assert.equal(draft.milestones[2].title, "第三类");
});