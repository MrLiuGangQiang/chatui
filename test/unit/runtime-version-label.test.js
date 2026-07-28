'use strict';

const assert = require('assert');
const runtimeService = require('../../client/services/runtime-service');

async function testVisibleVersionExcludesBuildIdentity() {
  const version = await runtimeService.requestAppVersion({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        version: '1.9.3',
        gitSha: '9c4d2a34ab17a9aee2f2c1abd627a4ff66239456',
        sourceRevision: 'sha256:example',
        dirty: false,
        mode: 'image'
      })
    })
  });

  assert.strictEqual(version, '1.9.3');
}

module.exports = [testVisibleVersionExcludesBuildIdentity];
