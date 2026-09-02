"use strict";

const assert = require("assert");
const evaluation = require("../../scripts/lib/intent-routing-evaluation");

const WEB_SEARCH_CASE = Object.freeze({
  id: "chat-goal-paraphrase-contract",
  category: "web-search",
  safety_critical: true,
  input: "搜一下2026年新能源汽车购置税减免的最新政策。",
  attachments: [],
  context: {},
  expected: {
    operation: "web_search",
    relation: "new",
    goal_mode: "replace",
    goal: {
      concepts: [["新能源"], ["购置税"], ["减免", "优惠", "政策"]],
      forbidden: ["candidate_key", "i1", "f1", "m1"],
    },
    clarification: { required: false, unresolved: [] },
    resources: { mode: "exact", items: [] },
    task_shape: "single",
  },
});

function modelRaw(goal) {
  return JSON.stringify({
    operation: "web_search",
    relation: "new",
    goal,
    goal_mode: "replace",
    resource_refs: [],
    task_shape: "single",
  });
}

function testChatExecutionGoalAcceptsFaithfulRestatementInsteadOfOnlyVerbatimInput() {
  // The dispatch layer pins the chat provider prompt to the raw user input
  // (normalizeRouteDraft sets arguments.prompt = current_input), so the route
  // goal is routing evidence: a faithful restatement like "搜索…" for input
  // "搜一下…" must satisfy the execution contract. Before the contract fix
  // this case failed the goal check because execution !== rawInput.
  const result = evaluation.evaluateRouteText(
    JSON.parse(JSON.stringify(WEB_SEARCH_CASE)),
    modelRaw("搜索2026年新能源汽车购置税减免的最新政策"),
  );
  assert.strictEqual(result.checks.valid_route, true, JSON.stringify(result.route_validation_errors));
  assert.strictEqual(result.checks.goal, true,
    "a faithful chat goal restatement must satisfy the execution goal contract");
  assert.strictEqual(result.perfect, true, JSON.stringify(result.failure_reasons));
}

function testChatExecutionGoalStillAcceptsVerbatimInputAndRejectsFaithlessGoal() {
  const verbatim = evaluation.evaluateRouteText(
    JSON.parse(JSON.stringify(WEB_SEARCH_CASE)),
    modelRaw("搜一下2026年新能源汽车购置税减免的最新政策。"),
  );
  assert.strictEqual(verbatim.checks.goal, true, "verbatim input must keep passing the execution goal contract");

  const faithless = evaluation.evaluateRouteText(
    JSON.parse(JSON.stringify(WEB_SEARCH_CASE)),
    modelRaw("查询最新新闻"),
  );
  assert.strictEqual(faithless.checks.goal, false,
    "a restatement that drops required concepts must still fail the contract");
}

module.exports = [
  testChatExecutionGoalAcceptsFaithfulRestatementInsteadOfOnlyVerbatimInput,
  testChatExecutionGoalStillAcceptsVerbatimInputAndRejectsFaithlessGoal,
];
