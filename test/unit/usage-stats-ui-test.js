const assert = require('assert');
const { formatTokens, tokenPercent, cachePercent, reasoningPercent, formatPercent, shouldLoadRanking } = require('../../client/ui/usage-stats');

assert.strictEqual(formatTokens(999999), '999,999');
assert.strictEqual(formatTokens(1000000), '1M');
assert.strictEqual(formatTokens(100000000), '100M');
assert.strictEqual(formatTokens(999999999), '1000M');
assert.strictEqual(formatTokens(1000000000), '1B');
assert.strictEqual(formatTokens(1250000000), '1.25B');
assert.strictEqual(formatTokens(-100000000), '-100M');

assert.strictEqual(formatPercent(0), '0%');
assert.strictEqual(formatPercent(12.34), '12.3%');
assert.strictEqual(formatPercent(98.765), '98.8%');
assert.strictEqual(tokenPercent(250, 1000), 25);
assert.strictEqual(tokenPercent(250, 0), 0);
assert.strictEqual(tokenPercent(200, 100), 100);
assert.strictEqual(cachePercent({ prompt_tokens: 1000, prompt_cached_tokens: 250 }), 25);
assert.strictEqual(reasoningPercent({ completion_tokens: 1000, completion_reasoning_tokens: 125 }), 12.5);

assert.strictEqual(shouldLoadRanking(''), false);
assert.strictEqual(shouldLoadRanking('   '), false);
assert.strictEqual(shouldLoadRanking(null), false);
assert.strictEqual(shouldLoadRanking('sk-test'), true);

console.log('usage-stats-ui tests passed');
