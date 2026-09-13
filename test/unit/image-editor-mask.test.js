'use strict';

const assert = require('assert');

const maskEditor = require('../../client/features/image-editor/mask-editor');
const imageSizePolicy = require('../../shared/image-size-policy');

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

function testEnhancePromptPreservesTheOriginalImage() {
  const prompt = maskEditor.buildEnhancePrompt();
  assert.match(prompt, /提升这张图片的清晰度/);
  assert.match(prompt, /增强细节、纹理、边缘和局部对比度/);
  assert.match(prompt, /保持原始构图、主体、姿态、颜色、光照、风格和文字内容不变/);
  assert.match(prompt, /不要添加或删除任何元素/);
}

function testResizePresetsCoverEverySupportedAspectRatioWithinPolicyBounds() {
  const presets = maskEditor.IMAGE_RESIZE_PRESETS;
  assert.deepStrictEqual(
    presets.map(preset => [preset.label, preset.ratio, preset.size]),
    [
      ['方形', '1:1', '1024x1024'],
      ['竖版', '3:4', '1152x1536'],
      ['故事版', '9:16', '864x1536'],
      ['横版', '4:3', '1536x1152'],
      ['宽屏', '16:9', '1536x864'],
    ],
    'the resize menu must expose the five canonical aspect ratios',
  );
  for (const preset of presets) {
    const validation = imageSizePolicy.validateImageSize(preset.size);
    assert.strictEqual(validation.valid, true, `${preset.label} ${preset.size} must satisfy the shared image-size policy`);
    assert.strictEqual(validation.width, preset.width);
    assert.strictEqual(validation.height, preset.height);
  }
}

function testResizePromptRequestsNaturalRecompositionAtTheSelectedSize() {
  const preset = maskEditor.IMAGE_RESIZE_PRESETS.find(item => item.ratio === '16:9');
  const prompt = maskEditor.buildResizePrompt(preset);
  assert.match(prompt, /16:9/);
  assert.match(prompt, /1536 × 864/);
  assert.match(prompt, /保持主体、内容、颜色、风格和细节/);
  assert.match(prompt, /自然扩展、补全或重新构图/);
  assert.match(prompt, /不要拉伸变形/);
}

function testCompositePromptIncludesEverySupportedOperation() {
  const prompt = maskEditor.buildCompositeEditPrompt({
    comments: [{ x: 0.25, y: 0.5, text: '淡化左侧水面', color: '#2563eb' }],
    eraseActions: [{
      instruction: '去掉右上角文字',
      strokes: [{ x: 0.75, y: 0.2, radius: 0.05 }],
    }],
    hasErase: true,
    removeBackground: false,
    enhance: true,
  });
  const localStep = prompt.indexOf('请先只修改编辑蒙版中的透明区域');
  const enhanceStep = prompt.indexOf('随后，对整张图片进行清晰度提升');
  assert.ok(localStep >= 0 && localStep < enhanceStep,
    'mixed edits must keep local annotations before clarity enhancement');
  assert.match(prompt, /先只修改编辑蒙版中的透明区域/);
  assert.match(prompt, /随后，对整张图片进行清晰度提升：提升这张图片的清晰度/);
  assert.match(prompt, /淡化左侧水面/);
  assert.match(prompt, /选中区域位置：画面右侧上方/);
  assert.match(prompt, /中心 \(x=0\.750, y=0\.200\)/);
  assert.match(prompt, /修改内容：去掉右上角文字/);
}

function testCompositePromptIncludesResizeAfterLocalEditsAndEnhancement() {
  const resize = maskEditor.IMAGE_RESIZE_PRESETS.find(item => item.ratio === '4:3');
  const prompt = maskEditor.buildCompositeEditPrompt({
    comments: [{ x: 0.25, y: 0.5, text: '淡化左侧水面', color: '#2563eb' }],
    hasErase: false,
    removeBackground: false,
    enhance: true,
    resize,
  });
  const localStep = prompt.indexOf('请先只修改编辑蒙版中的透明区域');
  const enhanceStep = prompt.indexOf('随后，对整张图片进行清晰度提升');
  const resizeStep = prompt.indexOf('4:3');
  assert.ok(localStep >= 0 && localStep < enhanceStep && enhanceStep < resizeStep,
    'mixed edits must keep local work, enhancement, and the final resize in deterministic order');
  assert.match(prompt, /1536 × 1152/);
}

function testRemoveBackgroundCannotBeCombinedInPromptConstruction() {
  assert.strictEqual(maskEditor.buildCompositeEditPrompt({ enhance: true, removeBackground: true }), '',
    'remove background must not be combined with clarity enhancement');
  assert.strictEqual(maskEditor.buildCompositeEditPrompt({
    comments: [{ x: 0.5, y: 0.5, text: '改一下' }],
    removeBackground: true,
  }), '', 'remove background must not be combined with local edits');
}

function testSelectedAreaPromptIncludesThePaintedLocation() {
  const prompt = maskEditor.buildSelectedAreaPrompt('淡化人物脸部', [
    { x: 0.2, y: 0.7, radius: 0.05 },
    { x: 0.3, y: 0.8, radius: 0.05 },
  ]);
  assert.match(prompt, /选中区域位置：画面左侧下方/);
  assert.match(prompt, /中心 \(x=0\.250, y=0\.750\)/);
  assert.match(prompt, /边界 x=0\.150–0\.350、y=0\.650–0\.850/);
  assert.match(prompt, /归一化坐标/);
}

function testSelectedAreaPromptScopesTheChangeToTheMask() {
  const prompt = maskEditor.buildSelectedAreaPrompt('把选区改成夜景');
  assert.strictEqual(prompt, [
    '请只修改图片中编辑蒙版覆盖的区域。',
    '修改内容：把选区改成夜景',
    '蒙版外的原始内容必须保持不变，不要输出蒙版、编号或任何标记。',
  ].join('\n'), 'custom instructions must use a clear mask-scoped prompt');
  assert.strictEqual(
    maskEditor.buildSelectedAreaPrompt(''),
    'Remove the selected area and fill it naturally with the surrounding background.',
    'an empty instruction must keep natural erase semantics',
  );
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
  testEnhancePromptPreservesTheOriginalImage,
  testResizePresetsCoverEverySupportedAspectRatioWithinPolicyBounds,
  testResizePromptRequestsNaturalRecompositionAtTheSelectedSize,
  testCompositePromptIncludesEverySupportedOperation,
  testCompositePromptIncludesResizeAfterLocalEditsAndEnhancement,
  testRemoveBackgroundCannotBeCombinedInPromptConstruction,
  testSelectedAreaPromptIncludesThePaintedLocation,
  testSelectedAreaPromptScopesTheChangeToTheMask,
  testStrokePointNormalizesToCanvasSpace,
];
