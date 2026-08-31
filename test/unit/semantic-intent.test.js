"use strict";

const assert = require("assert");
const semanticIntent = require("../../shared/semantic-intent");
const routeService = require("../../client/services/route-service");

function testSemanticIntentBuildsAStableEvidenceEnvelope() {
  const value = semanticIntent.buildSemanticIntent({
    input: "只把第二张图改成黑白，第一张不要改",
    understanding: {
      actions: [{ index: 1, kind: "image_edit", target: "把第二张图改成黑白", resolved_refs: [{ candidate_key: "i2", text: "第二张图" }] }],
    },
  });
  assert.strictEqual(value.schema_version, "semantic_intent.v1");
  assert.strictEqual(value.actions.length, 1);
  assert.strictEqual(value.actions[0].kind, "image_edit");
  assert.ok(value.claims.some(claim => claim.type === "resource_selector"));
  assert.ok(value.claims.some(claim => claim.type === "resource_exclusion"));
  assert.strictEqual(semanticIntent.hasExactSemanticIntent(value), true);
}

function testRouteAndCriticPayloadsShareTheSemanticIntentEvidence() {
  const understanding = {
    schema_version: "intent_understanding.v1",
    dependency: "new",
    actions: [{ index: 1, kind: "image_generate", target: "一只猫", resolved_refs: [] }],
  };
  const routePayload = routeService.buildRoutePayload({ model: "route", input: "画一只猫", understanding });
  const routeUser = JSON.parse(routePayload.input.find(item => item.role === "user").content);
  assert.strictEqual(routeUser.semantic_intent.schema_version, "semantic_intent.v1");
  const criticPayload = routeService.buildIntentCriticPayload({
    model: "route",
    input: "画一只猫",
    understanding,
    route: { operationType: "text_to_image", userGoal: "画一只猫", taskShape: "single", resources: [] },
  });
  const criticUser = JSON.parse(criticPayload.input.find(item => item.role === "user").content);
  assert.deepStrictEqual(criticUser.semantic_intent, routeUser.semantic_intent);
}

module.exports = [
  testSemanticIntentBuildsAStableEvidenceEnvelope,
  testRouteAndCriticPayloadsShareTheSemanticIntentEvidence,
];
