#!/usr/bin/env node
const assert = require('assert');
const { createRealtimeRenderer } = require('../../client/ui/realtime-renderer');

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  const calls = [];
  const renderer = createRealtimeRenderer(value => calls.push(value), { minIntervalMs: 0 });
  renderer.set('a');
  renderer.set('b');
  assert.deepStrictEqual(calls, ['a', 'b']);
  renderer.flush('c');
  assert.deepStrictEqual(calls, ['a', 'b', 'c']);
  renderer.set('d');
  renderer.cancel();
  renderer.set('e');
  renderer.flush('f');
  assert.deepStrictEqual(calls, ['a', 'b', 'c', 'd']);

  const throttledCalls = [];
  const throttled = createRealtimeRenderer(value => throttledCalls.push(value), { minIntervalMs: 50 });
  throttled.set('x');
  throttled.set('xy');
  assert.deepStrictEqual(throttledCalls, ['x']);
  throttled.flush('xyz');
  assert.deepStrictEqual(throttledCalls, ['x', 'xyz']);

  const backlogCalls = [];
  const backlog = createRealtimeRenderer(value => backlogCalls.push(value), { minIntervalMs: 1000 });
  backlog.set('a');
  for (const chunk of ['ab', 'abc', 'abcd', 'abcde', 'abcdef']) backlog.set(chunk);
  assert.deepStrictEqual(backlogCalls, ['a'], 'streaming throttle should coalesce fast chunks instead of rendering each char');
  assert.strictEqual(backlog.hasTimer(), true, 'throttled stream should have one pending timer before final');
  backlog.final('abcdef');
  assert.deepStrictEqual(backlogCalls, ['a', 'abcdef'], 'done/final must immediately flush the full pending buffer');
  assert.strictEqual(backlog.hasTimer(), false, 'final must cancel pending timers');
  backlog.set('abcdefg');
  backlog.flush('abcdefgh');
  await sleep(30);
  assert.deepStrictEqual(backlogCalls, ['a', 'abcdef'], 'final must ignore stale queued appends after completion');

  const noCharCalls = [];
  const noChar = createRealtimeRenderer(value => noCharCalls.push(value), { minIntervalMs: 1000 });
  noChar.set('一');
  ['一个', '一个字', '一个字一', '一个字一个', '一个字一个输', '一个字一个输出'].forEach(value => noChar.set(value));
  noChar.final('一个字一个输出');
  assert.deepStrictEqual(noCharCalls, ['一', '一个字一个输出'], 'backlog must not replay every character on final');

  console.log('realtime renderer ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
