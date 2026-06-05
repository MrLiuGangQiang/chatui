#!/usr/bin/env node
const assert = require('assert');
const { JSDOM } = require('jsdom');
const p = require('../../client/app/session-persistence');

const sorted = p.sortCanonicalMessages([{ role: 'assistant', content: 'a', responseIndex: '1' }, { role: 'user', content: 'u', messageIndex: '0' }]);
assert.deepStrictEqual(sorted.map(item => item.role), ['user', 'assistant']);
assert.strictEqual(p.messageSortIndex({ role: 'user', messageIndex: '2' }, 9), 2);
assert.strictEqual(p.roleSortWeight('assistant'), 2);
assert.deepStrictEqual(p.normalizeMessageOrderFields([{ role: 'user', content: 'x' }])[0].messageIndex, '0');
const compacted = p.compactAdjacentDuplicateMessages([{ role: 'user', content: 'x' }, { role: 'user', content: 'x', metaText: 'm' }], item => item);
assert.strictEqual(compacted.length, 1);
assert.strictEqual(compacted[0].metaText, 'm');
assert.strictEqual(p.compactDisplayItems([{ role: 'assistant', rawText: 'x' }, { role: 'assistant', rawText: 'x', reasoningText: 'r' }]).length, 1);

const dom = new JSDOM('<div></div>');
const html = '<p>x</p><button data-download-image="1">d</button><img src="blob:x" data-object-url="blob:y">';
assert.ok(!p.stripTransientBlobUrlsFromHtml(html, dom.window.document).includes('blob:'));
assert.ok(!p.stripGeneratedImageActionMarkup(html, dom.window.document).includes('data-download-image'));
const ctx = p.sanitizeAttachmentContextForStorage({ attachments: [{ name: 'a', src: 'data:x', text: 't' }] });
assert.strictEqual(JSON.parse(ctx).attachments[0].src, '');
const display = p.sanitizeStoredDisplayItem({ rawText: 'data:x;base64,' + 'A'.repeat(3000), html, imageContext: ctx }, { stripLargeDataUrlsFromText: text => String(text).replace(/data:[^\s]+/g, '[omitted]'), document: dom.window.document });
assert.ok(!display.html.includes('blob:'));
const message = p.sanitizeStoredMessage({ content: 'data:x', rawText: 'data:x', html }, { stripLargeDataUrlsFromText: text => String(text).replace(/data:x/g, '[omitted]'), document: dom.window.document });
assert.strictEqual(message.content, '[omitted]');

const storage = new Map();
const storageApi = { setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
p.safeSetJsonStorage('k', [{ a: 1 }], 10, storageApi);
assert.strictEqual(JSON.parse(storage.get('k'))[0].a, 1);
assert.strictEqual(p.stripLargePayloadData({ messages: new Array(25).fill({ c: 'x' }) }).messages.length, 20);
const job = p.compactJobForStorage({ id: 'j', payload: { text: 'data:x' } }, true, text => text.replace('data:x', '[omitted]'));
assert.strictEqual(job.payload.text, '[omitted]');
p.safeSetJobStorage('job', { id: 'j', payload: { text: 'x' } }, { storage: storageApi });
assert.strictEqual(JSON.parse(storage.get('job')).id, 'j');

console.log('app session persistence ok');
