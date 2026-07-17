const assert = require('assert');

const { createChatJobHandlers } = require('../../server/jobs/chat');
const parser = require('../../server/jobs/chat-stream-parser');

function createHandlers() {
  const notifications = [];
  const handlers = createChatJobHandlers({
    chatJobs: new Map(),
    notifyJob(job) { notifications.push({ content: job.streamDelta?.content || '', reasoning: job.streamDelta?.reasoning || '', status: job.status }); },
    upstreamTimeoutMs: 1000,
  });
  return { handlers, notifications };
}

function makeJob(handlers) {
  return handlers.makeChatJob('chatjob-stream123', 'https://api.example.com/v1', 'sk-test', { model: 'm', messages: [] }, { stream: true });
}

function sse(data) {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function testChatStreamParserHelpersArePure() {
  assert.strictEqual(parser.dataTextFromSseEvent('event: update\ndata: {"a":1}\n\n'), '{"a":1}');
  assert.strictEqual(parser.dataTextFromSseEvent('data: a\ndata: b'), 'a\nb');
  assert.deepStrictEqual(parser.extractStreamDelta({ choices: [{ delta: { content: 'A', reasoning_content: 'B' } }] }), { content: 'A', reasoning: 'B' });
  assert.deepStrictEqual(parser.extractStreamDelta({ output_text: 'A', reasoning_content: 'B' }), { content: 'A', reasoning: 'B' });
  assert.deepStrictEqual(
    parser.extractStreamDelta({ output_text: 'A', thinking: 'legacy', thinking_content: 'legacy', reasoning_details: 'legacy' }),
    { content: 'A', reasoning: '' },
    'legacy provider-specific thinking fields must not be interpreted as OpenAI reasoning output'
  );
}

function testChatStreamChunkParserBuffersPartialEvents() {
  const { handlers, notifications } = createHandlers();
  const job = makeJob(handlers);
  const firstHalf = 'data: {"choices":[{"delta":{"content":"你';
  assert.strictEqual(handlers.updateChatJobFromStreamChunk(job, firstHalf, { notify: false }), false);
  assert.strictEqual(job.data.choices[0].message.content, '');
  assert.strictEqual(job.buffer, firstHalf);

  const secondHalf = '好"}}]}\n\n';
  assert.strictEqual(handlers.updateChatJobFromStreamChunk(job, secondHalf, { notify: false }), true);
  assert.strictEqual(job.data.choices[0].message.content, '你好');
  assert.strictEqual(job.buffer, '');
  assert.deepStrictEqual(job.streamDelta, { content: '你好', reasoning: '' });
  assert.strictEqual(job.streamSeq, 1);
  assert.strictEqual(notifications.length, 0);
}

function testChatStreamChunkParserHandlesMultipleEventsAndDone() {
  const { handlers } = createHandlers();
  const job = makeJob(handlers);
  const chunk = [
    sse({ choices: [{ delta: { reasoning_content: '推理1' } }] }),
    sse({ choices: [{ delta: { content: '答案1' } }] }),
    sse('[DONE]'),
    sse({ choices: [{ message: { content: '答案2', reasoning: '推理2' } }] }),
  ].join('');

  assert.strictEqual(handlers.updateChatJobFromStreamChunk(job, chunk, { notify: false }), true);
  assert.strictEqual(job.data.choices[0].message.content, '答案1答案2');
  assert.strictEqual(job.data.choices[0].message.reasoning_content, '推理1推理2');
  assert.deepStrictEqual(job.streamDelta, { content: '答案1答案2', reasoning: '推理1推理2' });
  assert.strictEqual(job.streamSeq, 1);
  assert.ok(Number.isFinite(job.firstTokenMs) && job.firstTokenMs >= 1);
}

function testChatStreamChunkParserSkipsInvalidJsonAndEmptyEvents() {
  const { handlers } = createHandlers();
  const job = makeJob(handlers);
  const chunk = [
    'event: ping\n\n',
    'data: {bad json}\n\n',
    sse({ output_text: 'fallback content', reasoning_content: 'fallback reasoning' }),
  ].join('');

  assert.strictEqual(handlers.updateChatJobFromStreamChunk(job, chunk, { notify: false }), true);
  assert.strictEqual(job.data.choices[0].message.content, 'fallback content');
  assert.strictEqual(job.data.choices[0].message.reasoning_content, 'fallback reasoning');
  assert.deepStrictEqual(job.streamDelta, { content: 'fallback content', reasoning: 'fallback reasoning' });
}

function testResponsesManagedStreamUsesResponsesParserAndEndpoint() {
  const { handlers } = createHandlers();
  const job = handlers.makeChatJob(
    'chatjob-responses123',
    'https://api.example.com/v1',
    'sk-test',
    { model: 'gpt-5-mini', input: [] },
    { stream: true, api: 'responses' }
  );
  assert.strictEqual(job.api, 'responses');
  assert.strictEqual(job.targetUrl, 'https://api.example.com/v1/responses');
  const extractResponsesStreamDelta = require('../../server/proxy/responses-stream').extractResponsesStreamDelta;
  const chunk = [
    sse({ type: 'response.reasoning_summary_text.delta', delta: 'reasoning' }),
    sse({ type: 'response.output_text.delta', delta: 'answer' }),
  ].join('');
  assert.strictEqual(handlers.updateChatJobFromStreamChunk(job, chunk, { notify: false, extractDelta: extractResponsesStreamDelta }), true);
  assert.strictEqual(job.data.choices[0].message.reasoning_content, 'reasoning');
  assert.strictEqual(job.data.choices[0].message.content, 'answer');
}

function testChatStreamChunkParserNotifiesPerEventWhenEnabled() {
  const { handlers, notifications } = createHandlers();
  const job = makeJob(handlers);
  const chunk = [
    sse({ choices: [{ delta: { content: 'A' } }] }),
    sse({ choices: [{ delta: { reasoning_content: 'B' } }] }),
  ].join('');

  assert.strictEqual(handlers.updateChatJobFromStreamChunk(job, chunk), true);
  assert.strictEqual(notifications.length, 2);
  assert.strictEqual(job.data.choices[0].message.content, 'A');
  assert.strictEqual(job.data.choices[0].message.reasoning_content, 'B');
  assert.deepStrictEqual(job.streamDelta, { content: 'A', reasoning: 'B' });
}

module.exports = [
  testChatStreamParserHelpersArePure,
  testChatStreamChunkParserBuffersPartialEvents,
  testChatStreamChunkParserHandlesMultipleEventsAndDone,
  testChatStreamChunkParserSkipsInvalidJsonAndEmptyEvents,
  testChatStreamChunkParserNotifiesPerEventWhenEnabled,
  testResponsesManagedStreamUsesResponsesParserAndEndpoint,
];
