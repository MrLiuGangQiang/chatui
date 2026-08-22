const assert = require('assert');

const staticHttp = require('../../server/http/static');

function testRuntimeAssetsAlwaysRevalidateEvenWithVersionQueries() {
  const versionedUrl = new URL('http://chatui.local/client/app/scroll-focus-workflow.js?v=1.3.33');
  assert.strictEqual(
    staticHttp.cacheControlFor('/workspace/client/app/scroll-focus-workflow.js', versionedUrl),
    staticHttp.NO_STORE,
    'manually versioned workflow scripts must not be reused across deployments'
  );
  assert.strictEqual(
    staticHttp.cacheControlFor('/workspace/styles/flat-theme.css', new URL('http://chatui.local/styles/flat-theme.css?v=2.2.3')),
    staticHttp.NO_STORE,
    'manually versioned styles must not be reused across deployments'
  );
  assert.strictEqual(
    staticHttp.cacheControlFor('', null, { bundle: true }),
    staticHttp.NO_STORE,
    'runtime bundles must not be reusable across deployments until their URL includes a content hash'
  );
  assert.strictEqual(
    staticHttp.cacheControlFor('/workspace/favicon.svg', new URL('http://chatui.local/favicon.svg?v=1')),
    staticHttp.SHORT_CACHE,
    'non-executable assets can retain their short cache policy'
  );
}

module.exports = [
  testRuntimeAssetsAlwaysRevalidateEvenWithVersionQueries,
];
