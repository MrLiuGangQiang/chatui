'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

function testRoutePromptDelegatesVisualDeliveryUnderstandingToTheModel() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /图片交付事实/);
  assert.match(prompt, /delivery_evidence/);
  assert.match(prompt, /actual_image_result\.available=true/);
  assert.ok(prompt.includes('assistant_image_claim未验证不算'));
  assert.match(prompt, /只依赖图片→image_qa，只依赖文件→file_qa，回答同时依赖两者→multimodal_qa绑source\+attachment/);
  assert.match(prompt, /共存不等于共同依赖，不得漏绑一类/);
  assert.match(prompt, /不因提问形式降plain_chat/);
  assert.doesNotMatch(prompt, /当前输入依赖当前图片\/文件时必须选image_qa\/file_qa/);
}

function testJointImageAndFileRequestCannotDegradeToSingleModalOperation() {
  const input = '根据图片和这份商品说明，判断图片中的产品是否符合文档要求。';
  const attachments = [
    { id: 'image-product', type: 'image/png', name: 'product.png' },
    { id: 'file-spec', type: 'application/pdf', name: 'specification.pdf', has_extracted_text: true },
  ];
  const raw = JSON.stringify({
    operation: 'image_qa',
    relation: 'new',
    goal: '根据图片判断产品是否符合文档要求。',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'i1', role: 'source' }],
    task_shape: 'single',
  });
  const issues = routeService.routeIntentSemanticIssuesForIntent(raw, {
    input,
    attachments,
    context: {},
  });
  assert.ok(issues.some(issue => issue.code === 'route_operation_mismatch' && issue.field === 'operation'),
    'a joint image+file request must enter repair instead of silently dropping one media type');
}

function testModelOwnedVisualDeliveryDecisionIsNotLocallyOverridden() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation: 'followup',
    goal: '解释堂屋正中的入户双开门。',
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [],
  }), {
    input: '堂屋正中的入户双开门多宽？',
    attachments: [],
    context: {
      recent_messages: [
        { index: 1, role: 'user', content: '生成住宅户型图，中央设置堂屋。' },
        { index: 2, role: 'assistant', content: '建议采用内开双开门。' },
      ],
    },
  });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'plain_chat');
  assert.strictEqual(result.route.dispatchAuthorized, true);
}

async function testJointMediaMismatchIsRepairedBeforeDispatch() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const calls = [];
  const input = '根据图片和这份商品说明，判断图片中的产品是否符合文档要求。';
  const attachments = [
    { id: 'image-product', imageId: 'image-product', type: 'image/png', name: 'product.png', source: 'current' },
    { id: 'file-spec', fileId: 'file-spec', type: 'application/pdf', name: 'specification.pdf', source: 'current', has_extracted_text: true },
  ];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [{ id: 'session-joint-media', messages: [] }], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      const name = payload?.text?.format?.name || '';
      calls.push({ purpose: String(options.requestPurpose || ''), name });
      if (name === 'chatui_intent_understanding_v1') {
        return { output_text: JSON.stringify({
          schema_version: 'intent_understanding.v1',
          dependency: 'new',
          actions: [{ index: 1, kind: 'multimodal_qa', target: '判断图片产品是否符合文档要求', resolved_refs: [
            { candidate_key: 'i1', text: '图片' },
            { candidate_key: 'f1', text: '商品说明' },
          ] }],
        }) };
      }
      if (name === 'chatui_route_intent_v3') {
        return { output_text: JSON.stringify({
          operation: 'image_qa', relation: 'new', goal: '判断图片产品是否符合文档要求',
          goal_mode: 'replace', resource_refs: [{ candidate_key: 'i1', role: 'source' }], task_shape: 'single',
        }) };
      }
      if (name === 'chatui_route_repair_v1') {
        return { output_text: JSON.stringify({
          schema_version: 'route_repair.v1', changed_fields: ['operation', 'resource_refs'],
          operation: 'multimodal_qa', relation: 'new', goal: '判断图片产品是否符合文档要求',
          goal_mode: 'replace', resource_refs: [
            { candidate_key: 'i1', role: 'source' },
            { candidate_key: 'f1', role: 'attachment' },
          ], task_shape: 'single',
        }) };
      }
      throw new Error('unexpected route request: ' + name);
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, attachments, 'session-joint-media', null, {
      recent_messages: [], image_candidates: [], file_candidates: [],
    });
    assert.strictEqual(route.operationType, 'multimodal_qa');
    assert.strictEqual(route.readiness, 'ready');
    assert.strictEqual(route.dispatchAuthorized, true);
    assert.deepStrictEqual(route.resources.map(resource => [resource.type, resource.role]), [
      ['image', 'source'], ['file', 'attachment'],
    ]);
    assert.strictEqual(calls.filter(call => call.purpose === 'route_repair').length, 1);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

module.exports = [
  testRoutePromptDelegatesVisualDeliveryUnderstandingToTheModel,
  testJointImageAndFileRequestCannotDegradeToSingleModalOperation,
  testJointMediaMismatchIsRepairedBeforeDispatch,
  testModelOwnedVisualDeliveryDecisionIsNotLocallyOverridden,
];
