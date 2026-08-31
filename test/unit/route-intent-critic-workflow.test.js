"use strict";

const assert = require("assert");
const routeIntentWorkflow = require("../../client/app/route-intent-workflow");

function route(overrides = {}) {
  return {
    mode: "chat",
    api: "chat",
    operationType: "plain_chat",
    operationApi: "chat",
    operationMode: "chat",
    relation: "followup",
    goalMode: "replace",
    taskShape: "single",
    userGoal: "回答问题",
    executionPrompt: "回答问题",
    readiness: "ready",
    dispatchAuthorized: true,
    needClarification: false,
    dispatchContract: { operation: "plain_chat" },
    resources: [],
    ...overrides,
  };
}

async function testHighRiskRouteRunsIndependentCriticAndRepairsSemanticIssue() {
  const previous = globalThis.ChatUIRouteService;
  const calls = [];
  let routeCall = 0;
  let criticCall = 0;
  globalThis.ChatUIRouteService = {
    buildRoutePayload: ({ model, intentReasoning }) => ({ model, kind: "route", reasoning: intentReasoning?.enabled ? { effort: intentReasoning.effort } : undefined }),
    buildIntentCriticPayload: ({ model, intentReasoning }) => ({ model, kind: "critic", reasoning: intentReasoning?.enabled ? { effort: intentReasoning.effort } : undefined }),
    buildRouteRepairPayload: ({ model, intentReasoning }) => ({ model, kind: "repair", reasoning: intentReasoning?.enabled ? { effort: intentReasoning.effort } : undefined }),
    extractRouteText: response => response?.text || "",
    inspectModelRouteResult: text => ({ route: text.includes("wrong") ? route({ userGoal: "已完整覆盖请求" }) : route({ userGoal: "已完整覆盖请求" }) }),
    inspectIntentCriticResult: text => ({ critic: { verdict: text.includes("repair") && criticCall === 1 ? "repair" : "accept", reasons: text.includes("repair") && criticCall === 1 ? [{ code: "route_goal_missing_explicit_claim", field: "goal", message: "缺少第二张约束" }] : [] } }),
    routeIntentSemanticIssues: () => [],
    routeIntentSemanticIssuesForIntent: () => [],
    intentCriticSemanticIssues: critic => critic.reasons || [],
  };
  const traces = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: "chat", autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: "https://gateway.example/v1", apiKey: "secret", routeModel: "route-model", chatModel: "route-model" }),
    getSessionRouteModel: () => "route-model",
    getSessionChatModel: () => "route-model",
    buildRouteAttachmentMetadata: () => [],
    requestJson: async (_url, payload, _key, options = {}) => {
      calls.push({ kind: payload.kind, purpose: options.requestPurpose, reasoning: payload.reasoning });
      if (payload.kind === "route") {
        routeCall += 1;
        return { text: routeCall === 1 ? "wrong" : "fixed" };
      }
      if (payload.kind === "critic") { criticCall += 1; return { text: criticCall === 1 ? "repair" : "accept" }; }
      if (payload.kind === "repair") return { text: "fixed" };
      throw new Error("unexpected payload");
    },
  });
  try {
    const result = await workflow.getEffectiveRoute(
      "如果不是这个请求，先处理当前请求，然后继续生成",
      [{ id: "a" }, { id: "b" }],
      "session-1",
      null,
      null,
      { enableIntentCritic: true, onReasoningTrace: trace => traces.push(trace) },
    );
    assert.strictEqual(result.outcome, "ready");
    assert.deepStrictEqual(calls.map(call => call.kind), ["route", "critic", "repair", "critic"]);
    assert.deepStrictEqual(calls.map(call => call.purpose), ["intent_recognition", "intent_critic", "route_repair", "intent_critic"]);
    assert.ok(calls.some(call => call.reasoning?.effort === "medium"), "high-risk stages must carry bounded reasoning");
    assert.ok(traces.length >= 3);
    assert.ok(result.intentReasoningTrace.steps.some(step => step.stage === "repair"));
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

module.exports = [testHighRiskRouteRunsIndependentCriticAndRepairsSemanticIssue];
