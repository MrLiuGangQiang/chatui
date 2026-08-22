'use strict';

// Static index/bundle render cache regression: every index.html request used
// to re-read index.html synchronously and re-stat every manifest asset twice
// (once per bundle kind), and every bundle request ran the same full scan
// again. The rendered page is now cached by (index content hash, css/js
// revisions) and bundle metadata carries a short TTL, so a repeat index
// request pays at most one stat (the index fingerprint itself).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const staticHttp = require('../../server/http/static');
const staticBundle = require('../../server/services/static-bundle.service');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-static-index-cache-'));
  fs.mkdirSync(path.join(root, 'client'), { recursive: true });
  fs.mkdirSync(path.join(root, 'styles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'a.js'), 'window.__a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'styles', 'main.css'), 'body { margin: 0; }\n', 'utf8');
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

function testRepeatServeIndexSkipsAssetRescan() {
  const { root, rootWithSep } = makeFixture();
  const context = { root, rootWithSep };
  const originalStatSync = fs.statSync;
  let stats = 0;
  fs.statSync = function countedStatSync(...args) {
    stats += 1;
    return originalStatSync.apply(this, args);
  };
  try {
    const firstRes = mockRes();
    staticHttp.serveIndex({ headers: {}, method: 'GET', url: '/' }, firstRes, context);
    assert.strictEqual(firstRes.status, 200);
    const coldStats = stats;
    assert.ok(coldStats >= 4, `cold render must inspect the manifest assets, got ${coldStats}`);

    stats = 0;
    const secondRes = mockRes();
    staticHttp.serveIndex({ headers: {}, method: 'GET', url: '/' }, secondRes, context);
    assert.strictEqual(secondRes.status, 200);
    assert.ok(stats <= 1, `warm render must not re-stat every manifest asset, got ${stats} statSync calls`);
    assert.strictEqual(secondRes.body, firstRes.body);
    assert.strictEqual(secondRes.headers.ETag, firstRes.headers.ETag);

    // A matching If-None-Match still revalidates to a 304 without rescanning.
    stats = 0;
    const revalidatedRes = mockRes();
    staticHttp.serveIndex({ headers: { 'if-none-match': firstRes.headers.ETag }, method: 'GET', url: '/' }, revalidatedRes, context);
    assert.strictEqual(revalidatedRes.status, 304);
    assert.ok(stats <= 1, `revalidation must not re-stat every manifest asset, got ${stats} statSync calls`);
  } finally {
    fs.statSync = originalStatSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testBundleMetadataCacheHonoursTtl() {
  const { root, rootWithSep } = makeFixture();
  try {
    const options = { ttlMs: 500 };
    const first = staticBundle.bundleMetadataCached(root, rootWithSep, 'js', { ...options, now: 10_000 });

    // Change the bundled source; within the TTL the cached metadata is served.
    fs.writeFileSync(path.join(root, 'client', 'a.js'), 'window.__a = 2; // changed content\n', 'utf8');
    const withinTtl = staticBundle.bundleMetadataCached(root, rootWithSep, 'js', { ...options, now: 10_400 });
    assert.strictEqual(withinTtl.etag, first.etag, 'metadata within the TTL window must be reused');

    const afterTtl = staticBundle.bundleMetadataCached(root, rootWithSep, 'js', { ...options, now: 10_600 });
    assert.notStrictEqual(afterTtl.etag, first.etag, 'metadata must be recomputed once the TTL expires');

    // ttlMs 0 disables caching entirely.
    fs.writeFileSync(path.join(root, 'client', 'a.js'), 'window.__a = 3; // changed content again!\n', 'utf8');
    const uncached = staticBundle.bundleMetadataCached(root, rootWithSep, 'js', { ttlMs: 0, now: 10_700 });
    assert.notStrictEqual(uncached.etag, afterTtl.etag, 'ttlMs 0 must always recompute');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = [
  testRepeatServeIndexSkipsAssetRescan,
  testBundleMetadataCacheHonoursTtl,
];