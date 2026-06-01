#!/usr/bin/env node
const assert = require('assert');
const { createRealtimeRenderer } = require('../../client/ui/realtime-renderer');

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
console.log('realtime renderer ok');
