'use strict';

const assert = require('assert');
const { createRenderCache } = require('../../client/ui/render-cache');

function testRenderCacheCountsStoredMarkdownAndHtmlAgainstTheCharacterBudget() {
  const cache = createRenderCache({ namespace: 'memory-budget', maxEntries: 20, maxChars: 100_000 });
  const entries = [
    { raw: `a${'r'.repeat(19_999)}`, html: `A${'h'.repeat(29_999)}` },
    { raw: `b${'r'.repeat(19_999)}`, html: `B${'h'.repeat(29_999)}` },
    { raw: `c${'r'.repeat(19_999)}`, html: `C${'h'.repeat(29_999)}` },
  ];

  entries.forEach(entry => cache.put(entry.raw, entry.html));

  assert.deepStrictEqual(cache.stats(), {
    entries: 2,
    chars: 100_000,
    maxEntries: 20,
    maxChars: 100_000,
    hits: 0,
    misses: 0,
    namespace: 'memory-budget:fallback',
  });
  assert.strictEqual(cache.get(entries[0].raw), null, 'the oldest rendered payload must be evicted when its real character cost exceeds the budget');
  assert.strictEqual(cache.get(entries[1].raw), entries[1].html);
  assert.strictEqual(cache.get(entries[2].raw), entries[2].html);
}

module.exports = [
  testRenderCacheCountsStoredMarkdownAndHtmlAgainstTheCharacterBudget,
];
