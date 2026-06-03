const assert = require('assert');
const { createRenderCache } = require('../../client/ui/render-cache');

let calls = 0;
const cache = createRenderCache({ maxEntries: 20, maxChars: 10000 });
const render = value => { calls += 1; return `<p>${value}</p>`; };
assert.strictEqual(cache.render('same', render), '<p>same</p>');
assert.strictEqual(cache.render('same', render), '<p>same</p>');
assert.strictEqual(calls, 1, 'same raw content should render once');
for (let i = 0; i < 30; i += 1) cache.render(`item-${i}`, render);
assert.ok(cache.stats().entries <= 20, 'LRU max entries should be enforced');
console.log('render-cache-test passed');
