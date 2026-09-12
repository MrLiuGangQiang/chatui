'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const { createIdleTimeoutController, createUpstreamFetch, readUpstreamText } = require('../../server/jobs/common');

async function withPrivateFetch(fetchImpl, run) {
  const previousFetch = global.fetch;
  const previousAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  global.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    global.fetch = previousFetch;
    if (previousAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = previousAllowPrivate;
  }
}

function createStreamingResponse(chunks, intervalMs) {
  const body = new Readable({ read() {} });
  let index = 0;
  const timer = setInterval(() => {
    if (index < chunks.length) {
      body.push(chunks[index]);
      index += 1;
      return;
    }
    clearInterval(timer);
    body.push(null);
  }, intervalMs);
  return {
    body,
    stop() {
      clearInterval(timer);
      body.destroy();
    },
    response: {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      body,
    },
  };
}

function testRapidChunksReuseOneIdleTimer() {
  let now = 0;
  let nextTimerId = 1;
  let scheduled = 0;
  let cleared = 0;
  let timeouts = 0;
  const timers = new Map();
  const controller = createIdleTimeoutController({
    timeoutMs: 100,
    now: () => now,
    setTimer(callback, delay) {
      const id = nextTimerId++;
      scheduled += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      cleared += 1;
      timers.delete(id);
    },
    onTimeout() {
      timeouts += 1;
    },
  });

  for (let index = 0; index < 1000; index += 1) {
    now += 1;
    controller.touch();
  }

  assert.strictEqual(scheduled, 1, 'fast response chunks must update a timestamp without recreating the timer');
  assert.strictEqual(cleared, 0, 'fast response chunks must not clear and rebuild the idle timer');
  assert.strictEqual(timeouts, 0);
  controller.stop();
  assert.strictEqual(cleared, 1, 'stopping the request must clear the single idle timer');
}

async function testChunkActivityExtendsUpstreamIdleDeadline() {
  const stream = createStreamingResponse(['one', 'two', 'three', 'four'], 40);
  let aborted = false;
  const result = await withPrivateFetch(async (_url, options = {}) => {
    options.signal?.addEventListener('abort', () => {
      aborted = true;
      stream.stop();
    }, { once: true });
    return stream.response;
  }, async () => {
    const upstreamRequest = createUpstreamFetch('http://127.0.0.1:65534/v1/chat/completions', {
      method: 'POST',
      upstreamTimeoutMs: 60,
    });
    const response = await upstreamRequest.response;
    try {
      return await readUpstreamText(response, upstreamRequest.touch);
    } finally {
      upstreamRequest.cleanup();
    }
  });

  assert.strictEqual(result, 'onetwothreefour');
  assert.strictEqual(aborted, false, 'continuous response chunks must keep resetting the idle timeout');
}

async function testSilentUpstreamStillTimesOut() {
  const body = new Readable({ read() {} });
  let aborted = false;
  const startedAt = Date.now();
  await withPrivateFetch(async (_url, options = {}) => {
    options.signal?.addEventListener('abort', () => {
      aborted = true;
      body.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      body,
    };
  }, async () => {
    const upstreamRequest = createUpstreamFetch('http://127.0.0.1:65534/v1/chat/completions', {
      method: 'POST',
      upstreamTimeoutMs: 50,
    });
    const response = await upstreamRequest.response;
    try {
      await assert.rejects(readUpstreamText(response, upstreamRequest.touch), error => error?.name === 'AbortError');
    } finally {
      upstreamRequest.cleanup();
      body.destroy();
    }
  });

  assert.strictEqual(aborted, true, 'an upstream that never returns data must still time out');
  assert.ok(Date.now() - startedAt < 1000, 'the idle timeout must not wait for a total request deadline');
}

module.exports = [
  testRapidChunksReuseOneIdleTimer,
  testChunkActivityExtendsUpstreamIdleDeadline,
  testSilentUpstreamStillTimesOut,
];
