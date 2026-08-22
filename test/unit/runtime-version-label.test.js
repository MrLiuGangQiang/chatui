'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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


async function testRuntimeIdentityMismatchNavigatesToBuildAddressedEntryBeforeStartup() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/runtime.js'), 'utf8');
  const navigations = [];
  const windowRef = {
    location: { replace: value => navigations.push(value) },
    ChatUIApp: {},
    ChatUIRuntimeService: {
      requestRuntimeIdentity: async () => ({
        version: '1.10.68', gitSha: 'new-sha', sourceRevision: 'sha256:new-build',
      }),
    },
  };
  const context = {
    window: windowRef,
    document: { querySelectorAll: () => [], getElementById: () => null },
    setTimeout,
    console,
  };
  vm.runInNewContext(source, context, { filename: 'client/app/runtime.js' });
  const result = await windowRef.ChatUIApp.runtime.ensureCurrentRuntimeBuild({
    entryIdentity: { version: '1.10.67', sourceRevision: 'sha256:old-build' },
    locationRef: windowRef.location,
    runtimeService: windowRef.ChatUIRuntimeService,
    fetchImpl: async () => { throw new Error('runtime service should own identity request'); },
  });
  assert.strictEqual(result.reloading, true);
  assert.deepStrictEqual(navigations, ['/__chatui/sha256%3Anew-build']);
}

module.exports = [testVisibleVersionExcludesBuildIdentity, testRuntimeIdentityMismatchNavigatesToBuildAddressedEntryBeforeStartup];
