'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function routeMemoryItem(operation, input) {
  return {
    operation,
    input,
    relation: 'followup',
    task_shape: 'single',
    confidence: 0.85,
    source: 'primary_model',
  };
}

function testRecordRouteMemoryIsBoundedAndDeduplicated() {
  const session = {};
  session.routeMemory = routeService.recordRouteMemory(session, routeMemoryItem('file_qa', '总结文件'));
  session.routeMemory = routeService.recordRouteMemory(session, routeMemoryItem('text_to_image', '画一只狗'));
  session.routeMemory = routeService.recordRouteMemory(session, routeMemoryItem('file_qa', '总结文件'));
  assert.strictEqual(session.routeMemory.length, 2);
  assert.strictEqual(session.routeMemory[0].operation, 'file_qa');

  for (let index = 0; index < 10; index += 1) {
    session.routeMemory = routeService.recordRouteMemory(session, routeMemoryItem(`op-${index}`, `input-${index}`));
  }
  assert.ok(session.routeMemory.length <= 6, 'route memory must stay bounded');
}

function testRouteMemoryContextIsCompact() {
  const session = {
    routeMemory: [
      routeMemoryItem('image_qa', '这个呢'),
      routeMemoryItem('edit_image', '换成黑色'),
    ],
  };
  const context = routeService.routeMemoryContext(session);
  assert.strictEqual(context.length, 2);
  assert.deepStrictEqual(Object.keys(context[0]).sort(), [
    'confidence', 'input', 'operation', 'relation', 'source', 'task_shape',
  ].sort());
  assert.strictEqual(context[0].input, '这个呢');
}

function testRoutePayloadIncludesRouteMemoryContext() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '这个呢',
    context: {
      recent_messages: [],
      route_memory: [
        routeMemoryItem('image_qa', '这个呢'),
      ],
    },
  });
  const userPayload = JSON.parse(payload.input.find(message => message.role === 'user').content);
  assert.deepStrictEqual(userPayload.context.route_memory, [{
    input: '这个呢',
    operation: 'image_qa',
    relation: 'followup',
    task_shape: 'single',
    confidence: 0.85,
    source: 'primary_model',
  }]);
}

module.exports = [
  testRecordRouteMemoryIsBoundedAndDeduplicated,
  testRouteMemoryContextIsCompact,
  testRoutePayloadIncludesRouteMemoryContext,
];
