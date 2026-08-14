'use strict';

const assert = require('assert');
const {
  createResponsesCompactStreamNormalizer,
} = require('../../server/proxy/responses-stream');

function sse(data, event = '') {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}

function compactUpdates(text = '') {
  return String(text || '')
    .split(/\r?\n\r?\n/)
    .map(eventText => eventText
      .split(/\r?\n/)
      .find(line => line.startsWith('data:')))
    .filter(Boolean)
    .map(line => JSON.parse(line.slice(5).trim()));
}

function testResponsesCompactStreamAppendsUniqueWebSearchSourcesBeforeDone() {
  const normalizer = createResponsesCompactStreamNormalizer({
    startedAt: 100,
    now: () => 175,
  });
  const upstream = [
    sse({ type: 'response.output_text.delta', delta: '最新结果' }),
    sse({
      type: 'response.output_text.annotation.added',
      annotation: { type: 'url_citation', url: 'https://example.com/news', title: '新闻来源' },
    }),
    sse({
      type: 'response.output_text.annotation.added',
      annotation: { type: 'url_citation', url: 'https://example.com/news', title: '重复来源' },
    }),
    sse({ type: 'response.completed', response: {} }),
  ].join('');

  const splitAt = Math.floor(upstream.length / 2);
  const output = normalizer.push(upstream.slice(0, splitAt))
    + normalizer.push(upstream.slice(splitAt))
    + normalizer.end();
  const updates = compactUpdates(output);
  const content = updates.map(update => update.d || '').join('');

  assert.match(content, /^最新结果/);
  assert.match(content, /### 来源/);
  assert.match(content, /\[新闻来源\]\(https:\/\/example\.com\/news\)/);
  assert.strictEqual((content.match(/example\.com\/news/g) || []).length, 1);
  assert.strictEqual(updates.filter(update => update.done === 1).length, 1);
  assert.strictEqual(updates.at(-1).done, 1, 'source markdown must be emitted before the terminal update');
  assert.strictEqual(updates.at(-1).rt, 75);
}

module.exports = [
  testResponsesCompactStreamAppendsUniqueWebSearchSourcesBeforeDone,
];
