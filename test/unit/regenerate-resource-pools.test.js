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

module.exports = [
  testRegenerateResourcePoolsDoNotLeakUndeclaredCurrentAttachments,
  testRegenerateResourcePoolsKeepOnlyDeclaredSources,
];
