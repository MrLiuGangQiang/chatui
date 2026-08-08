'use strict';

const assert = require('assert');
const jobService = require('../../client/services/job-service');

function sseBody(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function waitJob({ chunks, onUpdate }) {
  const updates = [];
  const promise = jobService.waitJobEvent({
    url: '/api/chat-jobs/test/events',
    onUpdate: event => { updates.push(event); onUpdate?.(event); },
    fetchImpl: async () => ({ ok: true, body: sseBody(chunks) }),
    signal: new AbortController().signal,
  });
  return { promise, updates };
}

async function testCompactErrorEventRejectsWithTerminalJobError() {
  const { promise } = waitJob({ chunks: ['event: update\ndata: {"e":"\u4e0a\u6e38 400: unknown variant `image_url`"}\n\n'] });
  await assert.rejects(promise, error => error.terminalJob === true && /unknown variant `image_url`/.test(error.message),
    'compact {e} payloads must reject the chat job wait with the upstream error');
}

async function testCompactDoneEventResolvesWithAggregatedContent() {
  const { promise, updates } = waitJob({
    chunks: [
      'event: update\ndata: {"d":"\u4f60"}\n\n',
      'event: update\ndata: {"done":1}\n\n',
    ],
  });
  const result = await promise;
  assert.strictEqual(result.choices[0].message.content, '\u4f60');
  assert.strictEqual(updates.at(-1).status, 'done');
}

async function testFullStatusPayloadStillRejects() {
  const { promise } = waitJob({ chunks: ['event: update\ndata: {"status":"error","error":{"message":"\u4efb\u52a1\u4e0d\u5b58\u5728"}}\n\n'] });
  await assert.rejects(promise, error => error.terminalJob === true && error.message === '\u4efb\u52a1\u4e0d\u5b58\u5728');
}

async function testCompactRunningDeltasDoNotSettleEarly() {
  let settled = false;
  const controller = new AbortController();
  const updates = [];
  const promise = jobService.waitJobEvent({
    url: '/api/chat-jobs/test/events',
    onUpdate: event => { updates.push(event); },
    fetchImpl: async () => ({ ok: true, body: sseBody(['event: update\ndata: {"d":"a"}\n\n', 'event: update\ndata: {"d":"b","ft":12}\n\n']) }),
    signal: controller.signal,
  });
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.strictEqual(settled, false, 'running deltas must not settle the wait');
  assert.strictEqual(updates.at(-1).status, 'running');
  controller.abort();
  await promise.catch(() => {});
}

module.exports = [
  testCompactErrorEventRejectsWithTerminalJobError,
  testCompactDoneEventResolvesWithAggregatedContent,
  testFullStatusPayloadStillRejects,
  testCompactRunningDeltasDoNotSettleEarly,
];
