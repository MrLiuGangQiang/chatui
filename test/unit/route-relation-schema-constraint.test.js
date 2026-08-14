'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function imageCandidates(count = 5) {
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    return {
      index,
      source_index: index,
      source: 'history',
      image_id: `img-${index}`,
      reference_id: `imgref-${index}`,
      description: `产品图 ${index}`,
    };
  });
}

function anchoredContext() {
  return {
    recent_messages: [
      { index: 1, role: 'user', content: '第一张是什么颜色？' },
      { index: 2, role: 'assistant', content: '第一张是蓝色。' },
    ],
    previous_resource_execution: {
      operation: 'image_qa',
      image_count: 1,
      file_count: 0,
      source_message_index: 1,
      response_message_index: 2,
      images: [{ image_id: 'img-1', reference_id: 'imgref-1', index: 1 }],
      files: [],
    },
    image_candidates: imageCandidates(),
    file_candidates: [],
  };
}

function relationEnum(input, context) {
  return routeService.buildRoutePayload({
    model: 'route-model',
    input,
    context,
  }).response_format.json_schema.schema.properties.relation.enum;
}

function testEllipticalOrdinalWithExactPriorExecutionIsConstrainedToContinuation() {
  assert.deepStrictEqual(relationEnum('第五张呢', anchoredContext()), ['continuation'],
    'an exact read-only execution anchor plus a bare next-item ordinal is a deterministic continuation fact');
}

function testOrdinalWithoutExecutionAnchorLeavesRelationForTheModelToDecide() {
  const context = anchoredContext();
  delete context.previous_resource_execution;
  assert.deepStrictEqual(relationEnum('第五张呢', context), ['new', 'followup', 'continuation']);
}

function testExplicitNewActionIsNotCollapsedIntoAnEllipticalContinuation() {
  assert.deepStrictEqual(
    relationEnum('把第五张改成黑白效果', anchoredContext()),
    ['new', 'followup', 'continuation'],
    'a concrete operation must remain model-owned even when it contains an ordinal selector',
  );
}

function unavailableFileContext() {
  return {
    recent_messages: [{ index: 1, role: 'user', content: '刚才上传了扫描合同' }],
    image_candidates: [],
    file_candidates: [{
      index: 1,
      source: 'history',
      file_id: 'file-scan',
      name: 'scan-contract.pdf',
      has_extracted_text: false,
      unsupported_reason: '扫描件未提取到正文',
    }],
  };
}

function testExplicitReadOnlyContinuationWinsOverUnavailableHistoryProvenance() {
  assert.deepStrictEqual(
    relationEnum('继续总结刚才那个扫描合同。', unavailableFileContext()),
    ['continuation'],
    'resource availability must not change explicit same-operation continuation semantics',
  );
}

function testCorrectionLanguagePreventsTheUnavailableContinuationConstraint() {
  assert.deepStrictEqual(
    relationEnum('刚才那个不对，请继续总结扫描合同。', unavailableFileContext()),
    ['new', 'followup', 'continuation'],
    'correction priority must remain model-owned instead of being forced to continuation',
  );
}
module.exports = [
  testEllipticalOrdinalWithExactPriorExecutionIsConstrainedToContinuation,
  testOrdinalWithoutExecutionAnchorLeavesRelationForTheModelToDecide,
  testExplicitNewActionIsNotCollapsedIntoAnEllipticalContinuation,
  testExplicitReadOnlyContinuationWinsOverUnavailableHistoryProvenance,
  testCorrectionLanguagePreventsTheUnavailableContinuationConstraint,
];