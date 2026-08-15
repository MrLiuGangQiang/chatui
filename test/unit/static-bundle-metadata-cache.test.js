'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const staticBundle = require('../../server/services/static-bundle.service');

function testUnchangedBundleMetadataReusesContentFingerprintsWithoutSyncRereads() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-bundle-fingerprint-cache-'));
  const rootWithSep = `${root}${path.sep}`;
  fs.mkdirSync(path.join(root, 'client'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client/app.js'), `window.ChatUIBundleCache = true;
`, 'utf8');
  fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html>
<template id="chatuiAssetManifest">
  <script src="./client/app.js?v=1"></script>
</template>`, 'utf8');

  const originalReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function countedReadFileSync(...args) {
    reads += 1;
    return originalReadFileSync.apply(this, args);
  };

  try {
    const first = staticBundle.bundleMetadata(root, rootWithSep, 'js');
    const coldReads = reads;
    reads = 0;
    const second = staticBundle.bundleMetadata(root, rootWithSep, 'js');

    assert.ok(coldReads >= 2, 'the cold metadata pass must read the manifest and bundled source');
    assert.strictEqual(reads, 0, 'unchanged metadata must reuse content fingerprints instead of synchronously rereading source files');
    assert.strictEqual(second.etag, first.etag);
    assert.deepStrictEqual(second.entries.map(entry => entry.contentHash), first.entries.map(entry => entry.contentHash));
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = [
  testUnchangedBundleMetadataReusesContentFingerprintsWithoutSyncRereads,
];
