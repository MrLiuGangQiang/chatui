'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function sharkPromptContext() {
  return {
    recent_messages: [
      { index: 1, id: 'msg-user', resource_id: 'res:message:msg-user', role: 'user', content: '生成一个鲨鱼的提示词 我要生成图片' },
      { index: 2, id: 'msg-assistant', resource_id: 'res:message:msg-assistant', role: 'assistant', content: '一只巨大的大白鲨在深邃蔚蓝的海水中游动。' },
    ],
    image_candidates: [
      { index: 1, image_id: 'cat1', resource_id: 'res:image:cat1', source: 'history', description: '一只橘猫', message_index: 1 },
      { index: 2, image_id: 'cat2', resource_id: 'res:image:cat2', source: 'history', description: '一只黑猫', message_index: 1 },
    ],
  };
}

function testMessageCandidatesCarryTheirMessageIndexAsRecencySignal() {
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '基于这个生成图片',
    attachments: [],
    context: sharkPromptContext(),
  }).input[1].content);

  const messages = payload.resource_candidates.filter(candidate => candidate.type === 'message');
  assert.deepStrictEqual(
    messages.map(candidate => [candidate.candidate_key, candidate.message_index]),
    [['m1', 1], ['m2', 2]],
    'message candidates must publish message_index (larger = newer) so the router can rank by recency',
  );

  const images = payload.resource_candidates.filter(candidate => candidate.type === 'image');
  assert.deepStrictEqual(
    images.map(candidate => candidate.message_index),
    [1, 1],
    'image candidates keep their source message_index so message vs image recency is comparable',
  );

  // 最新的候选是 m2（鲨鱼提示词文本），其 message_index 严格大于所有猫图。
  const shark = messages.find(candidate => candidate.candidate_key === 'm2');
  assert.ok(images.every(image => shark.message_index > image.message_index),
    'the latest message must rank strictly newer than the stale history images');
}

function testRoutePromptDeclaresRecencyPriorityAsAGeneralRule() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /message_index\s*越大越新/);
  assert.match(prompt, /模糊指代[^。\n]*(?:选|绑定)[^。\n]*最大message_index/);
  // 必须是通用机制，而不是针对具体失败句式打的补丁。
  assert.doesNotMatch(prompt, /基于这个生成图片|鲨鱼|提示词文本/,
    'recency priority must be a general mechanism, not a scenario patch');
}

module.exports = [
  testMessageCandidatesCarryTheirMessageIndexAsRecencySignal,
  testRoutePromptDeclaresRecencyPriorityAsAGeneralRule,
];
