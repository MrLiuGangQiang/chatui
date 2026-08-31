"use strict";

const assert = require("assert");
const critic = require("../../shared/intent-critic");
const claims = require("../../shared/intent-claims");
const routeService = require("../../client/services/route-service");

function testIntentCriticAcceptsACompleteStructuredVerdict() {
  const value = {
    schema_version: "intent_critic.v1",
    verdict: "accept",
    covered_claims: [{ claim_id: "c1", action_ids: ["a1"] }],
    missing_claims: [],
    conflicts: [],
    unsupported_assumptions: [],
    ambiguous_bindings: [],
    reasons: [],
  };
  assert.strictEqual(critic.hasExactIntentCritic(value), true);
  assert.strictEqual(critic.normalizeIntentCritic(value).verdict, "accept");
}

function testLocalIntentCriticKeepsSemanticsWithTheModel() {
  const goalResult = critic.localCritic({
    input: "只把第二张图的背景改成浅灰色，第一张不要改。",
    route: {
      operationType: "edit_image",
      userGoal: "把背景改成浅灰色",
      taskShape: "single",
      resources: [],
    },
  });
  assert.strictEqual(goalResult.verdict, "accept",
    "goal coverage must not be a local regex gate over the model goal text");

  const rankingResult = critic.localCritic({
    input: "哪个效果最好",
    route: { operationType: "image_compare", userGoal: "比较两张图", resources: [] },
  });
  assert.ok(!rankingResult.reasons.some(reason => reason.code === "route_operation_mismatch"),
    "ranking vs comparison semantics must remain model-owned");
}

function testRouteServiceBuildsReasoningAndCriticPayloadsSafely() {
  const routePayload = routeService.buildRoutePayload({ model: "route", input: "哪个效果最好", intentReasoning: { enabled: true, effort: "high" } });
  assert.deepStrictEqual(routePayload.reasoning, { effort: "high", summary: "auto" });
  assert.strictEqual(routePayload.text.format.name, "chatui_route_intent_v3");
  const routeUserPayload = JSON.parse(routePayload.input.find(item => item.role === 'user').content);
  assert.ok(Array.isArray(routeUserPayload.intent_claims));
  assert.ok(routeUserPayload.intent_claims.some(claim => claim.type === 'image_ranking_question'));

  const textPayload = routeService.buildRoutePayload({
    model: 'route',
    input: '上一个户型要求里的镜像对称是什么意思？',
    context: { image_candidates: [{ source: 'history', index: 1 }] },
  });
  const textUserPayload = JSON.parse(textPayload.input.find(item => item.role === 'user').content);
  assert.deepStrictEqual(textUserPayload.resource_policy.allowed_candidate_keys, []);

  const criticPayload = routeService.buildIntentCriticPayload({
    model: "route",
    input: "哪个效果最好",
    route: { operationType: "image_qa", userGoal: "判断哪个效果最好", taskShape: "single", resources: [] },
  });
  assert.strictEqual(criticPayload.text.format.name, "chatui_intent_critic_v1");
  assert.strictEqual(criticPayload.reasoning.effort, "none", "critic defaults to no reasoning unless explicitly enabled");
}

function testIntentClaimsRemainAProviderHintNotARouteGate() {
  const extracted = claims.extractClaims("把第二张图改成黑白，第一张不要改");
  assert.ok(Array.isArray(extracted));
  assert.strictEqual(typeof routeService.intentGoalCoverage, "undefined",
    "the local goal-coverage gate must no longer be exported");
}

function testOperationPolicyDoesNotTurnTextGenerationIntoImageGeneration() {
  const payload = routeService.buildRoutePayload({ model: 'route', input: '生成一份项目总结' });
  const schema = payload.text.format.schema.properties.operation;
  assert.ok(!schema.enum || schema.enum.length > 1 || !schema.enum.includes('text_to_image'),
    'a non-visual text-generation request must not be forced into image generation');
}

module.exports = [
  testOperationPolicyDoesNotTurnTextGenerationIntoImageGeneration,
  testIntentCriticAcceptsACompleteStructuredVerdict,
  testLocalIntentCriticKeepsSemanticsWithTheModel,
  testRouteServiceBuildsReasoningAndCriticPayloadsSafely,
  testIntentClaimsRemainAProviderHintNotARouteGate,
];
