'use strict';

const assert = require('assert');
const commentLayer = require('../../client/features/image-editor/comment-layer');

function makeContext() {
  const calls = [];
  const ctx = {
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath: () => calls.push(['beginPath']),
    stroke: () => calls.push(['stroke']),
    arc: (x, y, radius) => calls.push(['arc', x, y, radius]),
    fill: () => calls.push(['fill']),
    fillText: (text, x, y) => calls.push(['fillText', text, x, y]),
  };
  return { ctx, calls };
}

function testCommentLabelsFollowPlacementOrder() {
  assert.strictEqual(commentLayer.commentLabel(0), '1');
  assert.strictEqual(commentLayer.commentLabel(1), '2');
  assert.strictEqual(commentLayer.commentLabel(2), '3');
  assert.strictEqual(commentLayer.commentLabel(12), '13', 'labels must stay plain and deterministic');
  assert.strictEqual(commentLayer.commentLabel(-1), '');
}

function testCommentPromptJoinsLabelsTextAndInstruction() {
  const prompt = commentLayer.buildCommentPrompt(
    [{ x: 0.25, y: 0.25, text: '\u628a\u624b\u6539\u6210\u84dd\u8272' }, { x: 0.6, y: 0.4, text: '\u80cc\u666f\u6362\u6210\u6d77\u6ee9' }],
    '\u4fdd\u6301\u5176\u4ed6\u4e0d\u53d8',
  );
  assert.ok(prompt.startsWith('\u56fe\u7247\u4e0a\u6709\u4e00\u4e2a\u7f16\u8f91\u8499\u7248'));
  assert.ok(prompt.includes('\u8bf7\u53ea\u4fee\u6539\u4ee5\u4e0b\u7f16\u53f7\u4f4d\u7f6e\u5bf9\u5e94\u7684\u539f\u59cb\u5185\u5bb9'));
  assert.ok(prompt.includes('1. \u4f4d\u7f6e (x=0.250, y=0.250)\uff1a\u628a\u624b\u6539\u6210\u84dd\u8272'));
  assert.ok(prompt.includes('2. \u4f4d\u7f6e (x=0.600, y=0.400)\uff1a\u80cc\u666f\u6362\u6210\u6d77\u6ee9'));
  assert.ok(prompt.includes('\u4fdd\u6301\u5176\u4ed6\u4e0d\u53d8'));
  assert.strictEqual(commentLayer.buildCommentPrompt([], ''), '');
  assert.strictEqual(commentLayer.buildCommentPrompt([{ text: '  ' }], ''), '');
  assert.strictEqual(commentLayer.buildCommentPrompt([], '\u4ec5\u6307\u4ee4'), '\u4ec5\u6307\u4ee4');
}

function testPaintCommentsRenderNumberedMarkers() {
  const { ctx, calls } = makeContext();
  const painted = commentLayer.paintComments(ctx, {
    width: 200,
    height: 100,
    comments: [
      { x: 0.2, y: 0.8, text: '\u628a\u624b\u6539\u6210\u84dd\u8272' },
      { x: 0.4, y: 0.5, text: '\u80cc\u666f\u6362\u6210\u6d77\u6ee9' },
    ],
  });
  assert.strictEqual(painted, 2, 'every numbered comment must paint');
  assert.strictEqual(calls.filter(call => call[0] === 'arc').length, 4, 'one fill circle and one outer ring per comment');
  const labels = calls.filter(call => call[0] === 'fillText').map(call => call[1]);
  assert.ok(labels.includes('1'), 'the first comment must render its plain number');
  assert.ok(labels.includes('2'), 'the second comment must render its plain number');
}

function testPaintCommentsMapNormalizedCoordinates() {
  const { ctx, calls } = makeContext();
  commentLayer.paintComments(ctx, {
    width: 100,
    height: 50,
    comments: [{ x: 1, y: 1, text: '\u8fb9\u7f18' }],
  });
  const arc = calls.find(call => call[0] === 'arc');
  assert.ok(arc, 'the comment marker must draw a circle');
  assert.strictEqual(arc[1], 100, 'normalized x must scale to pixels');
  assert.strictEqual(arc[2], 50, 'normalized y must scale to pixels');
}

function testPaintCommentsCenterTheGlyphInk() {
  const drawn = [];
  const ctx = {
    beginPath() {}, arc() {}, fill() {}, stroke() {},
    measureText() {
      return {
        width: 10,
        actualBoundingBoxLeft: 1,
        actualBoundingBoxRight: 9,
        actualBoundingBoxAscent: 12,
        actualBoundingBoxDescent: 3,
      };
    },
    fillText(text, x, y) { drawn.push({ text, x, y }); },
  };
  const painted = commentLayer.paintComments(ctx, {
    width: 100,
    height: 100,
    comments: [{ x: 0.5, y: 0.5, text: '把手改成蓝色' }],
  });
  assert.strictEqual(painted, 1);
  assert.strictEqual(drawn[0].text, '1');
  assert.strictEqual(drawn[0].x, 46, 'the digit ink box must be centered horizontally');
  assert.strictEqual(drawn[0].y, 54.5, 'the digit ink box must be centered vertically');
}

function testEmptyCommentLayerPaintsNothing() {
  const { ctx, calls } = makeContext();
  const painted = commentLayer.paintComments(ctx, { width: 100, height: 100, comments: [] });
  assert.strictEqual(painted, 0);
  assert.strictEqual(calls.length, 0, 'an empty overlay must not touch the canvas');
}

function testAnnotationShapeApiStaysRemoved() {
  assert.strictEqual(typeof commentLayer.paintAnnotations, 'undefined',
    'the annotate shape renderer must stay removed');
  assert.strictEqual(typeof commentLayer.DEFAULT_SIZE, 'undefined',
    'annotate shape sizing must stay removed');
  assert.strictEqual(typeof commentLayer.paintComments, 'function');
  assert.strictEqual(commentLayer.COMMENT_LABELS, undefined, 'circled label data must stay removed');
}

module.exports = [
  testCommentLabelsFollowPlacementOrder,
  testCommentPromptJoinsLabelsTextAndInstruction,
  testPaintCommentsRenderNumberedMarkers,
  testPaintCommentsMapNormalizedCoordinates,
  testEmptyCommentLayerPaintsNothing,
  testPaintCommentsCenterTheGlyphInk,
  testAnnotationShapeApiStaysRemoved,
];
