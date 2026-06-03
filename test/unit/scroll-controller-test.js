#!/usr/bin/env node
const assert = require('assert');
const { composerSafeBottom, activeOutputBottomTarget, isNodeAwayFromOutputFocus, createAutoFollowState } = require('../../client/ui/scroll-controller');

assert.strictEqual(composerSafeBottom('120px'), 120);
assert.strictEqual(composerSafeBottom('bad'), 168);
assert.strictEqual(activeOutputBottomTarget({ composerTop: 500, viewportHeight: 800, margin: 24 }), 476);
assert.strictEqual(activeOutputBottomTarget({ composerTop: 50, viewportHeight: 800, margin: 24 }), 80);
assert.strictEqual(isNodeAwayFromOutputFocus({ nodeRect: { top: 100, bottom: 430 }, messagesRect: { top: 0, bottom: 500 }, composerTop: 520, viewportHeight: 700 }), false);
assert.strictEqual(isNodeAwayFromOutputFocus({ nodeRect: { top: 100, bottom: 520 }, messagesRect: { top: 0, bottom: 500 }, composerTop: 520, viewportHeight: 700 }), false);
assert.strictEqual(isNodeAwayFromOutputFocus({ nodeRect: { top: 100, bottom: 590 }, messagesRect: { top: 0, bottom: 500 }, composerTop: 520, viewportHeight: 700 }), true);
assert.strictEqual(isNodeAwayFromOutputFocus({ nodeRect: { top: 520, bottom: 620 }, messagesRect: { top: 0, bottom: 500 }, composerTop: 520, viewportHeight: 700 }), true);

let now = 1000;
const scroller = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
const follow = createAutoFollowState({ threshold: 40, suppressMs: 100, now: () => now });
assert.strictEqual(follow.canFollow(scroller), true, 'stream append should follow when auto-follow is active');
follow.markEvent({ type: 'wheel', deltaY: -30 }, scroller);
assert.strictEqual(follow.state.userScrolledAway, true, 'wheel up should pause auto-follow');
assert.strictEqual(follow.canFollow(scroller), false, 'append should not force scroll after user scrolls away');
scroller.scrollTop = 800;
follow.markEvent({ type: 'scroll' }, scroller);
assert.strictEqual(follow.state.userScrolledAway, false, 'returning near bottom should restore auto-follow');
assert.strictEqual(follow.canFollow(scroller), true, 'final should follow after user returns near bottom');
follow.suppress();
scroller.scrollTop = 500;
follow.markEvent({ type: 'scroll' }, scroller);
assert.strictEqual(follow.state.userScrolledAway, false, 'programmatic scroll must not be treated as user scrolling away while suppressed');
now = 1200;
follow.markEvent({ type: 'scroll' }, scroller);
assert.strictEqual(follow.state.userScrolledAway, true, 'scrollbar/scroll position away after suppression should pause follow');
follow.begin(scroller);
assert.strictEqual(follow.state.userScrolledAway, false, 'new message/stream can reset auto-follow');

const streamingFollow = createAutoFollowState({ threshold: 72, suppressMs: 100, now: () => now });
const streamScroller = { scrollTop: 900, scrollHeight: 1100, clientHeight: 200 };
streamingFollow.begin(streamScroller);
assert.strictEqual(streamingFollow.canFollow(streamScroller), true, 'streaming start should follow immediately without resume click');
streamingFollow.markEvent({ type: 'wheel', deltaY: -40 }, streamScroller);
assert.strictEqual(streamingFollow.canFollow(streamScroller), false, 'user wheel up should pause streaming follow');
streamScroller.scrollTop = 900;
streamingFollow.markEvent({ type: 'scroll' }, streamScroller);
assert.strictEqual(streamingFollow.canFollow(streamScroller), true, 'scrolling back near bottom should restore streaming follow');
streamingFollow.markEvent({ type: 'pointerdown' }, streamScroller);
streamScroller.scrollTop = 600;
streamingFollow.markEvent({ type: 'scroll' }, streamScroller);
assert.strictEqual(streamingFollow.canFollow(streamScroller), false, 'dragging scrollbar away should pause streaming follow');
streamScroller.scrollTop = 900;
streamingFollow.markEvent({ type: 'scroll' }, streamScroller);
assert.strictEqual(streamingFollow.canFollow(streamScroller), true, 'returning to bottom after scrollbar drag should restore final follow');

console.log('scroll controller ok');
