'use strict';

const assert = require('assert');

const intentContract = require('../../client/core/intent-contract');
const routeService = require('../../client/services/route-service');

function baseContract(overrides = {}) {
  return {
    schema_version: 'task_contract.v5',
    readiness: 'ready',
    operation: 'plain_chat',
    relation: 'new',
    resources: [],
    directive: {
      mode: 'standalone',
      base_resource_keys: [],
      unmentioned_policy: 'allow_change',
      operations: [],
      constraints: [],
    },
    clarification: { question: '', unresolved_resources: [] },
    confidence: 0.95,
    review_reasons: [],
    rationale: 'test contract',
    ...overrides,
  };
}

function imageResource(key, overrides = {}) {
  return {
    key,
    type: 'image',
    source: 'current',
    role: 'target',
    index: 1,
    id: '',
    reference_id: '',
    missing: false,
    ...overrides,
  };
}

function patchDirective(keys) {
  return {
    mode: 'patch',
    base_resource_keys: keys,
    unmentioned_policy: 'preserve',
    operations: [],
    constraints: [],
  };
}

function testPureTextToImageRejectsEveryImageResource() {
  const contract = baseContract({
    operation: 'text_to_image',
    relation: 'followup',
    resources: [imageResource('r1', {
      source: 'history',
      role: 'reference',
      index: 1,
      id: 'img-old',
      reference_id: 'imgref-old',
    })],
    directive: patchDirective(['r1']),
  });

  assert.strictEqual(intentContract.hasExactContractShape(contract), false);
  assert.strictEqual(routeService.parseRouteResult(JSON.stringify(contract), {
    input: '这张不对，重新生成',
    context: {
      image_candidates: [{ index: 1, source: 'history', image_id: 'img-old', reference_id: 'imgref-old' }],
    },
  }), null);
}

function testTextToImageMayBindAHistoricalMessageButNeverAnImage() {
  const contract = baseContract({
    operation: 'text_to_image',
    relation: 'followup',
    resources: [{
      key: 'r1',
      type: 'message',
      source: 'history',
      role: 'context',
      index: 1,
      id: 'message-1',
      reference_id: '',
      missing: false,
    }],
    directive: patchDirective(['r1']),
  });

  assert.strictEqual(intentContract.hasExactContractShape(contract), true);
  const route = routeService.parseRouteResult(JSON.stringify(contract), {
    input: '把它改成水彩风格',
    context: {
      recent_messages: [{ index: 1, role: 'user', id: 'message-1', content: '一座海边灯塔' }],
    },
  });
  assert.ok(route);
  assert.strictEqual(route.operationType, 'text_to_image');
  assert.deepStrictEqual(route.executionResources.images, []);
  assert.deepStrictEqual(route.executionResources.messages.map(item => item.key), ['r1']);
}

function testEditProjectionSeparatesTargetsAndMasks() {
  const contract = baseContract({
    operation: 'edit_image',
    resources: [
      imageResource('r1', { role: 'target', index: 1, id: 'target-1', reference_id: 'ref-1' }),
      imageResource('r2', { role: 'mask', index: 2, id: 'mask-1', reference_id: 'ref-1' }),
    ],
    directive: patchDirective(['r1', 'r2']),
  });
  const attachments = [
    { id: 'target-1', image_id: 'target-1', reference_id: 'ref-1', type: 'image/png', is_image: true, media_index: 1 },
    { id: 'mask-1', image_id: 'mask-1', reference_id: 'ref-1', type: 'image/png', is_image: true, media_index: 2 },
  ];

  const projection = intentContract.taskContractToExecutionResources(contract, {
    attachments,
    context: {},
    requireCandidateMatch: true,
  });
  assert.deepStrictEqual(projection.targets.map(item => item.key), ['r1']);
  assert.deepStrictEqual(projection.masks.map(item => item.key), ['r2']);
  assert.deepStrictEqual(projection.references, []);
  assert.strictEqual(projection.images.length, 2);
  assert.deepStrictEqual(projection.images[0], {
    key: 'r1',
    type: 'image',
    source: 'current',
    role: 'target',
    index: 1,
    id: 'target-1',
    reference_id: 'ref-1',
    identity_aliases: [],
    index_aliases: [],
  });
}

function testExecutionProjectionRetainsValidatedCurrentAttachmentAlias() {
  const contract = baseContract({
    operation: 'edit_image',
    resources: [imageResource('r1', { id: 'upload-att-1', reference_id: 'imgref_uploaded_2' })],
    directive: patchDirective(['r1']),
  });
  const projection = intentContract.taskContractToExecutionResources(contract, {
    context: {
      recent_messages: [{ index: 2, role: 'user' }],
      image_candidates: [{ index: 3, source_index: 1, source: 'current', image_id: 'img_imgref_uploaded_2_1', reference_id: 'imgref_uploaded_2' }],
    },
    attachments: [{ id: 'upload-att-1', image_id: 'upload-att-1', media_index: 1, source_index: 1, is_image: true, type: 'image/png' }],
    requireCandidateMatch: true,
  });
  assert.strictEqual(projection.images[0].id, 'img_imgref_uploaded_2_1');
  assert.deepStrictEqual(projection.images[0].identity_aliases, ['upload-att-1']);
}

function testEditContractRejectsMultipleMasksBecauseTransportHasOneMaskSlot() {
  const contract = baseContract({
    operation: 'edit_image',
    resources: [
      imageResource('r1', { role: 'target', index: 1 }),
      imageResource('r2', { role: 'mask', index: 2 }),
      imageResource('r3', { role: 'mask', index: 3 }),
    ],
    directive: patchDirective(['r1', 'r2', 'r3']),
  });
  assert.strictEqual(intentContract.hasExactContractShape(contract), false);
}

module.exports = [
  testPureTextToImageRejectsEveryImageResource,
  testTextToImageMayBindAHistoricalMessageButNeverAnImage,
  testEditProjectionSeparatesTargetsAndMasks,
  testExecutionProjectionRetainsValidatedCurrentAttachmentAlias,
  testEditContractRejectsMultipleMasksBecauseTransportHasOneMaskSlot,
];
