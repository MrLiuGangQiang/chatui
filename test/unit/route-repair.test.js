"use strict";

const assert = require("assert");
const routeIntent = require("../../shared/route-intent");
const routeRepair = require("../../shared/route-repair");
const routeService = require("../../client/services/route-service");
const routeIntentWorkflow = require("../../client/app/route-intent-workflow");

function baseIntent(overrides = {}) {
  return {
    operation: "plain_chat",
    relation: "followup",
    goal: "在上一轮的数据库 Markdown 表格中增加厂商信息列",
    goal_mode: "replace",
    resource_refs: [{ candidate_key: "m1", role: "context" }],
    task_shape: "single",
    ...overrides,
  };
}

function patch(overrides = {}) {
  return {
    schema_version: "route_repair.v1",
    changed_fields: ["relation"],
    operation: "plain_chat",
    relation: "followup",
    goal: "在上一轮的数据库 Markdown 表格中增加厂商信息列",
    goal_mode: "replace",
    resource_refs: [{ candidate_key: "m1", role: "context" }],
    task_shape: "single",
    ...overrides,
  };
}

function testRouteRepairUsesAnExplicitVersionedPatchContract() {
  assert.strictEqual(routeRepair.hasExactRouteRepair(patch()), true);
  assert.strictEqual(routeRepair.ROUTE_REPAIR_RESPONSE_FORMAT.json_schema.name, "chatui_route_repair_v1");
  const format = routeRepair.routeRepairResponseFormatForCandidates([{ candidate_key: "m1" }]);
  assert.deepStrictEqual(format.json_schema.schema.properties.resource_refs.items.properties.candidate_key.enum, ["m1"]);
}

function testRouteRepairAppliesOnlyDeclaredFieldsAndPreservesContextBinding() {
  const result = routeService.applyRouteRepairResult(
    baseIntent({ relation: "new" }),
    patch({ relation: "followup" }),
    [{ code: "quoted_evidence_requires_followup", field: "relation" }],
  );
  assert.ok(result.intent);
  assert.deepStrictEqual(result.intent.resource_refs, [{ candidate_key: "m1", role: "context" }]);
  assert.deepStrictEqual(result.changedFields, ["relation"]);
}

function testRouteRepairRejectsAnUndeclaredResourceDrop() {
  const fullRouteReturnedByLegacyGateway = baseIntent({ relation: "followup", resource_refs: [] });
  const inspected = routeService.inspectRouteRepairResult(JSON.stringify(fullRouteReturnedByLegacyGateway), {
    baseIntent: baseIntent({ relation: "new" }),
  });
  assert.ok(inspected.repair, "the compatibility adapter should derive a diff from a legacy full route");
  const result = routeService.applyRouteRepairResult(
    baseIntent({ relation: "new" }),
    inspected.repair,
    [{ code: "quoted_evidence_requires_followup", field: "relation" }],
  );
  assert.strictEqual(result.intent, null);
  assert.strictEqual(result.reason, "route_repair_field_unauthorized");
  assert.strictEqual(result.field, "resource_refs");
}

function testHistoricalTextBindingDoesNotRequireAKeywordCue() {
  const input = "在介绍 MySQL、PostgreSQL 和 MongoDB 的 Markdown 表格中增加一列“厂商信息”";
  const raw = JSON.stringify(baseIntent({ goal: input, resource_refs: [{ candidate_key: "m1", role: "context" }] }));
  const context = messageContext();
  assert.deepStrictEqual(routeService.routeIntentSemanticIssuesForIntent(raw, { input, context }), []);

  const payload = routeService.buildRoutePayload({ model: "route", input, context });
  const publicInput = JSON.parse(payload.input.find(item => item.role === "user").content);
  assert.strictEqual(publicInput.resource_policy, undefined,
    "the route payload must not hide message candidates behind a local policy");
  const allowedKeys = payload.text.format.schema.properties.resource_refs.items.properties.candidate_key.enum;
  assert.ok(allowedKeys.includes("m1"), `the message candidate must remain addressable: ${JSON.stringify(allowedKeys)}`);
}

function messageContext() {
  return {
    conversation_focus: { kind: "text" },
    recent_messages: [{
      index: 36,
      id: "message-36",
      resource_id: "res:message:message-36",
      role: "assistant",
      content: "| 数据库 | 特性 |\n| MySQL | 开源关系数据库 |\n| PostgreSQL | 对象关系数据库 |\n| MongoDB | 文档数据库 |",
    }],
  };
}

function workflowFor(requestJson) {
  return routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: "chat", autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: "https://gateway.example/v1", apiKey: "secret", routeModel: "route-model", chatModel: "route-model" }),
    getSessionRouteModel: () => "route-model",
    getSessionChatModel: () => "route-model",
    requestJson,
  });
}

async function testValidHistoricalTableFollowupDoesNotEnterRepair() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = "在介绍 MySQL、PostgreSQL 和 MongoDB 的 Markdown 表格中增加一列“厂商信息”";
  const calls = [];
  try {
    const workflow = workflowFor(async (_url, payload, _apiKey, options = {}) => {
      calls.push({ name: payload.text?.format?.name, purpose: options.requestPurpose, reasoning: payload.reasoning });
      assert.strictEqual(payload.text?.format?.name, "chatui_route_intent_v3");
      return { output_text: JSON.stringify(baseIntent({ goal: input })) };
    });
    const route = await workflow.getEffectiveRoute(input, [], "session-followup", null, messageContext(), {
      enforceDeterministicPolicies: true,
      enableIntentCritic: true,
    });
    assert.strictEqual(route.outcome, "ready");
    assert.strictEqual(route.relation, "followup");
    assert.deepStrictEqual(route.dispatchContract.context_policy.message_resource_ids, ["res:message:message-36"]);
    assert.deepStrictEqual(calls, [{ name: "chatui_route_intent_v3", purpose: "intent_recognition", reasoning: { effort: "none" } }]);
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testInvalidRepairCannotReplaceTheTrustedRouteBaseline() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = "解释这一段文字";
  const context = {
    quoted_message: {
      role: "assistant",
      id: "message-36",
      resource_id: "res:message:message-36",
      content: "数据库 Markdown 表格",
    },
    recent_messages: [{
      index: 36,
      id: "message-36",
      resource_id: "res:message:message-36",
      role: "assistant",
      content: "数据库 Markdown 表格",
    }],
  };
  const calls = [];
  try {
    const workflow = workflowFor(async (_url, payload, _apiKey, options = {}) => {
      const name = payload.text?.format?.name;
      calls.push({ name, purpose: options.requestPurpose, payload });
      if (name === "chatui_intent_understanding_v1") {
        return { output_text: JSON.stringify({
          schema_version: "intent_understanding.v1",
          dependency: "followup",
          actions: [{ index: 1, kind: "plain_text", target: input, resolved_refs: [{ candidate_key: "m1", text: "数据库 Markdown 表格" }] }],
        }) };
      }
      if (name === "chatui_route_intent_v3") {
        return { output_text: JSON.stringify(baseIntent({ relation: "new", goal: input })) };
      }
      if (name === "chatui_route_repair_v1") {
        // A gateway that ignores route_repair.v1 and returns a full v3 route
        // must still be treated as a constrained diff. This removes m1 without
        // a resource-related repair reason, so it is rejected.
        return { output_text: JSON.stringify(baseIntent({ relation: "followup", goal: input, resource_refs: [] })) };
      }
      throw new Error(`unexpected request ${name || "<missing>"}`);
    });
    const route = await workflow.getEffectiveRoute(input, [], "session-repair", null, context, {
      enforceDeterministicPolicies: true,
    });
    assert.strictEqual(route.outcome, "invalid_model_output");
    assert.strictEqual(route.dispatchContract, null);
    const repairCalls = calls.filter(call => call.name === "chatui_route_repair_v1");
    assert.strictEqual(repairCalls.length, 2, "an invalid patch may use the bounded second repair attempt but must never replace the baseline");
    for (const call of repairCalls) {
      const repairRequest = JSON.parse(call.payload.input.at(-1).content).repair_request;
      assert.deepStrictEqual(repairRequest.base_route_intent.resource_refs, [{ candidate_key: "m1", role: "context" }]);
      assert.deepStrictEqual(repairRequest.allowed_fields, ["relation"]);
    }
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

function testInlineCurrentTextIsNotMistakenForAMissingSource() {
  assert.strictEqual(routeService.missingTextSourceForInput(
    "请把下面这段项目周报改得更专业：本周完成了登录页开发。",
    {},
    [],
  ), false);
  assert.strictEqual(routeService.missingTextSourceForInput(
    "请把下面这段项目周报改得更专业。",
    {},
    [],
  ), true);
}

function testMultilineCurrentTextIsNotMistakenForAMissingSource() {
  assert.strictEqual(routeService.missingTextSourceForInput(
    "请总结下面这段话\n本周完成登录模块，下一周开始联调。",
    {},
    [],
  ), false);
  assert.strictEqual(routeService.missingTextSourceForInput(
    "以下是需要翻译的内容\nThe deployment completed successfully.",
    {},
    [],
  ), false);
  assert.strictEqual(routeService.missingTextSourceForInput(
    "请总结下面这段话\n",
    {},
    [],
  ), true);
  assert.strictEqual(routeService.missingTextSourceForInput(
    "请总结下面这段话\n指出两个问题并给出修改建议。",
    {},
    [],
  ), true);
}

module.exports = [
  testRouteRepairUsesAnExplicitVersionedPatchContract,
  testRouteRepairAppliesOnlyDeclaredFieldsAndPreservesContextBinding,
  testRouteRepairRejectsAnUndeclaredResourceDrop,
  testHistoricalTextBindingDoesNotRequireAKeywordCue,
  testValidHistoricalTableFollowupDoesNotEnterRepair,
  testInvalidRepairCannotReplaceTheTrustedRouteBaseline,
  testInlineCurrentTextIsNotMistakenForAMissingSource,
  testMultilineCurrentTextIsNotMistakenForAMissingSource,
];
