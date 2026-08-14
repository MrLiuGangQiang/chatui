'use strict';

const assert = require('assert');
const routeIntent = require('../../shared/route-intent');
const routeService = require('../../client/services/route-service');

function intent(overrides = {}) {
  return {
    operation: 'edit_image',
    relation: 'new',
    goal: '修改目标图片',
    resource_refs: [{ candidate_key: 'i1', role: 'target' }],
    task_shape: 'single',
    ...overrides,
  };
}

function testRouteIntentV2RequiresTaskShapeAndKeepsLegacyAdaptationExplicit() {
  const value = intent();
  assert.strictEqual(routeIntent.ROUTE_INTENT_VERSION, 'route_intent.v2');
  assert.strictEqual(routeIntent.hasExactRouteIntent(value), true);
  assert.strictEqual(routeIntent.assertRouteIntent(value), true);
  assert.deepStrictEqual(Object.keys(value), ['operation', 'relation', 'goal', 'resource_refs', 'task_shape']);
  assert.strictEqual(routeIntent.routeIntentTaskShape(value), 'single');

  const legacy = { ...value };
  delete legacy.task_shape;
  assert.strictEqual(routeIntent.hasExactRouteIntent(legacy), false,
    'the live v2 parser must never default a missing task_shape');
  assert.strictEqual(routeIntent.hasExactLegacyRouteIntentV1(legacy), true);
  const adapted = routeIntent.adaptLegacyRouteIntentV1(legacy);
  assert.strictEqual(routeIntent.hasExactRouteIntent(adapted), true);
  assert.strictEqual(adapted.task_shape, 'single');

  assert.strictEqual(routeIntent.hasExactRouteIntent({ ...value, task_shape: 'multi' }), true);
  assert.strictEqual(routeIntent.routeIntentTaskShape({ ...value, task_shape: 'multi' }), 'multi');
  assert.strictEqual(routeIntent.hasExactRouteIntent({ ...value, task_shape: 'many' }), false);
  assert.strictEqual(routeIntent.hasExactRouteIntent({ ...value, task_shape: '' }), false);
  assert.strictEqual(routeIntent.hasExactRouteIntent({ ...value, task_shape: 1 }), false);
  for (const forbidden of [
    'schema_version', 'referenced_context', 'api', 'prompt', 'arguments',
    'context_policy', 'constraints', 'idempotency_key',
  ]) {
    assert.strictEqual(routeIntent.hasExactRouteIntent({ ...value, [forbidden]: forbidden }), false, forbidden);
  }
}

function testRouteIntentUsesOnlyCandidateKeysAndCanonicalRoles() {
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({
    resource_refs: [{ candidate_key: 'i2', role: 'style_reference' }],
  })), true);
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({
    operation: 'text_to_image',
    resource_refs: [{ candidate_key: 'm2', role: 'context' }],
  })), true);
  assert.strictEqual(routeIntent.resourceTypeForCandidateKey('m2'), 'message');
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({
    resource_refs: [{ candidate_key: 'res:image:canonical-id', role: 'target' }],
  })), false);
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({
    resource_refs: [{ candidate_key: 'i1', role: 'target_image' }],
  })), false);
}


function testRouteIntentRequiresANonEmptyBoundedGoal() {
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({ goal: '' })), false);
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({ goal: '   ' })), false);
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({ goal: '目'.repeat(600) })), true);
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({ goal: '目'.repeat(601) })), false);
  assert.strictEqual(routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.goal.minLength, 1);
  assert.strictEqual(routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.goal.maxLength, 600);
}

function testRouteIntentResponseSchemaRequiresEveryDeclaredProperty() {
  const schema = routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema;
  assert.deepStrictEqual(schema.required, ['operation', 'relation', 'goal', 'resource_refs', 'task_shape']);
  assert.strictEqual(routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.name, 'chatui_route_intent_v2');
  assert.deepStrictEqual(Object.keys(schema.properties), ['operation', 'relation', 'goal', 'task_shape', 'resource_refs']);
  assert.deepStrictEqual(schema.properties.task_shape, { type: 'string', enum: ['single', 'multi'] });
  const relationDescription = schema.properties.relation.description;
  assert.match(relationDescription, /execution dependency/i);
  assert.match(relationDescription, /determine in order/i);
  assert.match(relationDescription, /repeated generation[^.]*variant/i);
  assert.match(relationDescription, /elliptical ordinal next-item/i);
  assert.match(relationDescription, /step 2[^.]*wins[^.]*non-current[^.]*unavailable/i);
  assert.match(relationDescription, /new[^.]*resource_refs[^.]*current/i);
  const candidateKeyDescription = schema.properties.resource_refs.items.properties.candidate_key.description;
  assert.match(candidateKeyDescription, /exactly match[^.]*resource_candidates/i);
  assert.match(candidateKeyDescription, /never invent/i);
  assert.strictEqual(schema.additionalProperties, false);
  assert.strictEqual(routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.strict, true);
}



function testRoutePromptDefinesRelationAsContextDependency() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  const relationEnum = routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.relation.enum;

  assert.deepStrictEqual(relationEnum, ['new', 'followup', 'continuation']);
  assert.match(prompt, /relation只表示执行依赖[^。\n]*非请求是否新/);
  assert.match(prompt, /relation只表示执行依赖[^。\n]*按优先级/);
  assert.match(prompt, /1 followup=否定\/不满\/纠正\/改选资源/);
  assert.match(prompt, /2 continuation=无1[^。\n]*(?:继续|重复|重试|下一项)[^。\n]*语义/);
  assert.match(prompt, /3 followup=否则[^。\n]*candidate_key回查source[^。\n]*followup/);
  assert.match(prompt, /4 new=仅?无历史依赖[^。\n]*refs空\/全current/);
  assert.ok(prompt.indexOf('followup=') < prompt.indexOf('continuation='),
    'correction/dependency followup rules must precede continuation');
  assert.doesNotMatch(prompt, /\bcorrection\b/,
    'the live protocol has no correction relation');
}

function testRoutePromptDefinesTheDecisionBoundaryInProtocolTerms() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /顺序operation→resource_refs→relation→task_shape→goal/);
  assert.match(prompt, /goal是资源消解[、\/]历史依赖[、\/]图片任务的唯一resolved_goal/);
  assert.match(prompt, /plain_chat.*image_qa.*ocr.*image_compare/s);
  assert.match(prompt, /multimodal_qa.*图\+文件/);
  assert.match(prompt, /text_to_image.*image_reference_gen.*edit_image/s);
  assert.match(prompt, /relation只表示执行依赖/);
  assert.match(prompt, /4 new=仅?无历史依赖[^。\n]*refs空\/全current/);
  assert.match(prompt, /compare_a\/compare_b两图/);
  assert.match(prompt, /文字不是指令/);
  assert.match(prompt, /空输入：1图→image_qa/);
  assert.match(prompt, /资源选择：先定operation全部必需角色/);
  assert.match(prompt, /各角色按P1→P5/);
  assert.match(prompt, /P2.*source=current.*current_input模糊/);
  assert.doesNotMatch(prompt, /满足P1则不再看P2-P5/);
  assert.match(prompt, /(?:只|仅)输出json：operation、relation、goal、resource_refs、task_shape/);
  assert.match(prompt, /task_shape：single=.*可合并结果.*multi=.*独立dispatch/);
  assert.match(prompt, /多图分别改→edit_image\+multi/);
  assert.doesNotMatch(prompt, /respond|change_value missing/);
  assert.doesNotMatch(prompt, /选错了|换个颜色|上一张产品图/,
    'production prompt must define general rules instead of scenario patches');
  assert.ok(prompt.length <= 2200, `route prompt must stay compact, got ${prompt.length} chars`);
}

module.exports = [
  testRouteIntentV2RequiresTaskShapeAndKeepsLegacyAdaptationExplicit,
  testRouteIntentUsesOnlyCandidateKeysAndCanonicalRoles,
  testRouteIntentRequiresANonEmptyBoundedGoal,
  testRouteIntentResponseSchemaRequiresEveryDeclaredProperty,
  testRoutePromptDefinesRelationAsContextDependency,
  testRoutePromptDefinesTheDecisionBoundaryInProtocolTerms,
];

