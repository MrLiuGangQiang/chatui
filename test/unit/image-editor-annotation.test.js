'use strict';

const assert = require('assert');

const annotationLayer = require('../../client/features/image-editor/annotation-layer');

function makeContext() {
  const calls = [];
  const ctx = {
    beginPath: () => calls.push(['beginPath']),
    moveTo: (x, y) => calls.push(['moveTo', x, y]),
    lineTo: (x, y) => calls.push(['lineTo', x, y]),
    stroke: () => calls.push(['stroke']),
    rect: (x, y, width, height) => calls.push(['rect', x, y, width, height]),
    arc: (x, y, radius) => calls.push(['arc', x, y, radius]),
    fill: () => calls.push(['fill']),
    fillText: (text, x, y) => calls.push(['fillText', text, x, y]),
  };
  return { ctx, calls };
}

function testCommentLabelsFollowPlacementOrder() {
  assert.strictEqual(annotationLayer.commentLabel(0), '\u2460');
  assert.strictEqual(annotationLayer.commentLabel(1), '\u2461');
  assert.strictEqual(annotationLayer.commentLabel(2), '\u2462');
  assert.strictEqual(annotationLayer.commentLabel(12), '(13)', 'labels past the circled range must stay deterministic');
  assert.strictEqual(annotationLayer.commentLabel(-1), '');
}

function testCommentPromptJoinsLabelsTextAndInstruction() {
  const prompt = annotationLayer.buildCommentPrompt(
    [{ text: '\u628a\u624b\u6539\u6210\u84dd\u8272' }, { text: '\u80cc\u666f\u6362\u6210\u6d77\u6ee9' }],
    '\u4fdd\u6301\u5176\u4ed6\u4e0d\u53d8',
  );
  assert.ok(prompt.includes('\u2460 \u628a\u624b\u6539\u6210\u84dd\u8272'));
  assert.ok(prompt.includes('\u2461 \u80cc\u666f\u6362\u6210\u6d77\u6ee9'));
  assert.ok(prompt.includes('\u4fdd\u6301\u5176\u4ed6\u4e0d\u53d8'));
  assert.strictEqual(annotationLayer.buildCommentPrompt([], ''), '');
  assert.strictEqual(annotationLayer.buildCommentPrompt([{ text: '  ' }], ''), '');
  assert.strictEqual(annotationLayer.buildCommentPrompt([], '\u4ec5\u6307\u4ee4'), '\u4ec5\u6307\u4ee4');
}

function testPaintAnnotationsRendersEveryShapeKind() {
  const { ctx, calls } = makeContext();
  const painted = annotationLayer.paintAnnotations(ctx, {
    width: 200,
    height: 100,
    shapes: [
      { type: 'freehand', points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.1 }] },
      { type: 'arrow', x: 0.1, y: 0.3, x2: 0.4, y2: 0.6 },
      { type: 'rect', x: 0.5, y: 0.1, x2: 0.8, y2: 0.4 },
      { type: 'text', x: 0.6, y: 0.7, text: '\u6539\u6210\u84dd\u8272' },
    ],
    comments: [{ x: 0.2, y: 0.8, text: '\u628a\u624b\u6539\u6210\u84dd\u8272' }],
  });
  assert.strictEqual(painted, 5, 'every shape and comment must paint');
  assert.strictEqual(calls.filter(call => call[0] === 'stroke').length, 3, 'freehand, arrow and rect draw strokes while text fills');
  const rectCall = calls.find(call => call[0] === 'rect');
  assert.ok(rectCall, 'the rectangle tool must draw a rect');
  assert.deepStrictEqual(rectCall.slice(1), [100, 10, 60, 30]);
  const texts = calls.filter(call => call[0] === 'fillText').map(call => call[1]);
  assert.ok(texts.includes('\u6539\u6210\u84dd\u8272'), 'annotation text must be drawn');
  assert.ok(texts.includes('\u2460'), 'the comment marker must render its label');
  assert.strictEqual(calls.filter(call => call[0] === 'arc').length, 1, 'one comment marker circle');
}

function testPaintAnnotationsMapsNormalizedCoordinates() {
  const { ctx, calls } = makeContext();
  annotationLayer.paintAnnotations(ctx, {
    width: 100,
    height: 50,
    shapes: [{ type: 'arrow', x: 0, y: 0, x2: 1, y2: 1 }],
  });
  const moves = calls.filter(call => call[0] === 'moveTo');
  assert.deepStrictEqual(moves[0].slice(1), [0, 0]);
  const lineTos = calls.filter(call => call[0] === 'lineTo');
  assert.ok(lineTos.some(call => call[1] === 100 && call[2] === 50), 'normalized points must scale to pixels');
}

function testEmptyAnnotationLayerPaintsNothing() {
  const { ctx, calls } = makeContext();
  const painted = annotationLayer.paintAnnotations(ctx, { width: 100, height: 100, shapes: [], comments: [] });
  assert.strictEqual(painted, 0);
  assert.strictEqual(calls.length, 0, 'an empty overlay must not touch the canvas');
}

module.exports = [
  testCommentLabelsFollowPlacementOrder,
  testCommentPromptJoinsLabelsTextAndInstruction,
  testPaintAnnotationsRendersEveryShapeKind,
  testPaintAnnotationsMapsNormalizedCoordinates,
  testEmptyAnnotationLayerPaintsNothing,
];
