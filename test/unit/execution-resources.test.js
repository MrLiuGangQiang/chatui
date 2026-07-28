'use strict';

const assert = require('assert');
const executionResources = require('../../client/core/execution-resources');

function testExecutionMediaProjectionPreservesRolesAndSources() {
  const projection = executionResources.projectExecutionMedia({
    version: executionResources.PROJECTION_VERSION,
    operation: 'edit_image',
    images: [
      { key: 'r1', type: 'image', source: 'current', role: 'target', index: 1, id: 'target', reference_id: 'ref', missing: false },
      { key: 'r2', type: 'image', source: 'current', role: 'mask', index: 2, id: 'mask', reference_id: 'ref', missing: false },
    ],
    files: [],
  }, {
    imagePools: {
      current: [
        { id: 'target', referenceId: 'ref', type: 'image/png', media_index: 1 },
        { id: 'mask', referenceId: 'ref', type: 'image/png', media_index: 2 },
      ],
    },
  });

  assert.deepStrictEqual(projection.targets.map(item => item.routeResourceKey), ['r1']);
  assert.deepStrictEqual(projection.masks.map(item => item.routeResourceKey), ['r2']);
  assert.strictEqual(projection.imageInputs.length, 1);
  assert.strictEqual(projection.masks[0].routeRole, 'mask');
}

function testExecutionMediaProjectionFailsClosedForMissingOrAmbiguousBindings() {
  const base = {
    version: executionResources.PROJECTION_VERSION,
    operation: 'image_qa',
    images: [{ key: 'r1', type: 'image', source: 'history', role: 'source', index: 1, id: 'selected', reference_id: '', missing: false }],
    files: [],
  };
  assert.throws(
    () => executionResources.projectExecutionMedia(base, { imagePools: { history: [] } }),
    error => error.code === 'EXECUTION_RESOURCE_UNRESOLVED'
  );
  assert.throws(
    () => executionResources.projectExecutionMedia(base, { imagePools: { history: [{ id: 'selected' }, { id: 'selected' }] } }),
    error => error.code === 'EXECUTION_RESOURCE_UNRESOLVED'
  );
}

function testExecutionMediaProjectionAcceptsOnlyAValidatedIdentityAlias() {
  const projection = executionResources.projectExecutionMedia({
    version: executionResources.PROJECTION_VERSION,
    operation: 'edit_image',
    images: [{
      key: 'r1', type: 'image', source: 'current', role: 'target', index: 1,
      id: 'img_imgref_uploaded_2_1', reference_id: 'imgref_uploaded_2',
      identity_aliases: ['upload-att-1'], index_aliases: [],
    }],
    files: [],
  }, {
    imagePools: { current: [{ attachmentId: 'upload-att-1', type: 'image/png', routeSource: 'current' }] },
  });
  assert.strictEqual(projection.targets[0].routeId, 'img_imgref_uploaded_2_1');
  assert.throws(() => executionResources.projectExecutionMedia({
    version: executionResources.PROJECTION_VERSION,
    operation: 'edit_image',
    images: [{
      key: 'r1', type: 'image', source: 'current', role: 'target', index: 1,
      id: 'img_imgref_uploaded_2_1', reference_id: 'imgref_uploaded_2',
      identity_aliases: [], index_aliases: [],
    }],
    files: [],
  }, {
    imagePools: { current: [{ attachmentId: 'upload-att-1', type: 'image/png', routeSource: 'current' }] },
  }), error => error.code === 'EXECUTION_RESOURCE_UNRESOLVED');
}

module.exports = [
  testExecutionMediaProjectionPreservesRolesAndSources,
  testExecutionMediaProjectionFailsClosedForMissingOrAmbiguousBindings,
  testExecutionMediaProjectionAcceptsOnlyAValidatedIdentityAlias,
];
