#!/usr/bin/env node
const assert = require('assert');
const { normalizeReasoningText, normalizeContentText, extractStreamDelta, extractResponsesStreamDelta, reasoningBudgetTokens } = require('../../client/core/reasoning');

assert.strictEqual(normalizeReasoningText('abc'), 'abc');
assert.strictEqual(normalizeReasoningText([{ summary: 'a' }, { thinking: 'b' }]), 'a\nb');
assert.strictEqual(normalizeReasoningText({ reasoning_content: 'why' }), 'why');
assert.strictEqual(normalizeContentText([{ text: 'he' }, { content: 'llo' }]), 'hello');
assert.strictEqual(normalizeContentText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'from output' }] }] }), 'from output');
assert.strictEqual(normalizeContentText({ message: { content: [{ text: 'from nested message' }] } }), 'from nested message');
assert.strictEqual(normalizeContentText({ response: { text: 'from response' } }), 'from response');
assert.deepStrictEqual(extractStreamDelta({ choices: [{ delta: { content: 'hi', reasoning_content: 'think' } }] }), { content: 'hi', reasoning: 'think' });

assert.strictEqual(normalizeReasoningText([{ reasoning_content: 'r1' }, { thinking_content: 'r2' }, { delta: 'r3' }]), 'r1\nr2\nr3');
assert.deepStrictEqual(extractStreamDelta({ choices: [{ delta: { delta: 'thinking delta' } }] }), { content: '', reasoning: 'thinking delta' });
assert.deepStrictEqual(extractStreamDelta({ reasoning_delta: 'event reasoning' }), { content: '', reasoning: 'event reasoning' });
assert.deepStrictEqual(extractStreamDelta({ choices: [{ delta: { content: [{ type: 'text', text: 'hello' }] } }] }), { content: 'hello', reasoning: '' });
assert.deepStrictEqual(extractStreamDelta({ choices: [{ delta: { text: 'hello' } }] }), { content: 'hello', reasoning: '' });
assert.deepStrictEqual(extractStreamDelta({ output: [{ type: 'message', content: [{ text: 'hello' }] }] }), { content: 'hello', reasoning: '' });
assert.deepStrictEqual(extractStreamDelta({ output: [{ type: 'reasoning', summary: 'plan' }] }), { content: '', reasoning: 'plan' });
assert.deepStrictEqual(extractStreamDelta({ output: [{ type: 'reasoning', summary_text: 'summary text' }] }), { content: '', reasoning: 'summary text' });
assert.deepStrictEqual(extractResponsesStreamDelta({ type: 'response.output_text.delta', delta: 'hello' }), { content: 'hello', reasoning: '' });
assert.deepStrictEqual(extractResponsesStreamDelta({ type: 'response.reasoning_summary_text.delta', delta: 'plan' }), { content: '', reasoning: 'plan' });
assert.deepStrictEqual(extractResponsesStreamDelta({ type: 'response.reasoning_summary_text.delta', delta: 'plan', output_text_delta: 'wrong' }), { content: '', reasoning: 'plan' });
assert.deepStrictEqual(extractResponsesStreamDelta({ type: 'response.reasoning_summary.delta', delta: 'summary delta' }), { content: '', reasoning: 'summary delta' });
assert.deepStrictEqual(extractResponsesStreamDelta({ type: 'response.reasoning_summary.done', text: 'summary done' }), { content: '', reasoning: 'summary done' });
assert.strictEqual(reasoningBudgetTokens('xhigh'), 16384);
assert.strictEqual(reasoningBudgetTokens('unknown'), 4096);
console.log('reasoning ok');
