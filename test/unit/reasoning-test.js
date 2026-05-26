#!/usr/bin/env node
const assert = require('assert');
const { normalizeReasoningText, normalizeContentText, extractStreamDelta, reasoningBudgetTokens } = require('../../client/core/reasoning');

assert.strictEqual(normalizeReasoningText('abc'), 'abc');
assert.strictEqual(normalizeReasoningText([{ summary: 'a' }, { thinking: 'b' }]), 'a\nb');
assert.strictEqual(normalizeReasoningText({ reasoning_content: 'why' }), 'why');
assert.strictEqual(normalizeContentText([{ text: 'he' }, { content: 'llo' }]), 'hello');
assert.strictEqual(normalizeContentText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'from output' }] }] }), 'from output');
assert.strictEqual(normalizeContentText({ message: { content: [{ text: 'from nested message' }] } }), 'from nested message');
assert.strictEqual(normalizeContentText({ response: { text: 'from response' } }), 'from response');
assert.deepStrictEqual(extractStreamDelta({ choices: [{ delta: { content: 'hi', reasoning_content: 'think' } }] }), { content: 'hi', reasoning: 'think' });
assert.deepStrictEqual(extractStreamDelta({ choices: [{ delta: { content: [{ type: 'text', text: 'hello' }] } }] }), { content: 'hello', reasoning: '' });
assert.deepStrictEqual(extractStreamDelta({ choices: [{ delta: { text: 'hello' } }] }), { content: 'hello', reasoning: '' });
assert.deepStrictEqual(extractStreamDelta({ output: [{ type: 'message', content: [{ text: 'hello' }] }] }), { content: 'hello', reasoning: '' });
assert.deepStrictEqual(extractStreamDelta({ output: [{ type: 'reasoning', summary: 'plan' }] }), { content: '', reasoning: 'plan' });
assert.strictEqual(reasoningBudgetTokens('xhigh'), 16384);
assert.strictEqual(reasoningBudgetTokens('unknown'), 4096);
console.log('reasoning ok');
