#!/usr/bin/env node
const assert = require('assert');
const { normalizeReasoningText, extractStreamDelta, reasoningBudgetTokens } = require('../../client/core/reasoning');

assert.strictEqual(normalizeReasoningText('abc'), 'abc');
assert.strictEqual(normalizeReasoningText([{ summary: 'a' }, { thinking: 'b' }]), 'a\nb');
assert.strictEqual(normalizeReasoningText({ reasoning_content: 'why' }), 'why');
assert.deepStrictEqual(extractStreamDelta({ choices: [{ delta: { content: 'hi', reasoning_content: 'think' } }] }), { content: 'hi', reasoning: 'think' });
assert.deepStrictEqual(extractStreamDelta({ output: [{ type: 'message', content: [{ text: 'hello' }] }] }), { content: 'hello', reasoning: '' });
assert.deepStrictEqual(extractStreamDelta({ output: [{ type: 'reasoning', summary: 'plan' }] }), { content: '', reasoning: 'plan' });
assert.strictEqual(reasoningBudgetTokens('xhigh'), 16384);
assert.strictEqual(reasoningBudgetTokens('unknown'), 4096);
console.log('reasoning ok');
