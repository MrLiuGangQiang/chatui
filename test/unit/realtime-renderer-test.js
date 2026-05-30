#!/usr/bin/env node
const assert = require('assert');
const { createRealtimeRenderer } = require('../../client/ui/realtime-renderer');

const calls = [];
const renderer = createRealtimeRenderer(value => calls.push(value));
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
console.log('realtime renderer ok');
