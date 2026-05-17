#!/usr/bin/env node
const assert = require('assert');
const { createRealtimeRenderer } = require('../../client/ui/realtime-renderer');

const queue = [];
const calls = [];
const renderer = createRealtimeRenderer(value => calls.push(value), cb => { queue.push(cb); return queue.length - 1; }, id => { queue[id] = null; });
renderer.set('a');
renderer.set('b');
assert.deepStrictEqual(calls, []);
queue.shift()();
assert.deepStrictEqual(calls, ['b']);
renderer.set('c');
renderer.flush('d');
assert.deepStrictEqual(calls, ['b', 'd']);
renderer.set('e');
renderer.cancel();
queue.forEach(cb => cb && cb());
assert.deepStrictEqual(calls, ['b', 'd']);
console.log('realtime renderer ok');
