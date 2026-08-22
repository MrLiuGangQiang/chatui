'use strict';

const assert = require('assert');
const helpers = require('../../client/app/submit-workflow.helpers');

function testRegenerateResourcePoolsDoNotLeakUndeclaredCurrentAttachments() {
  const current = [{ type: 'image/png', id: 'current-image' }];
  const history = [{ type: 'image/png', id: 'history-image' }];
  const route = {
    executionResources: {
      version: 'execution_resources.v2',
      images: [],
      files: [],
    },
  };
  const restricted = helpers.restrictExecutionResourcePools(route, {
    current,
    quoted: [],
    history,
    context: [],
  });

  assert.deepStrictEqual(restricted, {
    current: [],
    quoted: [],
    history: [],
    context: [],
  });
}

function testRegenerateResourcePoolsKeepOnlyDeclaredSources() {
  const current = [{ type: 'image/png', id: 'current-image' }];
  const history = [{ type: 'image/png', id: 'history-image' }];
  const route = {
    executionResources: {
      version: 'execution_resources.v2',
      images: [{ source: 'history', type: 'image', role: 'reference' }],
      files: [],
    },
  };
  const restricted = helpers.restrictExecutionResourcePools(route, {
    current,
    quoted: [],
    history,
    context: [],
  });

  assert.deepStrictEqual(restricted.current, []);
  assert.strictEqual(restricted.history, history);
}

function testBatchRegeneratePoolsPreserveChildHistoryBindings() {
  const restoredImage = {
    type: 'image/png',
    id: 'history-image',
    persistedSrc: 'indexeddb://history-image',
  };
  const childRoute = {
    executionResources: {
      version: 'execution_resources.v2',
      operation: 'edit_image',
      api: 'image_edit',
      relation: 'continuation',
      images: [{
        key: 'r1',
        type: 'image',
        source: 'history',
        role: 'target',
        index: 1,
        id: 'history-image',
        resource_id: 'res:image:history-image',
        reference_id: '',
      }],
      files: [],
    },
  };
  const parentRoute = {
    imagePlanCompiled: {
      kind: 'batch',
      items: [{ route: childRoute }, { route: childRoute }],
    },
    // The planning envelope intentionally has no parent execution resources.
  };
  const sourcePools = {
    current: [],
    quoted: [],
    history: [restoredImage],
    context: [],
  };
  const pools = helpers.buildDispatchExecutionResourcePools(parentRoute, sourcePools, {
    isImageFile: item => String(item?.type || '').startsWith('image/'),
  });

  assert.doesNotThrow(
    () => helpers.projectRouteExecutionMedia(childRoute, pools),
    'a regenerate batch child must resolve its restored history target',
  );
  assert.strictEqual(
    helpers.projectRouteExecutionMedia(childRoute, pools).targets[0].id,
    'history-image',
  );
  assert.throws(
    () => helpers.projectRouteExecutionMedia(childRoute, helpers.buildExecutionResourcePools(
      helpers.restrictExecutionResourcePools(parentRoute, sourcePools),
      { isImageFile: item => String(item?.type || '').startsWith('image/') },
    )),
    error => error?.code === 'EXECUTION_RESOURCE_UNRESOLVED' && error.resourceKey === 'r1',
    'the old parent-level restriction reproduces the r1 unresolved failure',
  );
}

module.exports = [
  testRegenerateResourcePoolsDoNotLeakUndeclaredCurrentAttachments,
  testRegenerateResourcePoolsKeepOnlyDeclaredSources,
  testBatchRegeneratePoolsPreserveChildHistoryBindings,
];
