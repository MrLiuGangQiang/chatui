#!/usr/bin/env node
const assert = require('assert');
const { compactDisplayItems, makeDisplayItemId, displayItemHasRichMedia } = require('../../client/app/display-items');

assert.deepStrictEqual(compactDisplayItems([{ role: 'assistant', rawText: 'x' }, { role: 'assistant', rawText: 'x' }, { role: 'user', rawText: 'x' }]).map(i => i.role), ['assistant', 'user']);
assert.strictEqual(compactDisplayItems([{ role: 'assistant', rawText: 'x' }, { role: 'assistant', rawText: 'x', metaText: 'TTFT 1.5s' }])[0].metaText, 'TTFT 1.5s');
assert.ok(makeDisplayItemId(() => 123456, () => 0.123456).startsWith('display_'));
assert.strictEqual(displayItemHasRichMedia({ html: '<img class="generated-thumb" />' }), true);
assert.strictEqual(displayItemHasRichMedia({ html: '<p>x</p>' }), false);
console.log('display items ok');
