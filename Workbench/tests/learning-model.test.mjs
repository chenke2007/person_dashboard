import assert from "node:assert/strict";
import test from "node:test";

import {
  LEARNING_GOALS,
  LEARNING_GOAL_LABELS,
  LEARNING_STATE_LABELS,
  projectLearningList,
  projectLearningWorkspace,
} from "../src/lib/learning-model.js";

const uuid = (char) => char.repeat(8) + "-2222-4333-8444-555555555555";

function workspace(overrides = {}) {
  return {
    workspaceId: uuid("1"),
    repositoryId: 101,
    fullName: "synthetic/repo-101",
    sourceUrl: "https://github.com/synthetic/repo-101",
    sourceCommitSha: "a".repeat(40),
    mission: { goal: "learn-usage", notes: "Synthetic study task" },
    state: "draft",
    draftRevision: 2,
    createdAt: "2026-09-02T01:00:00.000Z",
    updatedAt: "2026-09-02T02:00:00.000Z",
    ...overrides,
  };
}

test("exposes exactly the five frozen learning goals with Chinese labels", () => {
  assert.deepEqual(LEARNING_GOALS, [
    "understand-architecture",
    "learn-usage",
    "analyze-design",
    "reproduce-capability",
    "adoption-decision",
  ]);
  assert.deepEqual(LEARNING_GOAL_LABELS, {
    "understand-architecture": "理解架构",
    "learn-usage": "学会使用",
    "analyze-design": "分析设计",
    "reproduce-capability": "复刻核心能力",
    "adoption-decision": "判断是否采用",
  });
  for (const goal of LEARNING_GOALS) {
    assert.ok(LEARNING_GOAL_LABELS[goal], `every goal needs a label, missing ${goal}`);
  }
});

test("learning state labels cover the reachable states and archival is distinct", () => {
  assert.equal(LEARNING_STATE_LABELS.draft, "草稿");
  assert.equal(LEARNING_STATE_LABELS.queued, "排队");
  assert.equal(LEARNING_STATE_LABELS.active, "学习中");
  assert.equal(LEARNING_STATE_LABELS.archived, "学习已归档");
});

test("projectLearningWorkspace normalizes a server workspace for display", () => {
  const projected = projectLearningWorkspace(workspace());
  assert.equal(projected.workspaceId, uuid("1"));
  assert.equal(projected.repositoryId, 101);
  assert.equal(projected.fullName, "synthetic/repo-101");
  assert.equal(projected.sourceCommitSha, "a".repeat(40));
  assert.equal(projected.goal, "learn-usage");
  assert.equal(projected.notes, "Synthetic study task");
  assert.equal(projected.state, "draft");
  assert.equal(projected.draftRevision, 2);
});

test("projectLearningWorkspace tolerates partial or malformed records", () => {
  const projected = projectLearningWorkspace({ mission: null });
  assert.equal(projected.repositoryId, null);
  assert.equal(projected.fullName, null);
  assert.equal(projected.goal, null);
  assert.equal(projected.notes, "");
  assert.equal(projected.state, null);
  assert.equal(projected.draftRevision, 1);
});

test("projectLearningList groups workspaces by reachable state and never drops entries", () => {
  const payload = {
    workspaces: [
      workspace({ workspaceId: uuid("1"), state: "draft" }),
      workspace({ workspaceId: uuid("2"), state: "queued" }),
      workspace({ workspaceId: uuid("3"), state: "active", repositoryId: 102 }),
      workspace({ workspaceId: uuid("4"), state: "active", repositoryId: 103 }),
      workspace({ workspaceId: uuid("5"), state: "archived", repositoryId: 104 }),
    ],
  };
  const list = projectLearningList(payload);
  assert.equal(list.total, 5);
  assert.deepEqual(list.groups.draft.map((w) => w.workspaceId), [uuid("1")]);
  assert.deepEqual(list.groups.queued.map((w) => w.workspaceId), [uuid("2")]);
  assert.deepEqual(list.groups.active.map((w) => w.workspaceId), [uuid("3"), uuid("4")]);
  assert.deepEqual(list.groups.archived.map((w) => w.workspaceId), [uuid("5")]);
  assert.equal(list.anomaly, false);
});

test("projectLearningList flags a data anomaly when the server exceeds three active", () => {
  const payload = {
    workspaces: [
      workspace({ workspaceId: uuid("1"), state: "active", repositoryId: 102 }),
      workspace({ workspaceId: uuid("2"), state: "active", repositoryId: 103 }),
      workspace({ workspaceId: uuid("3"), state: "active", repositoryId: 104 }),
      workspace({ workspaceId: uuid("4"), state: "active", repositoryId: 105 }),
    ],
  };
  const list = projectLearningList(payload);
  assert.equal(list.groups.active.length, 4);
  assert.equal(list.anomaly, true);
});