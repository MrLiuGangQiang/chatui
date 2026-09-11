'use strict';

const assert = require('assert');

const persistence = require('../../client/app/persistence');
const sessionPersistence = require('../../client/app/session-persistence');

const PLACEHOLDER = '[attachment-data-omitted]';
const LARGE_BASE64 = 'A'.repeat(8 * 1024 * 1024);
const LARGE_DATA_URL = `data:image/png;base64,${LARGE_BASE64}`;

function testLargeInlineImageIsStrippedWithoutOverflowingTheRegexpStack() {
  const html = `<img src="${LARGE_DATA_URL}">`;
  assert.strictEqual(
    persistence.stripLargeDataUrlsFromText(html),
    `<img src="${PLACEHOLDER}">`,
  );
}

function testEveryLargeInlineImageInMessageHtmlIsStripped() {
  const html = `<img src="${LARGE_DATA_URL}"><img src="${LARGE_DATA_URL}">`;
  assert.strictEqual(
    persistence.stripLargeDataUrlsFromText(html),
    `<img src="${PLACEHOLDER}"><img src="${PLACEHOLDER}">`,
  );
}

function testStoredMessageWithLargeInlineImageIsSanitizedWithoutStackOverflow() {
  const cleaned = sessionPersistence.sanitizeStoredMessage({
    role: 'user',
    content: '看图',
    rawText: '看图',
    html: `<img src="${LARGE_DATA_URL}">`,
  }, {
    stripLargeDataUrlsFromText: persistence.stripLargeDataUrlsFromText,
  });
  assert.strictEqual(cleaned.html, '<img>');
}

function testSmallBase64DataUrlIsPreserved() {
  const small = `data:image/png;base64,${'A'.repeat(2047)}`;
  assert.strictEqual(persistence.stripLargeDataUrlsFromText(`<img src="${small}">`), `<img src="${small}">`);
}

module.exports = [
  testLargeInlineImageIsStrippedWithoutOverflowingTheRegexpStack,
  testEveryLargeInlineImageInMessageHtmlIsStripped,
  testStoredMessageWithLargeInlineImageIsSanitizedWithoutStackOverflow,
  testSmallBase64DataUrlIsPreserved,
];
