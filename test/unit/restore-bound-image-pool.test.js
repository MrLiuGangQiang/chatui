'use strict';

const assert = require('assert');
const submitHelpers = require('../../client/app/submit-workflow.helpers');

const isImageFile = item => String(item?.type || '').startsWith('image/');

function editRoute(images) {
  return {
    executionResources: {
      version: 'execution_resources.v2',
      operation: 'edit_image',
      images,
      files: [],
    },
  };
}

async function testRestoreBoundImagePoolCanonicalizesEachRecoveredContractResource() {
  const route = editRoute([{
    key: 'r1', type: 'image', source: 'history', role: 'target', index: 8,
    id: 'img_imgref_idle_4', reference_id: 'imgref_idle',
    identity_aliases: [], index_aliases: [], missing: false,
  }]);
  const calls = [];
  const restored = await submitHelpers.restoreBoundImagePool(route, {
    source: 'history',
    sessionId: 'session-cat',
    getPreviousImageAttachments: async (...args) => {
      calls.push(args);
      return [{
        image_id: 'durable-store-id',
        imageId: 'durable-store-id',
        attachmentId: 'durable-store-id',
        reference_id: 'durable-ref',
        referenceId: 'durable-ref',
        type: 'image/png',
        dataUrl: 'data:image/png;base64,AA==',
      }];
    },
  });

  assert.deepStrictEqual(calls, [['session-cat', null, '', ['img_imgref_idle_4']]],
    'each historical execution resource must be restored by its exact contract ID');
  assert.strictEqual(restored.length, 1);
  assert.strictEqual(restored[0].imageId, 'img_imgref_idle_4');
  assert.strictEqual(restored[0].image_id, 'img_imgref_idle_4');
  assert.strictEqual(restored[0].attachmentId, 'img_imgref_idle_4');
  assert.strictEqual(restored[0].referenceId, 'imgref_idle');
  assert.strictEqual(restored[0].reference_id, 'imgref_idle');
  assert.deepStrictEqual(restored[0].routeIdAliases, ['durable-store-id'],
    'the recovered durable identity must survive as an alias, not compete with the contract identity');
  assert.strictEqual(restored[0].routeSource, 'history');
  assert.strictEqual(restored[0].routeResourceKey, 'r1');
  assert.strictEqual(restored[0].routeRole, 'target');
  assert.strictEqual(restored[0].sourceIndex, 8);
  assert.strictEqual(restored[0].media_index, 8);

  const execution = submitHelpers.projectRouteExecutionMedia(
    route,
    submitHelpers.buildExecutionResourcePools({ history: restored }, { isImageFile }),
  );
  assert.deepStrictEqual(execution.targets.map(item => [item.routeResourceKey, item.routeId, item.routeSource]), [
    ['r1', 'img_imgref_idle_4', 'history'],
  ], 'the recovered historical image must project to exactly r1');
}

async function testRestoreBoundImagePoolBridgesValidatedAliasesForIdLessHistoricalResources() {
  // A historical edit resource restored by reference_id + index may carry no
  // durable id of its own. The original attachment identity alias must be
  // bridged onto the recovered attachment, otherwise projection throws
  // "Resource r1 is not uniquely available for execution".
  const route = editRoute([{
    key: 'r1', type: 'image', source: 'history', role: 'target', index: 1,
    id: '', resource_id: '', reference_id: 'uploaded_2',
    identity_aliases: ['upload-att-1'], index_aliases: [], missing: false,
  }]);
  const calls = [];
  const restored = await submitHelpers.restoreBoundImagePool(route, {
    source: 'history',
    sessionId: 'session-a',
    getPreviousImageAttachments: async (...args) => {
      calls.push(args);
      return [{
        type: 'image/png', name: 'upload.png', imageId: 'img_uploaded_2_1',
        referenceId: 'uploaded_2', sourceIndex: 1, fromPrevious: true,
      }];
    },
  });

  assert.deepStrictEqual(calls, [['session-a', [1], 'uploaded_2', []]],
    'id-less resources must be restored by their exact index and reference');
  assert.deepStrictEqual(restored[0].routeIdAliases, ['img_uploaded_2_1', 'upload-att-1'],
    'the validated route alias must bridge the recovered runtime representation');

  const media = submitHelpers.projectRouteExecutionMedia(
    route,
    submitHelpers.buildExecutionResourcePools({ history: restored }, { isImageFile }),
  );
  assert.strictEqual(media.targets.length, 1);
  assert.strictEqual(media.targets[0].routeResourceKey, 'r1');
  assert.strictEqual(media.targets[0].imageId, 'img_uploaded_2_1');
  assert.strictEqual(media.targets[0].routeId, 'img_uploaded_2_1');
}

async function testRestoreBoundImagePoolRestoresEachResourceByItsExactContractId() {
  const route = editRoute([
    {
      key: 'r1', type: 'image', source: 'history', role: 'target', index: 1,
      id: 'img_imgref_cats_1', reference_id: 'imgref_cats',
      identity_aliases: [], index_aliases: [], missing: false,
    },
    {
      key: 'r2', type: 'image', source: 'history', role: 'reference', index: 2,
      id: 'img_imgref_cats_2', reference_id: 'imgref_cats',
      identity_aliases: [], index_aliases: [], missing: false,
    },
  ]);
  const calls = [];
  const restored = await submitHelpers.restoreBoundImagePool(route, {
    source: 'history',
    sessionId: 'session-cats',
    getPreviousImageAttachments: async (...args) => {
      calls.push(args);
      const id = args[3]?.[0] || '';
      return [{
        type: 'image/png', imageId: id || `img_imgref_cats_${args[1][0]}`,
        referenceId: 'imgref_cats', sourceIndex: args[1]?.[0] || 1,
      }];
    },
  });

  assert.deepStrictEqual(calls, [
    ['session-cats', null, '', ['img_imgref_cats_1']],
    ['session-cats', null, '', ['img_imgref_cats_2']],
  ], 'every resource must be restored individually by its exact contract identity');
  assert.deepStrictEqual(restored.map(item => item.routeResourceKey), ['r1', 'r2']);

  const media = submitHelpers.projectRouteExecutionMedia(
    route,
    submitHelpers.buildExecutionResourcePools({ history: restored }, { isImageFile }),
  );
  assert.deepStrictEqual(media.targets.map(item => item.routeResourceKey), ['r1']);
  assert.deepStrictEqual(media.references.map(item => item.routeResourceKey), ['r2']);
}


async function testRestoreBoundImagePoolDecodesCanonicalResourceIdForSelectedHistoricalImage() {
  const route = editRoute([{
    key: 'r1', type: 'image', source: 'history', role: 'target', index: 2,
    id: '', resource_id: 'res:image:img_imgref_cats_2', reference_id: 'imgref_cats',
    identity_aliases: [], index_aliases: [], missing: false,
  }]);
  const calls = [];
  const restored = await submitHelpers.restoreBoundImagePool(route, {
    source: 'history',
    sessionId: 'session-cats',
    getPreviousImageAttachments: async (...args) => {
      calls.push(args);
      return [{
        type: 'image/png', imageId: 'img_imgref_cats_2',
        referenceId: 'imgref_cats', sourceIndex: 2,
      }];
    },
  });

  assert.deepStrictEqual(calls, [
    ['session-cats', null, '', ['img_imgref_cats_2']],
  ], 'canonical resource ids must be converted to the historical image item id before restoration');
  const media = submitHelpers.projectRouteExecutionMedia(
    route,
    submitHelpers.buildExecutionResourcePools({ history: restored }, { isImageFile }),
  );
  assert.strictEqual(media.targets.length, 1);
  assert.strictEqual(media.targets[0].routeResourceKey, 'r1');
  assert.strictEqual(media.targets[0].imageId, 'img_imgref_cats_2');
}

async function testRestoreBoundImagePoolFailsBeforeAmbiguousProjection() {
  const route = editRoute([{
    key: 'r1', type: 'image', source: 'history', role: 'target', index: 8,
    id: 'img_imgref_idle_4', reference_id: 'imgref_idle',
    identity_aliases: [], index_aliases: [], missing: false,
  }]);
  await assert.rejects(
    () => submitHelpers.restoreBoundImagePool(route, {
      source: 'history',
      getPreviousImageAttachments: async () => [],
    }),
    error => error.code === 'EXECUTION_RESOURCE_UNRESOLVED'
      && error.resourceKey === 'r1'
      && error.resourceSource === 'history',
    'missing restoration must fail at the restoration boundary instead of reaching generic execution projection',
  );
  await assert.rejects(
    () => submitHelpers.restoreBoundImagePool(route, {
      source: 'history',
      getPreviousImageAttachments: async () => [{ type: 'image/png' }, { type: 'image/png' }],
    }),
    error => error.code === 'EXECUTION_RESOURCE_UNRESOLVED'
      && error.resourceKey === 'r1'
      && error.resourceSource === 'history',
    'ambiguous restoration must fail at the restoration boundary instead of reaching generic execution projection',
  );
}

module.exports = [
  testRestoreBoundImagePoolCanonicalizesEachRecoveredContractResource,
  testRestoreBoundImagePoolBridgesValidatedAliasesForIdLessHistoricalResources,
  testRestoreBoundImagePoolRestoresEachResourceByItsExactContractId,
  testRestoreBoundImagePoolDecodesCanonicalResourceIdForSelectedHistoricalImage,
  testRestoreBoundImagePoolFailsBeforeAmbiguousProjection,
];
