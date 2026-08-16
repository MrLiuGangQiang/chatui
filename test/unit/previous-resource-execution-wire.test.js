'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function previousImageQaContext() {
  return {
    recent_messages: [
      { index: 1, role: 'user', content: '这是什么品种？' },
      { index: 2, role: 'assistant', content: '看起来像英国短毛猫。' },
    ],
    image_candidates: [
      {
        index: 1,
        source: 'history',
        image_id: 'img-history-cat-after-qa',
        reference_id: 'imgref-history-cat-after-qa',
        description: '刚才完成品种问答的猫图',
      },
      {
        index: 2,
        source: 'history',
        image_id: 'img-history-dog-unrelated',
        reference_id: 'imgref-history-dog-unrelated',
        description: '另一轮中的狗图',
      },
    ],
    file_candidates: [],
    previous_resource_execution: {
      schema_version: 'previous_resource_execution.v1',
      operation: 'image_qa',
      source_message_index: 1,
      response_message_index: 2,
      image_count: 1,
      file_count: 0,
      images: [{
        image_id: 'img-history-cat-after-qa',
        reference_id: 'imgref-history-cat-after-qa',
        index: 1,
      }],
      files: [],
    },
  };
}

function testPreviousReadOnlyExecutionPublishesExactCandidateKeys() {
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '把猫的颜色改成黑色，背景保持不变。',
    attachments: [],
    context: previousImageQaContext(),
  }).input[1].content);

  assert.deepStrictEqual(payload.context.previous_resource_execution, {
    operation: 'image_qa',
    resource_refs: [{ candidate_key: 'i1', type: 'image' }],
    source_message_index: 1,
    response_message_index: 2,
  }, 'the exact resource set used by the previous read-only execution must cross the wire as candidate keys');
  assert.ok(!JSON.stringify(payload).includes('img-history-cat-after-qa'));
  assert.ok(!JSON.stringify(payload).includes('imgref-history-cat-after-qa'));
  assert.ok(!payload.context.previous_resource_execution.resource_refs.some(ref => ref.candidate_key === 'i2'),
    'unrelated bounded history must remain selectable but must not enter the previous execution anchor');
}

function testRoutePromptUsesExecutionAnchorThenUniqueHistoricalSemantics() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /P4[^。\n]*previous_resource_execution\.resource_refs/);
  assert.match(prompt, /P5历史名称\/主体\/特征相似不自动绑定[^。\n]*明确指代\/沿用\/参考\/修改/);
  assert.doesNotMatch(prompt, /猫图|品种问答|改成黑色/,
    'the production prompt must express a general routing rule rather than encode the regression example');
}

module.exports = [
  testPreviousReadOnlyExecutionPublishesExactCandidateKeys,
  testRoutePromptUsesExecutionAnchorThenUniqueHistoricalSemantics,
];
