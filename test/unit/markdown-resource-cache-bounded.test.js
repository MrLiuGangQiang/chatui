'use strict';

const assert = require('assert');
const streaming = require('../../client/app/markdown/browser-streaming-renderer');

function replaceGlobal(key, value) {
  const previous = global[key];
  global[key] = value;
  return () => {
    if (previous === undefined) delete global[key];
    else global[key] = previous;
  };
}

async function testMarkdownResourceCacheBoundsEntriesAndRevokesEvictedBlobs() {
  const restoreLocation = replaceGlobal('location', { href: 'http://localhost/', origin: 'http://localhost' });
  const previousCreateObjectUrl = globalThis.URL?.createObjectURL;
  const previousRevokeObjectUrl = globalThis.URL?.revokeObjectURL;
  let blobCounter = 0;
  const revoked = [];
  if (globalThis.URL) {
    globalThis.URL.createObjectURL = () => `blob:test-${++blobCounter}`;
    globalThis.URL.revokeObjectURL = value => revoked.push(value);
  }
  const restoreFetch = replaceGlobal('fetch', async () => ({ ok: true, blob: async () => ({}) }));
  try {
    streaming.clearMarkdownResourceCache();
    const urls = Array.from({ length: 205 }, (_, index) => `http://localhost/img-${index}.png`);
    await Promise.all(urls.map(url => streaming.fetchCachedResourceUrl(url)));

    const stats = streaming.markdownResourceCacheStats();
    assert.strictEqual(stats.max, 200);
    assert.strictEqual(stats.size, 200, 'the resource cache must stay bounded instead of growing with every unique URL');
    assert.strictEqual(revoked.length, 5, 'evicted blob object URLs must be revoked so their blobs can be collected');

    streaming.clearMarkdownResourceCache();
    assert.strictEqual(streaming.markdownResourceCacheStats().size, 0);
    assert.strictEqual(revoked.length, 205, 'clearing the cache must revoke every retained blob URL');
  } finally {
    restoreFetch();
    if (globalThis.URL) {
      globalThis.URL.createObjectURL = previousCreateObjectUrl;
      globalThis.URL.revokeObjectURL = previousRevokeObjectUrl;
    }
    restoreLocation();
  }
}

module.exports = [testMarkdownResourceCacheBoundsEntriesAndRevokesEvictedBlobs];
