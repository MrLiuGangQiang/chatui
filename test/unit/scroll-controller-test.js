#!/usr/bin/env node
const assert = require('assert');
const { composerSafeBottom, activeOutputBottomTarget, isNodeAwayFromOutputFocus } = require('../../client/ui/scroll-controller');

assert.strictEqual(composerSafeBottom('120px'), 120);
assert.strictEqual(composerSafeBottom('bad'), 168);
assert.strictEqual(activeOutputBottomTarget({ composerTop: 500, viewportHeight: 800, margin: 24 }), 476);
assert.strictEqual(activeOutputBottomTarget({ composerTop: 50, viewportHeight: 800, margin: 24 }), 80);
assert.strictEqual(isNodeAwayFromOutputFocus({ nodeRect: { top: 100, bottom: 430 }, messagesRect: { top: 0, bottom: 500 }, composerTop: 520, viewportHeight: 700 }), false);
assert.strictEqual(isNodeAwayFromOutputFocus({ nodeRect: { top: 100, bottom: 520 }, messagesRect: { top: 0, bottom: 500 }, composerTop: 520, viewportHeight: 700 }), true);
assert.strictEqual(isNodeAwayFromOutputFocus({ nodeRect: { top: 520, bottom: 620 }, messagesRect: { top: 0, bottom: 500 }, composerTop: 520, viewportHeight: 700 }), true);
console.log('scroll controller ok');
