'use strict';

const assert = require('assert');
const textHash = require('../../client/core/text-hash');
const renderCache = require('../../client/ui/render-cache');
const performanceWorkflowSource = require('fs').readFileSync(require('path').join(__dirname, '../../client/app/performance-workflow.js'), 'utf8');

function testTextHashPreservesContentAndShortKeyAlgorithms() {
  assert.strictEqual(textHash.contentHash(''), '0:ztntfp');
  assert.strictEqual(textHash.contentHash('hello'), `5:${textHash.fnv1aBase36('hello')}`);
  assert.strictEqual(textHash.fnv1aBase36('same'), textHash.fnv1aBase36('same'));
  assert.notStrictEqual(textHash.fnv1aBase36('same'), textHash.fnv1aBase36('different'));
}

function testRenderCacheUsesTheSharedContentHashImplementation() {
  assert.strictEqual(renderCache.fnv1a, textHash.contentHash);
  const cache = renderCache.createRenderCache({ namespace: 'unit' });
  assert.strictEqual(cache.keyFor('hello'), `unit:fallback:${textHash.contentHash('hello')}`);
}

function testPerformanceWorkflowDelegatesHashingWithoutChangingPublicName() {
  assert.ok(performanceWorkflowSource.includes('const chatuiContentHash = contentHash;'));
  assert.ok(!performanceWorkflowSource.includes('hash ^= text.charCodeAt'), 'FNV implementation should have one owner');
}

module.exports = [
  testTextHashPreservesContentAndShortKeyAlgorithms,
  testRenderCacheUsesTheSharedContentHashImplementation,
  testPerformanceWorkflowDelegatesHashingWithoutChangingPublicName,
];
