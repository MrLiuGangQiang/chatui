#!/usr/bin/env node
const assert = require('assert');
const {
  parseSseEvent,
  extractResponsesStreamDelta,
  createResponsesCompactStreamNormalizer,
} = require('../../server/proxy/responses-stream');
const { extractResponsesStreamDelta: clientExtractResponsesStreamDelta } = require('../../client/core/reasoning');

assert.deepStrictEqual(parseSseEvent('event: response.output_text.delta\ndata: {"delta":"hi"}\n'), {
  event: 'response.output_text.delta',
  data: '{"delta":"hi"}',
});

assert.deepStrictEqual(
  extractResponsesStreamDelta({ type: 'response.output_text.delta', delta: 'hello' }),
  { content: 'hello', reasoning: '', done: false },
);
assert.deepStrictEqual(
  extractResponsesStreamDelta({ type: 'response.reasoning_summary_text.delta', delta: 'plan' }),
  { content: '', reasoning: 'plan', done: false },
);
assert.deepStrictEqual(
  extractResponsesStreamDelta({ d: 'compact', r: 'reason' }),
  { content: 'compact', reasoning: 'reason', done: false },
);
assert.deepStrictEqual(
  clientExtractResponsesStreamDelta({ d: 'compact', r: 'reason' }),
  { content: 'compact', reasoning: 'reason' },
);

let now = 1000;
const normalizer = createResponsesCompactStreamNormalizer({ now: () => now });
let out = normalizer.push('event: response.output_text.delta\ndata: {"delta":"he"}\n\n');
assert.match(out, /^event: update\ndata: /);
let payload = JSON.parse(out.match(/^event: update\ndata: (.*)\n\n$/)[1]);
assert.deepStrictEqual(payload, { d: 'he', ft: 0 });

now = 1030;
out = normalizer.push('event: response.reasoning_summary_text.delta\ndata: {"delta":"think"}\n\n');
payload = JSON.parse(out.match(/^event: update\ndata: (.*)\n\n$/)[1]);
assert.deepStrictEqual(payload, { r: 'think' });

out = normalizer.push('event: response.output_text.delta\ndata: {"delta":"llo"}\n\n');
payload = JSON.parse(out.match(/^event: update\ndata: (.*)\n\n$/)[1]);
assert.deepStrictEqual(payload, { d: 'llo' });

out = normalizer.push('event: response.completed\ndata: {"type":"response.completed","response":{"output_text":"hello"}}\n\n');
payload = JSON.parse(out.match(/^event: update\ndata: (.*)\n\n$/)[1]);
assert.deepStrictEqual(payload, { done: 1 });

assert.strictEqual(normalizer.end(), '');

const split = createResponsesCompactStreamNormalizer({ now: () => 2000 });
out = split.push('event: response.output_text.delta\ndata: {"delta":"a"}');
assert.strictEqual(out, '');
out = split.push('\n\n');
payload = JSON.parse(out.match(/^event: update\ndata: (.*)\n\n$/)[1]);
assert.deepStrictEqual(payload, { d: 'a', ft: 0 });

console.log('responses compact stream ok');
