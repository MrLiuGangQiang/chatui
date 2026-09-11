'use strict';

const assert = require('assert');

const maskEditor = require('../../client/features/image-editor/mask-editor');

function testMaskKeepsOpaqueOutsideTheBrushAndTransparentInside() {
  const strokes = [{ x: 0.5, y: 0.5, radius: 0.1 }];
  assert.strictEqual(maskEditor.maskAlphaAtPoint(strokes, 0.5, 0.5), 0,
    'the painted area must become the transparent edit region');
  assert.strictEqual(maskEditor.maskAlphaAtPoint(strokes, 0.5, 0.58), 0,
    'points inside the brush radius stay editable');
  assert.strictEqual(maskAlphaAtPointSafe(strokes, 0.2, 0.2), 255,
    'untouched pixels must stay opaque so they are preserved');
  assert.strictEqual(maskEditor.maskAlphaAtPoint([], 0.5, 0.5), 255,
    'an empty mask preserves the whole image');
}

function maskAlphaAtPointSafe(strokes, x, y) {
  return maskEditor.maskAlphaAtPoint(strokes, x, y);
}

function testPaintMaskFillsWhiteThenErasesStrokes() {
  const calls = [];
  const ctx = {
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    fillRect(...args) { calls.push(['fillRect', this.fillStyle, this.globalCompositeOperation, ...args]); },
    beginPath() { calls.push(['beginPath', this.globalCompositeOperation]); },
    arc(...args) { calls.push(['arc', this.globalCompositeOperation, ...args]); },
    fill() { calls.push(['fill', this.globalCompositeOperation]); },
  };
  maskEditor.paintMask(ctx, {
    width: 200,
    height: 100,
    strokes: [{ x: 0.25, y: 0.5, radius: 0.1 }],
  });
  assert.deepStrictEqual(calls[0], ['fillRect', '#ffffff', 'source-over', 0, 0, 200, 100],
    'the mask must start as an opaque white canvas');
  const arcCall = calls.find(call => call[0] === 'arc');
  assert.ok(arcCall, 'the brush must be drawn');
  assert.strictEqual(arcCall[1], 'destination-out', 'brush strokes must erase to transparency');
  assert.strictEqual(arcCall[2], 50, 'normalized x maps to the mask width');
  assert.strictEqual(arcCall[3], 50, 'normalized y maps to the mask height');
  assert.strictEqual(arcCall[4], 10, 'radius scales with the smaller edge');
  assert.strictEqual(ctx.globalCompositeOperation, 'source-over', 'compositing must be restored after painting');
}

function testStrokePointNormalizesToCanvasSpace() {
  const point = maskEditor.normalizeStrokePoint(
    { clientX: 150, clientY: 260 },
    { left: 100, top: 200, width: 200, height: 120 },
  );
  assert.strictEqual(point.x, 0.25);
  assert.strictEqual(point.y, 0.5);
  const clamped = maskEditor.normalizeStrokePoint(
    { clientX: 0, clientY: 0 },
    { left: 100, top: 200, width: 200, height: 120 },
  );
  assert.strictEqual(clamped.x, 0);
  assert.strictEqual(clamped.y, 0);
}

module.exports = [
  testMaskKeepsOpaqueOutsideTheBrushAndTransparentInside,
  testPaintMaskFillsWhiteThenErasesStrokes,
  testStrokePointNormalizesToCanvasSpace,
];
