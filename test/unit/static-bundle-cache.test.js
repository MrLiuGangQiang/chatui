'use strict';

// Bundle cache policy regression: /assets/chatui.bundle.* URLs are content
// addressed (?v=<sha1 etag>, rewritten into index.html on every request) but
// were historically served with no-store, forcing every page load to
// re-download and re-parse ~2.5MB of JS plus ~500KB of CSS. Content-matched
// revisions are now immutable for one year; bare URLs and mismatched
// revisions keep no-store so shared caches can never pin stale content.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const staticHttp = require('../../server/http/static');
const staticBundle = require('../../server/services/static-bundle.service');

function makeFixture(marker) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `chatui-static-bundle-cache-${marker}-`));
  fs.mkdirSync(path.join(root, 'client'), { recursive: true });
  fs.mkdirSync(path.join(root, 'styles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'a.js'), `window.__a = ${marker};\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'styles', 'main.css'), `/* ${marker} */ body { margin: 0; }\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'index.html'), [
    '<!doctype html>',
    '<template id="chatuiAssetManifest">',
    '  <link rel="stylesheet" href="./styles/main.css">',
    '  <script src="./client/a.js"></script>',
    '</template>',
    '<link rel="stylesheet" href="./assets/chatui.bundle.css">',
    '<script src="./assets/chatui.bundle.js"></script>',
  ].join('\n'), 'utf8');
  return { root, rootWithSep: `${root}${path.sep}` };
}

function mockRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = String(body || ''); },
  };
}

function requestBundle(fixture, url) {
  const response = mockRes();
  staticHttp.serveStatic({ headers: {}, method: 'GET', url }, response, { root: fixture.root, rootWithSep: fixture.rootWithSep });
  return response;
}

function testContentMatchedBundleRevisionIsImmutable() {
  const fixture = makeFixture('v1');
  try {
    for (const [kind, asset] of [['js', 'chatui.bundle.js'], ['css', 'chatui.bundle.css']]) {
      const revision = staticBundle.bundleRevision(fixture.root, fixture.rootWithSep, kind);
      const response = requestBundle(fixture, `/assets/${asset}?v=${revision}`);
      assert.strictEqual(response.status, 200);
      assert.match(response.headers['Cache-Control'], /max-age=31536000/, `${asset} with its own content revision must be cacheable`);
      assert.match(response.headers['Cache-Control'], /immutable/, `${asset} content is pinned by the ?v= hash and must be immutable`);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testBundleUrlWithoutRevisionKeepsNoStore() {
  const fixture = makeFixture('v2');
  try {
    const response = requestBundle(fixture, '/assets/chatui.bundle.js');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers['Cache-Control'], staticHttp.NO_STORE, 'revision-less bundle URLs must revalidate on every request');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testBundleUrlWithForeignRevisionKeepsNoStore() {
  // A ?v= revision minted by a different deployment (different root, different
  // content) must never be treated as immutable for this deployment.
  const current = makeFixture('v3a');
  const foreign = makeFixture('v3b');
  try {
    const foreignRevision = staticBundle.bundleRevision(foreign.root, foreign.rootWithSep, 'js');
    assert.notStrictEqual(foreignRevision, staticBundle.bundleRevision(current.root, current.rootWithSep, 'js'));
    const response = requestBundle(current, `/assets/chatui.bundle.js?v=${foreignRevision}`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers['Cache-Control'], staticHttp.NO_STORE, 'a mismatched ?v= revision must never be marked immutable');
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
    fs.rmSync(foreign.root, { recursive: true, force: true });
  }
}

function testIndexEntryStillNoStoreAndReferencesContentRevision() {
  const fixture = makeFixture('v4');
  try {
    const response = mockRes();
    staticHttp.serveStatic({ headers: {}, method: 'GET', url: '/' }, response, { root: fixture.root, rootWithSep: fixture.rootWithSep });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers['Cache-Control'], staticHttp.NO_STORE, 'index.html must remain no-store so fresh content hashes are handed out');
    const jsRevision = staticBundle.bundleRevision(fixture.root, fixture.rootWithSep, 'js');
    assert.ok(response.body.includes(`chatui.bundle.js?v=${jsRevision}`), 'index must hand out the current content revision');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

module.exports = [
  testContentMatchedBundleRevisionIsImmutable,
  testBundleUrlWithoutRevisionKeepsNoStore,
  testBundleUrlWithForeignRevisionKeepsNoStore,
  testIndexEntryStillNoStoreAndReferencesContentRevision,
];
