'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function payloadFor({ attachments = [], context = {} } = {}) {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '看看这个',
    attachments,
    context,
  });
  return JSON.parse(payload.input.find(item => item.role === 'user').content);
}

function testCurrentAttachmentsAreGroupedSeparatelyFromHistoryCandidates() {
  const wire = payloadFor({
    attachments: [{
      index: 1,
      source_index: 1,
      media_index: 1,
      id: 'file-current',
      file_id: 'file-current',
      name: 'report.pdf',
      type: 'application/pdf',
      is_image: false,
      has_extracted_text: true,
    }],
    context: {
      recent_messages: [],
      image_candidates: [],
      file_candidates: [],
    },
  });
  assert.deepStrictEqual(wire.context.current_attachments, [{
    type: 'file',
    index: 1,
    label: 'report.pdf',
  }], 'current uploads must be published as an explicit current-attachments group');
}


function userPayload(payload) {
  return JSON.parse(payload.input.find(item => item.role === 'user').content);
}

function testCurrentInputPriorityIsDeclaredOnAllIntentPayloads() {
  const expected = {
    schema_version: 'route_evidence_priority.v1',
    order: ['current_input_and_attachments', 'quoted', 'understanding_context'],
    rule: 'current_input_and_attachments > quoted > understanding_context',
  };
  const routePayload = routeService.buildRoutePayload({ model: 'route-model', input: '看这张图', attachments: [], context: {} });
  const understandingPayload = routeService.buildUnderstandingPayload({ model: 'route-model', input: '看这张图', attachments: [], context: {} });
  const imagePlanPayload = routeService.buildImagePlanPayload({ model: 'route-model', input: '生成两张图', goal: '生成两张独立图片', attachments: [], context: {} });
  const multiTaskPayload = routeService.buildMultiTaskPlanPayload({ model: 'route-model', input: '总结文件并画图', goal: '总结文件并画图', attachments: [], context: {} });
  const criticPayload = routeService.buildIntentCriticPayload({ model: 'route-model', input: '检查这张图', attachments: [], context: {} });
  for (const payload of [routePayload, understandingPayload, imagePlanPayload, multiTaskPayload, criticPayload]) {
    assert.deepStrictEqual(userPayload(payload).evidence_priority, expected,
      'every intent node must receive the same current-input-first evidence declaration');
  }
  assert.deepStrictEqual(routeService.ROUTE_EVIDENCE_PRIORITY, expected);
}

function testCurrentAttachmentWinsTheFirstRouteCandidateDirectory() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '我这是网络监控图，判断费用是否划算',
    attachments: [{ id: 'current-chart', imageId: 'current-chart', type: 'image/png', name: 'traffic.png' }],
    context: {
      recent_messages: [
        { index: 1, role: 'user', content: '画一只猫' },
        { index: 2, role: 'assistant', content: '[图片生成完成]' },
      ],
      image_candidates: [{
        source: 'history', image_id: 'old-image', message_index: 2, description: '历史猫图',
      }],
      file_candidates: [],
    },
  });
  assert.deepStrictEqual(userPayload(payload).resource_candidates.map(item => [item.candidate_key, item.type, item.source]), [
    ['i1', 'image', 'current'],
  ], 'history images must not compete with a current attachment on the first route attempt');
}

function testExplicitHistoricalReferenceReopensOnlyTheNeededHistoricalEvidence() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '比较上一张图和当前这张图',
    attachments: [{ id: 'current-chart', imageId: 'current-chart', type: 'image/png', name: 'traffic.png' }],
    context: {
      recent_messages: [{ index: 2, role: 'assistant', content: '[图片生成完成]' }],
      image_candidates: [{
        source: 'history', image_id: 'old-image', message_index: 2, description: '历史猫图',
      }],
      file_candidates: [],
    },
  });
  assert.deepStrictEqual(userPayload(payload).resource_candidates.map(item => [item.candidate_key, item.type, item.source]), [
    ['i1', 'image', 'current'],
    ['i2', 'image', 'history'],
  ], 'an explicit historical reference must reopen history without dropping current evidence');
}

function testImageOrdinalPastCurrentUploadsReopensHistoryImages() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '把第2张改成黑白',
    attachments: [{ id: 'current-one', imageId: 'current-one', type: 'image/png', name: 'one.png' }],
    context: {
      recent_messages: [{ index: 2, role: 'assistant', content: '[图片生成完成]' }],
      image_candidates: [{
        source: 'history', image_id: 'old-image', message_index: 2, description: '历史图',
      }],
      file_candidates: [],
    },
  });
  assert.deepStrictEqual(userPayload(payload).resource_candidates.map(item => [item.candidate_key, item.type, item.source]), [
    ['i1', 'image', 'current'],
    ['i2', 'image', 'history'],
  ], 'an image ordinal counting past the current uploads must reopen history images');
}

function testImageOrdinalSatisfiedByCurrentUploadsKeepsHistoryFolded() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '把第1张改成黑白',
    attachments: [
      { id: 'a', imageId: 'a', type: 'image/png', name: 'a.png' },
      { id: 'b', imageId: 'b', type: 'image/png', name: 'b.png' },
    ],
    context: {
      recent_messages: [{ index: 2, role: 'assistant', content: '[图片生成完成]' }],
      image_candidates: [{
        source: 'history', image_id: 'old-image', message_index: 2, description: '历史图',
      }],
      file_candidates: [],
    },
  });
  assert.deepStrictEqual(userPayload(payload).resource_candidates.map(item => [item.candidate_key, item.type, item.source]), [
    ['i1', 'image', 'current'],
    ['i2', 'image', 'current'],
  ], 'an ordinal the current uploads already satisfy must not reopen unrelated history');
}

function testIntentPayloadsCarryDeliveryFactsOnlyInsideContext() {
  const routePayload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '画完了吗',
    attachments: [],
    context: {
      recent_messages: [{ index: 1, role: 'user', content: '画一只猫' }],
      delivery_evidence: {
        actual_image_result: { available: false },
        assistant_image_claim: { present: true, verified: false },
        image_delivery_confirmed: false,
      },
      image_candidates: [],
      file_candidates: [],
    },
  });
  const understandingPayload = routeService.buildUnderstandingPayload({
    model: 'route-model',
    input: '画完了吗',
    attachments: [],
    context: {
      recent_messages: [{ index: 1, role: 'user', content: '画一只猫' }],
      delivery_evidence: {
        actual_image_result: { available: false },
        assistant_image_claim: { present: true, verified: false },
        image_delivery_confirmed: false,
      },
    },
  });
  for (const payload of [routePayload, understandingPayload]) {
    const envelope = userPayload(payload);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(envelope, 'visual_continuity_evidence'), false,
      'delivery facts belong to context.delivery_evidence; no parallel top-level field may be injected');
    assert.ok(envelope.context && typeof envelope.context.delivery_evidence === 'object',
      'delivery facts must still be published through context');
  }
}

function testTextFocusSuppressesImageRankingClaimOnTheWire() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '哪个效果最好',
    attachments: [],
    context: { conversation_focus: { kind: 'text' }, recent_messages: [], image_candidates: [], file_candidates: [] },
  });
  const claims = userPayload(payload).intent_claims || [];
  assert.strictEqual(claims.some(claim => claim.type === 'image_ranking_question'), false,
    'a text-topic ranking question must not publish an image operation directive');
}

function testImageFocusKeepsImageRankingClaimOnTheWire() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '哪个效果最好',
    attachments: [],
    context: { conversation_focus: { kind: 'image' }, recent_messages: [], image_candidates: [], file_candidates: [] },
  });
  const claims = userPayload(payload).intent_claims || [];
  assert.ok(claims.some(claim => claim.type === 'image_ranking_question'),
    'an image-context ranking question must keep its image_qa directive');
}

function testUnderstandingPayloadSuppressesImageRankingClaimOnTextFocus() {
  // The understanding node consumes the same claim inventory as the route node
  // and must apply the same conversation-focus scoping: a text-topic ranking
  // question must not publish an image operation directive through the
  // understanding payload either.
  const payload = routeService.buildUnderstandingPayload({
    model: 'route-model',
    input: '哪个效果最好',
    attachments: [],
    context: { conversation_focus: { kind: 'text' }, recent_messages: [], image_candidates: [], file_candidates: [] },
  });
  const claims = userPayload(payload).intent_claims || [];
  assert.strictEqual(claims.some(claim => claim.type === 'image_ranking_question'), false,
    'a text-topic ranking question must not publish an image operation directive in the understanding payload');
}

function testHistoryCandidatesAreNotListedAsCurrentAttachments() {
  const wire = payloadFor({
    context: {
      recent_messages: [],
      image_candidates: [{
        index: 1,
        source_index: 1,
        source: 'history',
        image_id: 'img-old',
        reference_id: 'imgref-old',
        target: 'previous',
        message_index: 1,
        description: '一张历史图片',
      }],
      file_candidates: [],
    },
  });
  assert.strictEqual(wire.context.current_attachments, undefined,
    'historical candidates must not be mislabeled as current attachments');
}

module.exports = [
  testCurrentAttachmentsAreGroupedSeparatelyFromHistoryCandidates,
  testCurrentInputPriorityIsDeclaredOnAllIntentPayloads,
  testCurrentAttachmentWinsTheFirstRouteCandidateDirectory,
  testExplicitHistoricalReferenceReopensOnlyTheNeededHistoricalEvidence,
  testImageOrdinalPastCurrentUploadsReopensHistoryImages,
  testImageOrdinalSatisfiedByCurrentUploadsKeepsHistoryFolded,
  testIntentPayloadsCarryDeliveryFactsOnlyInsideContext,
  testTextFocusSuppressesImageRankingClaimOnTheWire,
  testImageFocusKeepsImageRankingClaimOnTheWire,
  testUnderstandingPayloadSuppressesImageRankingClaimOnTextFocus,
  testHistoryCandidatesAreNotListedAsCurrentAttachments,
];
