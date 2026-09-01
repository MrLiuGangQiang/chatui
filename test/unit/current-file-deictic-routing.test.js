'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function currentFile(id = 'current-document') {
  return {
    type: 'application/pdf',
    file_id: id,
    resource_id: `res:file:${id}`,
    source: 'current',
    index: 1,
    source_index: 1,
    name: 'report.pdf',
    has_extracted_text: true,
  };
}

function historicalImageContext(count = 2) {
  return {
    conversation_focus: { kind: 'image' },
    recent_messages: [{ index: 1, role: 'assistant', content: '之前生成过图片。' }],
    image_candidates: Array.from({ length: count }, (_, index) => ({
      image_id: `history-image-${index + 1}`,
      resource_id: `res:image:history-image-${index + 1}`,
      reference_id: `history-ref-${index + 1}`,
      source: 'history',
      index: index + 1,
      description: `历史图片 ${index + 1}`,
    })),
  };
}

function assertCurrentFileRoute(route, id = 'current-document') {
  assert.ok(route);
  assert.strictEqual(route.operationType, 'file_qa');
  assert.strictEqual(route.relation, 'new');
  assert.strictEqual(route.readiness, 'ready');
  assert.strictEqual(route.needClarification, false);
  assert.deepStrictEqual(route.resources.map(resource => ({
    type: resource.type,
    id: resource.id,
    source: resource.source,
    role: resource.role,
  })), [{ type: 'file', id, source: 'current', role: 'attachment' }]);
  assert.strictEqual(route.dispatchContract.context_policy.history, 'none');
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
}

function testModelCanBindTheSingleCurrentFileForADeicticQuestion() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'file_qa',
    relation: 'new',
    goal: '说明所选文件的内容。',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
  }), {
    input: '这是什么',
    attachments: [currentFile()],
    context: historicalImageContext(),
  });

  assert.ok(result.route, result.error || result.reason);
  assertCurrentFileRoute(result.route);
  assert.doesNotMatch(result.route.dispatchContract.arguments.prompt, /^\[execution_semantic_context\.v1\]/);
  assert.strictEqual(result.route.dispatchContract.arguments.prompt, '这是什么');
}

function testWrongImageOperationIsNotLocallyChangedToFileQa() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_qa',
    relation: 'followup',
    goal: '说明历史图片是什么。',
    task_shape: 'single',
    resource_refs: [],
  }), {
    input: '这是什么',
    attachments: [currentFile()],
    context: historicalImageContext(),
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'image_qa');
  assert.strictEqual(result.route.relation, 'followup');
  assert.strictEqual(result.route.readiness, 'needs_clarification');
  assert.strictEqual(result.route.dispatchAuthorized, false);
  assert.deepStrictEqual(result.route.resources, []);
}

function testUnstatedHistoricalImageBindingIsRejectedWhenCurrentFileExists() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_qa',
    relation: 'followup',
    goal: '说明所选历史图片是什么。',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'i1', role: 'source' }],
  }), {
    input: '这是什么',
    attachments: [currentFile()],
    context: historicalImageContext(),
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'image_qa');
  assert.strictEqual(result.route.relation, 'followup');
  assert.strictEqual(result.route.readiness, 'needs_clarification');
  assert.strictEqual(result.route.dispatchAuthorized, false);
  assert.deepStrictEqual(result.route.resources, [],
    'a model cannot bind an omitted historical image when a current file is the only current resource');
}

function testExplicitPreviousImageQuestionStillUsesModelSelectedHistory() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_qa',
    relation: 'followup',
    goal: '说明所选历史图片是什么。',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'i1', role: 'source' }],
  }), {
    input: '上一张图是什么',
    attachments: [currentFile()],
    context: historicalImageContext(1),
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'image_qa');
  assert.strictEqual(result.route.relation, 'followup');
  assert.deepStrictEqual(result.route.resources.map(resource => ({
    type: resource.type,
    id: resource.id,
    source: resource.source,
  })), [{ type: 'image', id: 'history-image-1', source: 'history' }]);
}

module.exports = [
  testModelCanBindTheSingleCurrentFileForADeicticQuestion,
  testWrongImageOperationIsNotLocallyChangedToFileQa,
  testUnstatedHistoricalImageBindingIsRejectedWhenCurrentFileExists,
  testExplicitPreviousImageQuestionStillUsesModelSelectedHistory,
];
