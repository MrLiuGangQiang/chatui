'use strict';

const assert = require('assert');
require('../../client/features/messages/quote-preview');

function testLegacyGlobalWithSentQuotePreviewIsExposed() {
  assert.strictEqual(typeof globalThis.withSentQuotePreview, 'function',
    'the legacy root bundle calls withSentQuotePreview as a bare global; the module must keep it available');
  assert.strictEqual(typeof globalThis.renderSentQuotePreview, 'function');
}

function testLegacyGlobalDoesNotThrowAndKeepsHtml() {
  const html = '<p>hi</p>';
  assert.strictEqual(typeof globalThis.withSentQuotePreview(html, ''), 'string');
  assert.ok(String(globalThis.withSentQuotePreview(html, '')).includes('hi'), 'the quoted body must survive the legacy preview wrapper');
}

module.exports = [
  testLegacyGlobalWithSentQuotePreviewIsExposed,
  testLegacyGlobalDoesNotThrowAndKeepsHtml,
];
