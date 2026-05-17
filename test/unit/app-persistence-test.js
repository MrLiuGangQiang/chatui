#!/usr/bin/env node
const assert = require('assert');
const { stripLargeDataUrlsFromText, sanitizeAttachmentContextForStorage, sanitizeStoredDisplayItem, sanitizeStoredMessage, safeSetJsonStorage } = require('../../client/app/persistence');

assert.ok(stripLargeDataUrlsFromText(`x data:image/png;base64,${'A'.repeat(2100)} y`).includes('[attachment-data-omitted]'));
const ctx = sanitizeAttachmentContextForStorage({ attachments: [{ name: 'a', src: 'data:x;base64,abc' }, { name: 'b', src: 'indexeddb://b' }] });
assert.deepStrictEqual(JSON.parse(ctx).attachments.map(item => item.src), ['', 'indexeddb://b']);
assert.strictEqual(sanitizeStoredDisplayItem({ html: `data:x;base64,${'A'.repeat(2100)}` }).html, '[attachment-data-omitted]');
assert.strictEqual(sanitizeStoredMessage({ content: `data:x;base64,${'A'.repeat(2100)}` }).content, '[attachment-data-omitted]');
const map = new Map();
const storage = { setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
assert.deepStrictEqual(safeSetJsonStorage(storage, 'k', [1, 2, 3], 2), [2, 3]);
console.log('app persistence ok');
