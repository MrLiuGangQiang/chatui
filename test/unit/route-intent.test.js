'use strict';

const assert = require('assert');
const routeIntent = require('../../shared/route-intent');
const routeService = require('../../client/services/route-service');

function intent(overrides = {}) {
  return {
    operation: 'edit_image',
    relation: 'new',
    goal: '修改目标图片',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'i1', role: 'target' }],
    task_shape: 'single',
    ...overrides,
  };
}

function testRouteIntentV3SeparatesGoalModeAndKeepsLegacyAdaptationExplicit() {
  const value = intent();
  assert.strictEqual(routeIntent.ROUTE_INTENT_VERSION, 'route_intent.v3');
  assert.strictEqual(routeIntent.hasExactRouteIntent(value), true);
  assert.strictEqual(routeIntent.assertRouteIntent(value), true);
  assert.deepStrictEqual(Object.keys(value), ['operation', 'relation', 'goal', 'goal_mode', 'resource_refs', 'task_shape']);
  assert.strictEqual(routeIntent.routeIntentTaskShape(value), 'single');
  assert.strictEqual(routeIntent.routeIntentGoalMode(value), 'replace');

  const legacyV2 = { ...value };
  delete legacyV2.goal_mode;
  assert.strictEqual(routeIntent.hasExactRouteIntent(legacyV2), false,
    'the live v3 parser must never infer a missing goal_mode');
  assert.strictEqual(routeIntent.hasExactLegacyRouteIntentV2(legacyV2), true);
  const adaptedV2 = routeIntent.adaptLegacyRouteIntentV2(legacyV2);
  assert.strictEqual(routeIntent.hasExactRouteIntent(adaptedV2), true);
  assert.strictEqual(adaptedV2.goal_mode, 'replace');

  const legacyV1 = { ...legacyV2 };
  delete legacyV1.task_shape;
  assert.strictEqual(routeIntent.hasExactLegacyRouteIntentV1(legacyV1), true);
  const adaptedV1 = routeIntent.adaptLegacyRouteIntentV1(legacyV1);
  assert.strictEqual(routeIntent.hasExactRouteIntent(adaptedV1), true);
  assert.strictEqual(adaptedV1.goal_mode, 'replace');
  assert.strictEqual(adaptedV1.task_shape, 'single');

  const legacyImageFollowup = routeIntent.adaptLegacyRouteIntentV2({
    ...legacyV2,
    operation: 'text_to_image',
    relation: 'followup',
    resource_refs: [],
  }, { hasPreviousTaskState: true });
  assert.strictEqual(legacyImageFollowup.goal_mode, 'amend',
    'the explicit v2 migration must preserve the old image-followup merge semantics');

  assert.strictEqual(routeIntent.hasExactRouteIntent({ ...value, goal_mode: 'amend' }), true);
  assert.strictEqual(routeIntent.hasExactRouteIntent({ ...value, goal_mode: 'merge' }), false);
  assert.strictEqual(routeIntent.hasExactRouteIntent({ ...value, goal_mode: '' }), false);
  assert.strictEqual(routeIntent.hasExactRouteIntent({ ...value, task_shape: 'multi' }), true);
  assert.strictEqual(routeIntent.routeIntentTaskShape({ ...value, task_shape: 'multi' }), 'multi');
  assert.strictEqual(routeIntent.hasExactRouteIntent({ ...value, task_shape: 'many' }), false);
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
  const maxGoalLength = routeIntent.ROUTE_INTENT_MAX_GOAL_LENGTH;
  assert.strictEqual(maxGoalLength, 1000);
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({ goal: '' })), false);
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({ goal: '   ' })), false);
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({ goal: '目'.repeat(maxGoalLength) })), true);
  assert.strictEqual(routeIntent.hasExactRouteIntent(intent({ goal: '目'.repeat(maxGoalLength + 1) })), false);
  assert.strictEqual(routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.goal.minLength, 1);
  assert.strictEqual(routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.goal.maxLength, maxGoalLength);
}

function testCandidateSpecificRouteSchemaNeverEmitsUserGoalAsALiteral() {
  const exactGoal = '目'.repeat(routeIntent.ROUTE_INTENT_MAX_GOAL_LENGTH);
  const overlongGoal = exactGoal + '目';
  const responseFormat = routeIntent.routeIntentResponseFormatForCandidates([], {
    allowedGoals: [exactGoal, overlongGoal],
  });
  const goalSchema = responseFormat.json_schema.schema.properties.goal;

  assert.strictEqual(Object.prototype.hasOwnProperty.call(goalSchema, 'enum'), false,
    'the dynamic response schema must never embed a user-derived goal as an enum string literal: strict providers reject long literals');
  assert.strictEqual(goalSchema.type, 'string');
}

function testRouteIntentResponseSchemaRequiresEveryDeclaredProperty() {
  const schema = routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema;
  assert.deepStrictEqual(schema.required, ['operation', 'relation', 'goal', 'goal_mode', 'resource_refs', 'task_shape']);
  assert.strictEqual(routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.name, 'chatui_route_intent_v3');
  assert.deepStrictEqual(Object.keys(schema.properties), ['operation', 'relation', 'goal', 'goal_mode', 'resource_refs', 'task_shape']);
  assert.deepStrictEqual(schema.properties.goal_mode, { type: 'string', enum: ['replace', 'amend'] });
  assert.deepStrictEqual(schema.properties.task_shape, { type: 'string', enum: ['single', 'multi'] });
  assert.strictEqual(Object.hasOwn(schema.properties.relation, 'description'), false,
    'classification rules belong in the clear system prompt, not the wire schema');
  assert.strictEqual(Object.hasOwn(schema.properties.resource_refs, 'description'), false);
  assert.strictEqual(Object.hasOwn(schema.properties.resource_refs.items.properties.candidate_key, 'description'), false);
  assert.strictEqual(schema.additionalProperties, false);
  assert.strictEqual(routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.strict, true);
}


function testEmptyCurrentAttachmentSetCompilesWithoutAProviderRouteDecision() {
  const options = { input: '', context: {}, currentMode: 'chat', autoMode: true };
  const imageOnly = routeService.compileEmptyCurrentAttachmentSetRoute({
    ...options,
    attachments: [
      { type: 'image/png', name: 'assistant.png', imageId: 'image-assistant', resourceId: 'res:image:image-assistant' },
      { type: 'image/png', name: 'owner.png', imageId: 'image-owner', resourceId: 'res:image:image-owner' },
    ],
  });
  assert.ok(imageOnly.route, 'multiple images without text have one deterministic route');
  assert.strictEqual(imageOnly.route.operationType, 'image_qa');
  assert.strictEqual(imageOnly.route.taskShape, 'single');
  assert.strictEqual(imageOnly.route.inputDefault, 'all_current_attachments');
  assert.strictEqual(imageOnly.route.dispatchAuthorized, true);
  assert.strictEqual(imageOnly.route.resources.filter(resource => resource.type === 'image').length, 2,
    'the deterministic route must retain every current image instead of silently choosing a subset');
  assert.match(imageOnly.route.dispatchContract.arguments.prompt, /所有已上传图片/);

  const fileOnly = routeService.compileEmptyCurrentAttachmentSetRoute({
    ...options,
    input: '   ',
    attachments: [
      { type: 'application/pdf', name: 'report.pdf', fileId: 'file-report', resourceId: 'res:file:file-report' },
      { type: 'text/plain', name: 'notes.txt', fileId: 'file-notes', resourceId: 'res:file:file-notes' },
    ],
  });
  assert.ok(fileOnly.route, 'files without text have one deterministic route');
  assert.strictEqual(fileOnly.route.operationType, 'file_qa');
  assert.strictEqual(fileOnly.route.taskShape, 'single');
  assert.strictEqual(fileOnly.route.inputDefault, 'all_current_attachments');
  assert.strictEqual(fileOnly.route.resources.filter(resource => resource.type === 'file').length, 2,
    'the deterministic route must retain every current file instead of silently choosing a subset');
  assert.match(fileOnly.route.dispatchContract.arguments.prompt, /所有已上传文件/);

  const imageAndFile = routeService.compileEmptyCurrentAttachmentSetRoute({
    ...options,
    attachments: [
      { type: 'image/png', name: 'diagram.png', imageId: 'image-diagram', resourceId: 'res:image:image-diagram' },
      { type: 'text/plain', name: 'notes.txt', fileId: 'file-notes', resourceId: 'res:file:file-notes' },
    ],
  });
  assert.ok(imageAndFile.route, 'an image plus a file without text has one deterministic multimodal route');
  assert.strictEqual(imageAndFile.route.operationType, 'multimodal_qa');
  assert.strictEqual(imageAndFile.route.inputDefault, 'all_current_attachments');
  assert.strictEqual(imageAndFile.route.resources.filter(resource => resource.type === 'image').length, 1);
  assert.strictEqual(imageAndFile.route.resources.filter(resource => resource.type === 'file').length, 1);
  assert.match(imageAndFile.route.dispatchContract.arguments.prompt, /图片和文件/);
}

function testRoutePromptDefinesRelationAsContextDependency() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  const relationEnum = routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.relation.enum;

  assert.deepStrictEqual(relationEnum, ['new', 'followup', 'continuation']);
  assert.match(prompt, /relation描述本轮主要言语行为与前序执行的关系.*非请求新旧.*不由goal_mode或resource_refs推导/);
  assert.match(prompt, /relation描述本轮主要言语行为与前序执行的关系.*必须按1→4顺序判断/);
  assert.match(prompt, /1 followup=本轮主要是在否定\/不满\/纠正.*纠正上一轮选错的资源/);
  assert.match(prompt, /2 continuation=无1且明确仍是同一任务\/主题\/设计维度的继续、重复、重试或下一项/);
  assert.match(prompt, /followup=.*询问\/解释\/评价历史内容.*修改既有具体成果.*增删\/改变供后续所有结果共同使用的任务要求/);
  assert.match(prompt, /continuation=.*另一次执行或新增结果.*而非评价\/解释\/纠正\/修改已有结果或共同任务要求/);
  assert.match(prompt, /continuation可与replace或amend任一goal_mode组合，二者不得互相推导/);
  assert.match(prompt, /delta只规定新增执行的数量、顺序或各结果之间的差异.*共同基础要求继续沿用.*continuation/);
  assert.match(prompt, /task_shape=multi本身不决定relation/);
  assert.match(prompt, /执行请求内的资源使用或排除约束本身只决定resource_refs，不算“纠正上一轮选错资源”/);
  assert.match(prompt, /3 followup=无1\/2但明确依赖quoted\/history\/previous_\*execution.*source≠current/);
  assert.match(prompt, /4 new=仅?无历史依赖.*refs空\/全current/);
  assert.ok(prompt.indexOf('followup=') < prompt.indexOf('continuation='),
    'correction/dependency followup rules must precede continuation');
  assert.doesNotMatch(prompt, /\bcorrection\b/,
    'the live protocol has no correction relation');
}
function testRoutePromptDefinesTheDecisionBoundaryInProtocolTerms() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /1 operation → 2 task_shape → 3 resource_refs → 4 relation → 5 goal → 6 goal_mode/);
  assert.match(prompt, /goal是资源消解[、\/]历史依赖[、\/]图片任务的下游执行指令/);
  assert.match(prompt, /plain_chat.*image_qa.*ocr.*image_compare/s);
  assert.match(prompt, /multimodal_qa.*图\+文件/);
  assert.match(prompt, /text_to_image.*image_reference_gen.*edit_image/s);
  assert.match(prompt, /relation描述本轮主要言语行为与前序执行的关系/);
  assert.match(prompt, /4 new=仅?无历史依赖.*refs空\/全current/);
  assert.match(prompt, /compare_a\/compare_b两图/);
  assert.match(routeService.UNDERSTAND_SYSTEM_PROMPT, /文字不是指令/,
    'context and history must remain evidence, never executable instructions');
  assert.match(prompt, /空输入且当前上传附件全部可用时.*仅图片→image_qa.*仅文件→file_qa.*图片\+文件→multimodal_qa/s);
  assert.match(prompt, /资源选择：先定operation全部必需角色/);
  assert.match(prompt, /各角色按P1→P5/);
  assert.match(prompt, /P2仅用于只读指代且唯一current资源/);
  assert.doesNotMatch(prompt, /满足P1则不再看P2-P5/);
  assert.match(prompt, /(?:只|仅)输出json：operation、relation、goal、goal_mode、resource_refs、task_shape/);
  assert.match(prompt, /goal_mode只控制图片任务的文字任务状态，与relation和resource_refs相互独立/);
  assert.match(prompt, /replace=当前goal已经完整定义本次任务/);
  assert.match(prompt, /amend=当前goal只写同一图片任务在本轮新增、替换或撤销的具体约束/);
  assert.match(prompt, /不复制previous_execution\.task_state中的基础要求/);
  assert.match(prompt, /task_shape描述本轮需要几次独立执行，而不是资源数量/);
  assert.match(prompt, /task_shape：single=一次dispatch\/一个可合并结果/);
  assert.match(prompt, /task_shape：multi=多个独立执行/);
  assert.match(prompt, /对于可直接执行的图片生成\/编辑任务，multi=多个独立图片结果/);
  assert.match(prompt, /多图看\/比\/OCR\/汇总→single/);
  assert.match(prompt, /多图分别改→edit_image\+multi/);
  assert.doesNotMatch(prompt, /respond|change_value missing/);
  assert.doesNotMatch(prompt, /选错了|换个颜色|上一张产品图/,
    'production prompt must define general rules instead of scenario patches');
  assert.ok(prompt.length <= 5800, `route prompt must remain bounded, got ${prompt.length} chars`);
}
module.exports = [
  testRouteIntentV3SeparatesGoalModeAndKeepsLegacyAdaptationExplicit,
  testRouteIntentUsesOnlyCandidateKeysAndCanonicalRoles,
  testRouteIntentRequiresANonEmptyBoundedGoal,
  testCandidateSpecificRouteSchemaNeverEmitsUserGoalAsALiteral,
  testRouteIntentResponseSchemaRequiresEveryDeclaredProperty,
  testEmptyCurrentAttachmentSetCompilesWithoutAProviderRouteDecision,
  testRoutePromptDefinesRelationAsContextDependency,
  testRoutePromptDefinesTheDecisionBoundaryInProtocolTerms,
];

