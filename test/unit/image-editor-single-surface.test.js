'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const maskEditor = require('../../client/features/image-editor/mask-editor');

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function createEditorFixture(imageSize = {}, viewport = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const { window } = dom;
  const { document } = window;
  if (viewport.width) Object.defineProperty(window, 'innerWidth', { configurable: true, value: Number(viewport.width) });
  if (viewport.height) Object.defineProperty(window, 'innerHeight', { configurable: true, value: Number(viewport.height) });
  const canvases = [];
  const originalCreateElement = document.createElement.bind(document);
  document.createElement = function createElement(tag, ...rest) {
    const node = originalCreateElement(tag, ...rest);
    if (String(tag).toLowerCase() === 'canvas') {
      canvases.push(node);
      node.getContext = () => {
        if (!node.__context) {
          node.__context = {
            arcCalls: [],
            drawImageCalls: [],
            clearRect() {}, beginPath() {},
            arc(x, y, radius) { this.arcCalls.push([x, y, radius]); },
            fill() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {},
            drawImage(...args) { this.drawImageCalls.push(args); },
            fillText() {},
          };
        }
        return node.__context;
      };
      node.toBlob = callback => callback(new window.Blob(['mask'], { type: 'image/png' }));
      node.toDataURL = () => 'data:image/png;base64,thumbnail';
    }
    return node;
  };
  const toasts = [];
  const sourceWidth = Number(imageSize.width) || 4;
  const sourceHeight = Number(imageSize.height) || 4;
  class FakeImage {
    constructor() {
      this.naturalWidth = sourceWidth;
      this.naturalHeight = sourceHeight;
      this.width = sourceWidth;
      this.height = sourceHeight;
    }
    set src(value) {
      this._src = value;
      queueMicrotask(() => this.onload?.());
    }
  }
  const editor = maskEditor.createImageEditor({
    document,
    window,
    URL: { createObjectURL: () => 'blob:editor-source', revokeObjectURL: () => {} },
    Image: FakeImage,
    toast: message => toasts.push(String(message)),
  });
  return { dom, document, editor, toasts, canvases };
}

function findAction(document, label) {
  return [...document.querySelectorAll('.image-editor-action')].find(button => String(button.textContent || '').trim() === label);
}

function findControl(document, label) {
  return [...document.querySelectorAll('.image-editor-control')].find(button => String(button.textContent || '').trim() === label);
}

function modificationCards(document) {
  return [...document.querySelectorAll('.image-editor-comment-card')];
}

function modificationCardByText(document, text) {
  return modificationCards(document).find(card => String(card.textContent || '').includes(text)) || null;
}

// captureRegionThumbnail draws with the nine-argument drawImage signature:
// source window first, thumbnail canvas second.
function recordThumbnailCrops(fixture) {
  return fixture.canvases
    .flatMap(canvas => canvas.__context?.drawImageCalls || [])
    .filter(args => args.length === 9);
}

function addComment(fixture, { x, y, text }) {
  const document = fixture.document;
  const commentButton = [...document.querySelectorAll('.image-editor-tool')]
    .find(button => String(button.textContent || '').trim() === '标记评论');
  commentButton.click();
  const overlay = document.querySelector('.image-editor-overlay');
  overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
  overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', {
    bubbles: true,
    clientX: x * 100,
    clientY: y * 100,
  }));
  const input = document.querySelector('.image-editor-comment-popover input');
  input.value = text;
  document.querySelector('.image-editor-comment-confirm').click();
}

async function testEditorOpensNeutralAndRequiresAToolBeforeApplying() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'image.png' });
    await tick();
    assert.strictEqual(fixture.document.querySelector('.image-editor-header'), null,
      'the top brand toolbar must be removed');
    const body = fixture.document.querySelector('.image-editor-body');
    assert.deepStrictEqual([...body.children].map(node => node.className), [
      'image-editor-workbench',
      'image-editor-footer',
    ], 'the body must contain the centered workbench and its aligned footer');
    const workbench = body.querySelector('.image-editor-workbench');
    assert.deepStrictEqual([...workbench.children].map(node => node.className), [
      'image-editor-toolbar',
      'image-editor-canvas',
      'image-editor-comment-panel',
    ], 'the desktop workbench must keep tools, canvas, and comments as one centered group');
    const editorCss = fixture.document.getElementById('chatui-image-editor-style')?.textContent || '';
    assert.match(editorCss, /\.image-editor-comment-panel\{[^}]*flex:0 0 360px/,
      'the modification-record panel must be wider than the left toolbar');
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-tab'), null,
      'the image properties tab must be removed');
    assert.strictEqual(fixture.document.querySelector('.image-editor-properties'), null,
      'the image properties panel must be removed');
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-filter'), null,
      'the redundant all-comments filter must be removed');
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-title').textContent, '操作历史');
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '0',
      'the history header must show the count without a filter row');
    const toolbar = workbench.querySelector('.image-editor-toolbar');
    const toolButtons = [...toolbar.querySelectorAll('.image-editor-tool')];
    toolButtons.forEach(button => {
      assert.strictEqual(button.hasAttribute('data-shortcut'), false,
        'toolbar tools must not advertise keyboard shortcuts');
      assert.strictEqual(button.hasAttribute('aria-keyshortcuts'), false,
        'toolbar tools must not expose accessibility shortcuts');
    });
    const footerControls = fixture.document.querySelector('.image-editor-footer-controls');
    assert.deepStrictEqual(
      [...footerControls.querySelectorAll('.image-editor-control')].map(button => button.textContent.trim()),
      ['撤销', '重置'],
      'the footer must keep history controls only',
    );
    for (const label of ['缩小', '放大', '适应窗口', '原始尺寸', '全屏']) {
      assert.strictEqual(fixture.document.querySelector(`[aria-label="${label}"]`), null,
        `the ${label} control must be removed`);
    }
    assert.deepStrictEqual(toolButtons.map(button => button.textContent.trim()), ['标记评论', '背景移除', '画质提升', '局部擦除', '调整尺寸'],
      'the editor toolbar must expose the five supported tools in order with resize last');
    assert.doesNotMatch(editorCss, /\.image-editor-resize-tool\{[^}]*margin-top:auto/,
      'resize must stay last in tool order without being pinned to the panel bottom');
    toolButtons.forEach(button => assert.ok(button.querySelector('svg'), 'every toolbar tool must carry an icon'));
    const commentIcon = toolButtons.find(button => button.textContent.trim() === '标记评论').querySelector('svg');
    assert.ok(commentIcon.querySelector('circle[cx="12"][cy="12"][r="6.8"]'),
      'the comment tool must reuse the crosshair shape of its active cursor');
    assert.ok(commentIcon.querySelector('path[d="M12 2v4M12 18v4M2 12h4M18 12h4"]'),
      'the comment tool icon must include the same four cursor ticks');
    assert.ok(commentIcon.querySelector('circle[fill="currentColor"]'),
      'the comment tool icon must include the same center dot as the active cursor');
    const backgroundIcon = toolButtons.find(button => button.textContent.trim() === '背景移除').querySelector('svg');
    const enhanceIcon = toolButtons.find(button => button.textContent.trim() === '画质提升').querySelector('svg');
    assert.ok(backgroundIcon.querySelector('circle') && backgroundIcon.querySelectorAll('path').length >= 2,
      'the background tool must use a distinct subject-cutout icon');
    assert.notStrictEqual(backgroundIcon.innerHTML, enhanceIcon.innerHTML,
      'background removal and clarity enhancement must not share the same icon');
    const footerActions = fixture.document.querySelector('.image-editor-footer-actions');
    assert.ok(footerActions, 'apply and cancel must sit together in the footer');
    const hiddenClear = findAction(fixture.document, '清空评论');
    assert.strictEqual(hiddenClear.hidden, true, 'clear must stay hidden until the active tool has content');
    assert.strictEqual(fixture.dom.window.getComputedStyle(hiddenClear).display, 'none',
      'the hidden clear action must not be overridden by button styles');
    assert.strictEqual(fixture.dom.window.getComputedStyle(fixture.document.querySelector('.image-editor-tool-options')).display, 'none',
      'empty tool options must not leave a divider behind');
    assert.deepStrictEqual(
      [...footerActions.querySelectorAll('.image-editor-action')].map(button => button.textContent.trim()),
      ['清空评论', '提交修改', '取消编辑'],
      'the footer must order clear, apply, and cancel at the right edge',
    );
    [...footerActions.querySelectorAll('.image-editor-action')].forEach(button => {
      assert.ok(button.querySelector('svg'), 'apply and cancel must carry icons');
    });

    const pressed = toolButtons.filter(button => button.getAttribute('aria-pressed') === 'true');
    assert.strictEqual(pressed.length, 0, 'the editor must open without preselecting a destructive tool');
    assert.match(fixture.document.querySelector('.image-editor-hint').textContent, /组合使用多个编辑工具/);

    findAction(fixture.document, '提交修改').click();
    await tick();
    assert.strictEqual(fixture.toasts.at(-1), '请先添加操作记录',
      'applying without any modification must explain that a record is required');
    assert.ok(fixture.document.querySelector('.image-editor-backdrop').isConnected,
      'the editor must stay open when no tool is selected');

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null, 'cancelling the editor must resolve without an edit');
  } finally {
    fixture.dom.window.close();
  }
}

async function testEraseToolBuildsTheSelectedAreaInstructionPrompt() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'image.png' });
    await tick();
    const eraseButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '局部擦除');
    assert.ok(eraseButton, 'the editor must expose the erase/select-area tool');
    eraseButton.click();

    const instructionInput = [...fixture.document.querySelectorAll('input')]
      .find(input => String(input.placeholder || '').includes('选中区域'));
    assert.ok(instructionInput, 'the erase tool must accept an area modification instruction');
    instructionInput.value = '把选区改成夜景';

    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 70, clientY: 40 }));
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 70, clientY: 40 }));
    const thumbnail = fixture.document.querySelector('.image-editor-comment-card .image-editor-comment-thumbnail');
    assert.ok(thumbnail, 'erase records must show a local image crop');
    assert.match(thumbnail.src, /^data:image\/png/);
    findAction(fixture.document, '提交修改').click();
    const result = await pending;

    assert.strictEqual(result.mode, 'erase');
    assert.strictEqual(result.prompt, [
      '请只修改图片中编辑蒙版覆盖的区域。',
      '选中区域位置：画面右侧，中心 (x=0.700, y=0.400)，边界 x=0.420–0.980、y=0.120–0.680。坐标采用归一化坐标，左上角为 (0, 0)，右下角为 (1, 1)。',
      '修改内容：把选区改成夜景',
      '蒙版外的原始内容必须保持不变，不要输出蒙版、编号或任何标记。',
    ].join('\n'), 'the selected-area instruction must use the natural mask-scoped prompt');
    assert.strictEqual(result.label, '把选区改成夜景',
      'the transcript must show the user description without a redundant prefix');
  } finally {
    fixture.dom.window.close();
  }
}

async function testCommentToolCollectsNumberedCommentsAndSendsThemAsTheUserMessage() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'image.png' });
    await tick();
    const commentButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '标记评论');
    assert.ok(commentButton, 'the editor must expose the comment tool');
    commentButton.click();
    assert.strictEqual(commentButton.getAttribute('aria-pressed'), 'true');

    assert.ok(maskEditor.COMMENT_CURSOR.includes(') 14 14, crosshair'),
      'the aiming cursor hotspot must be the icon center');
    assert.ok(maskEditor.COMMENT_CURSOR.includes('%23111827'),
      'the aiming cursor must use the dark aiming strokes');

    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 4, height: 4, right: 4, bottom: 4 });
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 2, clientY: 2 }));
    assert.ok(fixture.document.querySelector('.image-editor-comment-popover.active'),
      'clicking the image with the comment tool must open the inline comment input');

    const commentInput = fixture.document.querySelector('.image-editor-comment-popover input');
    await tick();
    assert.strictEqual(fixture.document.activeElement, commentInput,
      'the comment input must receive focus so users can type immediately');
    commentInput.value = '改成蓝色';
    fixture.document.querySelector('.image-editor-comment-confirm').click();
    assert.ok(fixture.document.querySelector('.image-editor-comment-confirm svg'),
      'the confirm action must use the clean check icon');
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-bar'), null,
      'comments must use the shared apply button instead of a separate send bar');
    assert.match(fixture.document.querySelector('.image-editor-hint').textContent, /1 条评论/);

    findAction(fixture.document, '提交修改').click();
    const result = await pending;
    assert.strictEqual(result.mode, 'comment');
    assert.ok(result.maskBlob, 'the comment edit must return the generated mask');
    assert.strictEqual(result.compositeBlob, undefined, 'comment mode must not send an annotated composite image');
    assert.strictEqual(result.label, '1. 改成蓝色', 'the numbered comments must become the user message');
    assert.match(result.prompt, /图片上有一个编辑蒙版/, 'the model prompt must describe the generated edit mask');
    assert.match(result.prompt, /改成蓝色/);
  } finally {
    fixture.dom.window.close();
  }
}

async function testRemoveBackgroundToolUsesTheChatGptPrompt() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'image.png' });
    await tick();
    const button = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(entry => String(entry.textContent || '').trim() === '背景移除');
    assert.ok(button, 'the editor must expose the remove-background tool');
    button.click();
    findAction(fixture.document, '提交修改').click();
    const result = await pending;
    assert.strictEqual(result.mode, 'remove_background');
    assert.strictEqual(result.background, 'transparent');
    assert.strictEqual(result.output_format, 'png');
    assert.strictEqual(result.prompt, '移除此图像的背景。保持所有前景主体不变且完整无损，边缘干净平滑。将背景设为透明。');
  } finally {
    fixture.dom.window.close();
  }
}

async function testResizeMenuAddsTheSelectedAspectRatioAndSubmitsIt() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'image.png' });
    await tick();
    const resizeButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '调整尺寸');
    assert.ok(resizeButton, 'the editor must expose the resize tool');
    assert.strictEqual(resizeButton.getAttribute('aria-expanded'), 'false');

    resizeButton.click();
    const menu = fixture.document.querySelector('.image-editor-resize-menu');
    assert.ok(menu, 'clicking resize must open the ratio menu');
    assert.strictEqual(menu.querySelector('.image-editor-resize-title').textContent, '用不同宽高比生成此图片');
    const options = [...menu.querySelectorAll('.image-editor-resize-option')];
    assert.deepStrictEqual(options.map(option => option.textContent.trim()), [
      '方形 1:1',
      '竖版 3:4',
      '故事版 9:16',
      '横版 4:3',
      '宽屏 16:9',
    ], 'the resize menu must expose the five canonical ratios');
    options[0].focus();
    options[0].dispatchEvent(new fixture.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert.strictEqual(fixture.document.activeElement, options[1],
      'the resize menu must support keyboard arrow navigation');
    const resizeCss = fixture.document.getElementById(maskEditor.EDITOR_STYLE_ID)?.textContent || '';
    assert.match(resizeCss, /\.image-editor-resize-option:focus-visible\{[^}]*outline:2px solid #79b4ff/, 'resize options must use the editor focus style');

    options.find(option => option.textContent.includes('宽屏 16:9')).click();
    assert.strictEqual(menu.hidden, true, 'selecting a ratio must close the menu');
    assert.strictEqual(resizeButton.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '1');
    const card = modificationCardByText(fixture.document, '调整尺寸');
    assert.ok(card, 'the selected ratio must appear as a resize record');
    assert.match(card.textContent, /宽屏 16:9/);
    assert.match(card.textContent, /1536 × 864/);

    findAction(fixture.document, '提交修改').click();
    const result = await pending;
    assert.strictEqual(result.mode, 'resize');
    assert.strictEqual(result.size, '1536x864');
    assert.strictEqual(result.maskBlob, undefined, 'resize alone must not generate a mask');
    assert.match(result.label, /宽屏 16:9/);
    assert.match(result.prompt, /1536 × 864/);
  } finally {
    fixture.dom.window.close();
  }
}

async function testResizeSelectionCanBeReplacedAndDeleted() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'image.png' });
    await tick();
    const resizeButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '调整尺寸');
    const choose = label => {
      resizeButton.click();
      [...fixture.document.querySelectorAll('.image-editor-resize-option')]
        .find(option => option.textContent.includes(label)).click();
    };
    choose('方形 1:1');
    choose('竖版 3:4');
    assert.strictEqual(modificationCards(fixture.document).length, 1,
      'choosing another ratio must replace the previous resize record');
    assert.match(modificationCardByText(fixture.document, '竖版 3:4').textContent, /1152 × 1536/);
    assert.strictEqual(modificationCards(fixture.document).filter(card => card.textContent.includes('调整尺寸')).length, 1);

    modificationCardByText(fixture.document, '调整尺寸').querySelector('[data-record-action=delete]').click();
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '0');
    assert.strictEqual(resizeButton.getAttribute('aria-pressed'), 'false');

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testResizeCannotMixWithRemoveBackground() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'image.png' });
    await tick();
    const tool = label => [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === label);
    tool('调整尺寸').click();
    [...fixture.document.querySelectorAll('.image-editor-resize-option')]
      .find(option => option.textContent.includes('横版 4:3')).click();
    tool('背景移除').click();
    findAction(fixture.document, '提交修改').click();
    await tick();
    assert.ok(fixture.document.querySelector('.image-editor-backdrop'), 'the editor must stay open after rejecting the mixed operation');
    assert.ok(fixture.toasts.includes('由于模型能力限制，移除背景不能和其他操作同时执行，否则可能生成黑白棋盘背景。请单独使用“移除背景”。'));

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testUndoRemovesOneWholeEraseStrokeGesture() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const eraseButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '局部擦除');
    eraseButton.click();
    assert.strictEqual(fixture.document.querySelector('.image-editor-tool-options').hidden, false,
      'erase options must appear only for the erase tool');
    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
    overlay.setPointerCapture = () => {};
    const pointer = (type, x, y) => new fixture.dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    overlay.dispatchEvent(pointer('pointerdown', 10, 10));
    overlay.dispatchEvent(pointer('pointermove', 30, 30));
    overlay.dispatchEvent(pointer('pointermove', 50, 50));
    overlay.dispatchEvent(pointer('pointerup', 50, 50));
    assert.ok(overlay.__context.arcCalls.length >= 3, 'the drag must paint every sample');

    overlay.__context.arcCalls.length = 0;
    findControl(fixture.document, '撤销').click();
    assert.strictEqual(overlay.__context.arcCalls.length, 0,
      'one undo must remove the whole drag gesture instead of a single sample');

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testRemoveBackgroundCannotMixWithOtherOperations() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'image.png' });
    await tick();
    const tool = label => [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === label);
    tool('背景移除').click();
    tool('画质提升').click();

    findAction(fixture.document, '提交修改').click();
    await tick();
    assert.ok(fixture.document.querySelector('.image-editor-backdrop'), 'the editor must stay open after rejecting the mixed operation');
    assert.ok(fixture.toasts.includes('由于模型能力限制，移除背景不能和其他操作同时执行，否则可能生成黑白棋盘背景。请单独使用“移除背景”。'));

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testResetClearsAllEditsAndReturnsToInitialState() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const eraseButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '局部擦除');
    eraseButton.click();
    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
    overlay.setPointerCapture = () => {};
    const pointer = (type, x, y) => new fixture.dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    overlay.dispatchEvent(pointer('pointerdown', 10, 10));
    overlay.dispatchEvent(pointer('pointermove', 30, 30));
    overlay.dispatchEvent(pointer('pointerup', 30, 30));
    assert.strictEqual(findControl(fixture.document, '重置').disabled, false,
      'reset must be enabled when there are erase strokes');

    [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '标记评论').click();
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 4, height: 4, right: 4, bottom: 4 });
    overlay.dispatchEvent(pointer('pointerdown', 2, 2));
    const input = fixture.document.querySelector('.image-editor-comment-popover input');
    input.value = '保留这个标记';
    fixture.document.querySelector('.image-editor-comment-confirm').click();
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '2',
      'the modification record count must include both erase and comment entries');

    overlay.__context.arcCalls.length = 0;
    findControl(fixture.document, '重置').click();
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '0',
      'reset must clear every modification record');
    assert.strictEqual(overlay.__context.arcCalls.length, 0,
      'reset must clear every erase stroke from the canvas');
    assert.strictEqual([...fixture.document.querySelectorAll('.image-editor-tool')]
      .some(button => button.getAttribute('aria-pressed') === 'true'), false,
    'reset must return the editor to its neutral initial state');
    assert.strictEqual(findControl(fixture.document, '撤销').disabled, true);
    assert.strictEqual(findControl(fixture.document, '重置').disabled, true);

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testCommentPanelRendersNumberedCardsAndCount() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'duck-scene.png' });
    await tick();
    const commentButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '标记评论');
    commentButton.click();
    assert.strictEqual(commentButton.getAttribute('aria-pressed'), 'true', 'the comment tool must select by click');

    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 4, height: 4, right: 4, bottom: 4 });
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 2, clientY: 2 }));
    const commentInput = fixture.document.querySelector('.image-editor-comment-popover input');
    commentInput.value = '木牌文字需要修改。将木牌上的文字改为「等等！我再想想！」。';
    fixture.document.querySelector('.image-editor-comment-confirm').click();

    const card = fixture.document.querySelector('.image-editor-comment-card');
    const commentIndex = card.querySelector('.image-editor-comment-index');
    const thumbnail = card.querySelector('.image-editor-comment-thumbnail');
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '1');
    const editorCss = fixture.document.getElementById('chatui-image-editor-style')?.textContent || '';
    assert.match(editorCss, /\.image-editor-comment-card\[data-modification-type=comment\] \.image-editor-comment-copy strong\{[^}]*font-weight:400\}/,
      '评论文字必须使用常规字重，不得加粗');
    assert.ok(commentIndex.style.backgroundColor, 'the numbered comment card must use a random marker color');
    assert.ok(thumbnail, 'comment records must show a local image crop');
    assert.match(thumbnail.src, /^data:image\/png/);
    assert.strictEqual(findAction(fixture.document, '清空评论').hidden, false,
      'clear must appear when comments exist');
    assert.strictEqual(commentIndex.textContent, '1');
    assert.strictEqual(card.querySelector('strong').textContent, '木牌文字需要修改');
    assert.match(card.querySelector('p').textContent, /将木牌上的文字改为/,
      'the designed comment card must separate a title from its detail copy');

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testDefaultCanvasUsesAFitWindowWithoutScrolling() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const canvas = fixture.document.querySelector('.image-editor-canvas');
    const footer = fixture.document.querySelector('.image-editor-footer');
    const base = fixture.document.querySelector('.image-editor-base');
    const workbench = fixture.document.querySelector('.image-editor-workbench');
    const toolbar = fixture.document.querySelector('.image-editor-toolbar');
    const historyPanel = fixture.document.querySelector('.image-editor-comment-panel');
    assert.strictEqual(canvas.style.width, '454px',
      'a small image must scale up to fill the available workbench area without changing its aspect ratio');
    assert.strictEqual(canvas.style.flexBasis, '454px',
      'the centered workbench must use the fitted image width as its layout basis');
    assert.strictEqual(canvas.style.overflow, '',
      'the default fit view must not expose image scrolling');
    assert.strictEqual(footer.style.width, '996px',
      'the footer must align to the combined width of the tool, image, and comment columns');
    assert.strictEqual(toolbar.style.height, base.style.height,
      'the left tool panel must match the displayed image height instead of stretching to the viewport');
    assert.strictEqual(historyPanel.style.height, base.style.height,
      'the operation history panel must match the displayed image height instead of stretching to the viewport');
    assert.strictEqual(workbench.style.height, base.style.height,
      'the workbench must collapse to the displayed image height so the footer follows the image group');
    assert.strictEqual(workbench.style.flex, '0 0 auto',
      'the fitted workbench must not grow back to the viewport height');
    const editorCss = fixture.document.getElementById(maskEditor.EDITOR_STYLE_ID)?.textContent || '';
    assert.match(editorCss, /\.image-editor-body\{[^}]*justify-content:center/, 'the fitted image group and footer must stay vertically centered');
    assert.match(editorCss, /\.image-editor-footer\{[^}]*margin-top:12px/, 'the footer must remain attached directly beneath the fitted image group');

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testEnhanceToolSubmitsTheClarityPromptWithoutAMask() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const enhanceButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '画质提升');
    assert.ok(enhanceButton, 'the editor must expose the clarity enhancement tool');
    enhanceButton.click();
    assert.strictEqual(enhanceButton.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(fixture.document.querySelector('.image-editor-overlay').style.pointerEvents, 'none',
      'clarity enhancement must keep the image read-only');

    findAction(fixture.document, '提交修改').click();
    const result = await pending;
    assert.strictEqual(result.mode, 'enhance');
    assert.strictEqual(result.prompt, maskEditor.buildEnhancePrompt());
    assert.strictEqual(result.maskBlob, undefined, 'clarity enhancement must not create a mask');
  } finally {
    fixture.dom.window.close();
  }
}

async function testCommentColorIsChosenAtPlacementTime() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const commentButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '标记评论');
    commentButton.click();

    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 4, height: 4, right: 4, bottom: 4 });
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 2, clientY: 2 }));
    const confirm = fixture.document.querySelector('.image-editor-comment-confirm');
    const pendingColor = confirm.style.backgroundColor;
    assert.ok(pendingColor, 'placing a comment must choose its marker color immediately');

    const input = fixture.document.querySelector('.image-editor-comment-popover input');
    input.value = '淡化一点';
    confirm.click();
    const cardColor = fixture.document.querySelector('.image-editor-comment-index').style.backgroundColor;
    assert.strictEqual(cardColor, pendingColor,
      'the confirmed comment card must keep the color chosen when the marker was placed');

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testMixedToolsProduceOneCompositeEdit() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const findTool = label => [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === label);
    findTool('画质提升').click();
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '1',
      'clarity enhancement must be added on the first tool click');
    findTool('画质提升').click();
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '0',
      'clicking the selected global tool again must remove its record');
    assert.strictEqual(findTool('画质提升').getAttribute('aria-pressed'), 'false');
    findTool('画质提升').click();
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '1');

    const overlay = fixture.document.querySelector('.image-editor-overlay');
    findTool('标记评论').click();
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 4, height: 4, right: 4, bottom: 4 });
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 2, clientY: 2 }));
    const commentInput = fixture.document.querySelector('.image-editor-comment-popover input');
    commentInput.value = '淡化左侧水面';
    fixture.document.querySelector('.image-editor-comment-confirm').click();

    findTool('局部擦除').click();
    const instructionInput = [...fixture.document.querySelectorAll('input')]
      .find(input => String(input.placeholder || '').includes('选中区域'));
    instructionInput.value = '去掉右上角文字';
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
    overlay.setPointerCapture = () => {};
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 20, clientY: 20 }));
    findTool('调整尺寸').click();
    [...fixture.document.querySelectorAll('.image-editor-resize-option')]
      .find(option => option.textContent.includes('横版 4:3')).click();
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '4');
    assert.deepStrictEqual(
      [...fixture.document.querySelectorAll('.image-editor-comment-card strong')].map(node => node.textContent),
      ['淡化左侧水面', '局部擦除', '画质提升', '调整尺寸'],
      'modification records must follow execution order',
    );
    const globalRecords = modificationCards(fixture.document)
      .filter(card => card.dataset.modificationType === 'operation');
    assert.strictEqual(globalRecords.length, 2);
    globalRecords.forEach(card => {
      assert.ok(card.querySelector('[data-record-action="delete"]'), 'global operations must expose a delete action');
      assert.strictEqual(card.querySelector('[data-record-action="edit"]'), null,
        'global operations must not expose an edit action');
    });

    findAction(fixture.document, '提交修改').click();
    const result = await pending;
    assert.strictEqual(result.mode, 'composite');
    assert.ok(result.maskBlob, 'local records must produce one combined mask');
    assert.strictEqual(result.background, undefined);
    assert.strictEqual(result.output_format, undefined);
    assert.strictEqual(result.size, '1536x1152');
    const localStep = result.prompt.indexOf('请先只修改编辑蒙版中的透明区域');
    const enhanceStep = result.prompt.indexOf('随后，对整张图片进行清晰度提升');
    const resizeStep = result.prompt.indexOf('4:3');
    assert.ok(localStep >= 0 && localStep < enhanceStep && enhanceStep < resizeStep,
      'the submitted prompt must follow the visible execution order');
    assert.match(result.prompt, /淡化左侧水面/);
    assert.match(result.prompt, /去掉右上角文字/);
  } finally {
    fixture.dom.window.close();
  }
}

async function testCommentRecordsCanBeEditedAndDeletedWithContinuousRenumbering() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    addComment(fixture, { x: 0.2, y: 0.2, text: '第一条评论' });
    addComment(fixture, { x: 0.4, y: 0.4, text: '第二条评论' });
    addComment(fixture, { x: 0.6, y: 0.6, text: '第三条评论' });

    const second = modificationCardByText(fixture.document, '第二条评论');
    assert.ok(second, 'the second comment record must render');
    second.querySelector('[data-record-action="edit"]').click();
    const editingCard = modificationCards(fixture.document).find(card => card.querySelector('[data-record-editor]'));
    assert.ok(editingCard, 'the edited comment card must stay in the modification list');
    const editor = editingCard.querySelector('[data-record-editor]');
    assert.ok(editor, 'editing a comment must open an inline editor');
    assert.strictEqual(editor.tagName, 'TEXTAREA', '编辑评论必须使用多行文本编辑框');
    editor.value = '   ';
    editingCard.querySelector('[data-record-save]').click();
    assert.ok(fixture.document.querySelector('[data-record-editor]'), 'an empty comment must keep the editor open');
    assert.ok(fixture.toasts.includes('评论内容不能为空'));
    editor.value = '第二条评论（已修改）';
    editingCard.querySelector('[data-record-save]').click();
    assert.ok(modificationCardByText(fixture.document, '第二条评论（已修改）'), 'saved comment text must replace the original');

    modificationCardByText(fixture.document, '第二条评论（已修改）').querySelector('[data-record-action="delete"]').click();
    assert.deepStrictEqual(
      modificationCards(fixture.document).map(card => card.querySelector('strong').textContent),
      ['第一条评论', '第三条评论'],
      'deleting a comment must remove only that record',
    );
    assert.deepStrictEqual(
      modificationCards(fixture.document).map(card => card.querySelector('.image-editor-comment-index').textContent),
      ['1', '2'],
      'remaining comments must be renumbered continuously',
    );
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '2');

    findAction(fixture.document, '提交修改').click();
    const result = await pending;
    assert.match(result.prompt, /1\. 位置 \(x=0\.200, y=0\.200\)：第一条评论/);
    assert.match(result.prompt, /2\. 位置 \(x=0\.600, y=0\.600\)：第三条评论/);
    assert.doesNotMatch(result.prompt, /第二条评论/);
    assert.doesNotMatch(result.label, /第二条评论/);
  } finally {
    fixture.dom.window.close();
  }
}

async function testGlobalOperationRecordsCanBeDeleted() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const tool = label => [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === label);
    tool('背景移除').click();
    tool('画质提升').click();
    assert.strictEqual(modificationCards(fixture.document).length, 2);

    tool('画质提升').click();
    assert.strictEqual(modificationCards(fixture.document).length, 1);
    assert.strictEqual(tool('画质提升').getAttribute('aria-pressed'), 'false');
    tool('画质提升').click();
    assert.strictEqual(tool('画质提升').getAttribute('aria-pressed'), 'true');

    tool('背景移除').click();
    assert.strictEqual(modificationCards(fixture.document).length, 1);
    assert.strictEqual(tool('背景移除').getAttribute('aria-pressed'), 'false');
    tool('背景移除').click();
    assert.strictEqual(tool('背景移除').getAttribute('aria-pressed'), 'true');
    assert.strictEqual(modificationCards(fixture.document).length, 2);

    modificationCardByText(fixture.document, '移除背景').querySelector('[data-record-action="delete"]').click();
    assert.deepStrictEqual(
      modificationCards(fixture.document).map(card => card.querySelector('strong').textContent),
      ['画质提升'],
      'deleting remove-background must remove only that global operation',
    );
    assert.strictEqual(tool('背景移除').getAttribute('aria-pressed'), 'false');
    assert.strictEqual(tool('画质提升').getAttribute('aria-pressed'), 'true');

    modificationCardByText(fixture.document, '画质提升').querySelector('[data-record-action="delete"]').click();
    assert.strictEqual(modificationCards(fixture.document).length, 0);
    assert.strictEqual(tool('背景移除').getAttribute('aria-pressed'), 'false');
    assert.strictEqual(tool('画质提升').getAttribute('aria-pressed'), 'false');
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '0');
    assert.ok(fixture.document.querySelector('.image-editor-comment-empty'));

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testEraseRecordsCanBeDeleted() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const eraseButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '局部擦除');
    eraseButton.click();
    const instructionInput = [...fixture.document.querySelectorAll('input')]
      .find(input => String(input.placeholder || '').includes('选中区域'));
    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
    overlay.setPointerCapture = () => {};
    const paint = (x, y) => {
      overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
      overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerup', { bubbles: true, clientX: x, clientY: y }));
    };

    instructionInput.value = '去掉第一处文字';
    paint(20, 20);
    instructionInput.value = '淡化第二处水面';
    paint(70, 70);
    assert.strictEqual(modificationCards(fixture.document).length, 2);

    const first = modificationCardByText(fixture.document, '去掉第一处文字');
    assert.strictEqual(first.querySelector('[data-record-action="edit"]'), null,
      'erase records do not expose an edit action');

    const overlayContext = overlay.__context;
    overlayContext.arcCalls.length = 0;
    first.querySelector('[data-record-action="delete"]').click();
    assert.strictEqual(overlayContext.arcCalls.length, 1,
      'deleting an erase record must remove exactly its painted strokes');
    assert.deepStrictEqual(
      modificationCards(fixture.document).map(card => card.querySelector('p').textContent),
      ['淡化第二处水面'],
      'deleting an erase record must remove its instruction with its strokes',
    );
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-count').textContent, '1');

    findAction(fixture.document, '提交修改').click();
    const result = await pending;
    assert.strictEqual(result.mode, 'erase');
    assert.match(result.prompt, /淡化第二处水面/);
    assert.doesNotMatch(result.prompt, /去掉第一处文字/);
  } finally {
    fixture.dom.window.close();
  }
}

async function testRecordThumbnailsSampleSmallWindowAroundTheMarkerAndStrokeCenter() {
  const fixture = createEditorFixture({ width: 1000, height: 800 });
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'scene.png' });
    await tick();
    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
    const assertCrop = (call, { centerX, centerY, label }) => {
      const [, sourceX, sourceY, cropWidth, cropHeight, destX, destY, destWidth, destHeight] = call;
      const close = (left, right) => Math.abs(left - right) < 1e-6;
      assert.ok(close(cropWidth, 120) && close(cropHeight, 90),
        `${label}的局部截图必须使用 120x90 的小窗口（短边 15%），不能放大到笔迹外接框`);
      assert.ok(close(sourceX + cropWidth / 2, centerX) && close(sourceY + cropHeight / 2, centerY),
        `${label}的局部截图必须以标记中心为中心取样`);
      assert.deepStrictEqual([destX, destY, destWidth, destHeight], [0, 0, 120, 90],
        `${label}的局部截图必须绘制到 120x90 的缩略图画布`);
    };

    const commentButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '标记评论');
    commentButton.click();
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 70, clientY: 40 }));
    const commentInput = fixture.document.querySelector('.image-editor-comment-popover input');
    commentInput.value = '木牌文字需要修改';
    fixture.document.querySelector('.image-editor-comment-confirm').click();

    const commentCrops = recordThumbnailCrops(fixture);
    assert.strictEqual(commentCrops.length, 1, '每条评论必须只生成一张局部截图');
    assertCrop(commentCrops[0], { centerX: 700, centerY: 320, label: '评论' });

    const eraseButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '局部擦除');
    eraseButton.click();
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 60 }));
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 30, clientY: 60 }));

    const eraseCrops = recordThumbnailCrops(fixture);
    assert.strictEqual(eraseCrops.length, 2, '每次完成涂抹必须只新增一张局部截图');
    assertCrop(eraseCrops[1], { centerX: 300, centerY: 480, label: '擦除' });

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testCommentEditorKeepsTheOriginalTextSizeAndSupportsMultipleLines() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    addComment(fixture, { x: 0.3, y: 0.3, text: '木牌文字需要修改' });

    const card = modificationCardByText(fixture.document, '木牌文字需要修改');
    const copy = card.querySelector('.image-editor-comment-copy');
    copy.getBoundingClientRect = () => ({ width: 232, height: 74, top: 0, left: 0, right: 232, bottom: 74 });
    card.querySelector('[data-record-action="edit"]').click();

    const editor = fixture.document.querySelector('[data-record-editor]');
    assert.strictEqual(editor.tagName, 'TEXTAREA', '编辑评论必须使用多行文本编辑框');
    assert.strictEqual(editor.style.width, '232px', '编辑框宽度必须与原文字块一致');
    const compactHeight = Number.parseFloat(editor.style.height) || 0;
    assert.ok(compactHeight > 0 && compactHeight <= 44,
      '单行评论编辑框必须保持紧凑，不能继承缩略图或网格拉伸出的高度');
    assert.strictEqual(editor.value, '木牌文字需要修改', '编辑框必须带出原评论文字');
    assert.strictEqual(editor.style.overflowY, 'auto',
      '编辑框必须始终允许内容超出最大高度后内部滚动');
    const editorCss = fixture.document.getElementById(maskEditor.EDITOR_STYLE_ID)?.textContent || '';
    assert.match(editorCss, /\.image-editor-record-editor\{[^}]*resize:none/, '编辑框不得显示粗糙的手动缩放柄');
    assert.match(editorCss, /\.image-editor-record-editor\{[^}]*max-height:160px/, '编辑框高度必须受控并随内容增长');
    assert.match(editorCss, /\.image-editor-record-editor\{[^}]*overscroll-behavior:contain/, '编辑框滚动不得带动外层记录列表');

    const newlineKey = new fixture.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    editor.dispatchEvent(newlineKey);
    assert.strictEqual(newlineKey.defaultPrevented, false, '多行编辑时 Enter 必须换行而不是提交');
    assert.ok(fixture.document.querySelector('[data-record-editor]'), 'Enter 不能结束编辑');

    editor.value = '木牌文字需要修改\n第二行补充说明\n第三行继续说明\n第四行最后说明';
    editor.dispatchEvent(new fixture.dom.window.Event('input', { bubbles: true }));
    const grownHeight = Number.parseFloat(editor.style.height) || 0;
    assert.ok(grownHeight > compactHeight,
      '多行评论编辑框必须随内容自动增长，而不是始终使用固定空白高度');
    const saveKey = new fixture.dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    editor.dispatchEvent(saveKey);
    assert.strictEqual(saveKey.defaultPrevented, true, 'Ctrl+Enter 必须提交保存');

    const updated = modificationCardByText(fixture.document, '第二行补充说明');
    assert.ok(updated, '多行评论必须按换行拆成标题和说明渲染');
    assert.strictEqual(updated.querySelector('strong').textContent, '木牌文字需要修改');
    assert.match(updated.querySelector('p').textContent, /第二行补充说明/);

    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}


async function testEraseInstructionRowIsVisibleOnlyForEraseMode() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const tool = label => [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === label);
    const instruction = [...fixture.document.querySelectorAll('.image-editor-row')][0];
    assert.ok(instruction, 'erase instruction row must exist');
    assert.strictEqual(instruction.classList.contains('active'), false);
    tool('局部擦除').click();
    assert.strictEqual(instruction.classList.contains('active'), true,
      'the erase instruction row must be visible while erasing');
    tool('标记评论').click();
    assert.strictEqual(instruction.classList.contains('active'), false,
      'the erase instruction row must hide outside erase mode');
    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testPortraitImageFitsTheNarrowCanvasViewport() {
  const fixture = createEditorFixture({ width: 600, height: 1200 }, { width: 390, height: 844 });
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const canvas = fixture.document.querySelector('.image-editor-canvas');
    const base = fixture.document.querySelector('.image-editor-base');
    const editorStyle = fixture.document.getElementById(maskEditor.EDITOR_STYLE_ID);
    assert.match(editorStyle.textContent, /@media \(max-width:700px\)\{[\s\S]*\.image-editor-footer-actions\{display:grid/,
      'mobile footer actions must use a wrapping grid instead of overflowing horizontally');
    const canvasHeight = Number.parseFloat(canvas.style.height) || 420;
    const renderedHeight = Number.parseFloat(base.style.height) || 0;
    assert.ok(renderedHeight <= canvasHeight - 8,
      'a portrait image must be scaled to the mobile canvas instead of being clipped');
    assert.strictEqual(fixture.document.querySelector('.image-editor-toolbar').style.height, '',
      'the mobile stacked toolbar must keep its natural height');
    assert.strictEqual(fixture.document.querySelector('.image-editor-comment-panel').style.height, '',
      'the mobile operation history panel must keep its natural height');
    assert.strictEqual(fixture.document.querySelector('.image-editor-workbench').style.height, '',
      'the mobile workbench must keep its natural content height');
    assert.strictEqual(fixture.document.querySelector('.image-editor-workbench').style.flex, '',
      'the mobile workbench must restore its stylesheet flex behavior');
    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

async function testEditingCommentDraftSurvivesRerenderAndIsApplied() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    addComment(fixture, { x: 0.3, y: 0.3, text: '原始评论' });
    const card = modificationCardByText(fixture.document, '原始评论');
    card.querySelector('[data-record-action="edit"]').click();
    const editor = fixture.document.querySelector('[data-record-editor]');
    editor.value = '草稿评论';
    editor.dispatchEvent(new fixture.dom.window.Event('input', { bubbles: true }));
    [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '画质提升').click();
    assert.strictEqual(fixture.document.querySelector('[data-record-editor]').value, '草稿评论',
      'a rerender must preserve the in-progress comment draft');
    findAction(fixture.document, '提交修改').click();
    const result = await pending;
    assert.match(result.label, /草稿评论/,
      'applying while editing must persist the visible draft instead of stale text');
  } finally {
    fixture.dom.window.close();
  }
}

async function testComposingEnterDoesNotConfirmCommentOrCloseEditor() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const commentButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '标记评论');
    commentButton.click();
    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }));
    const input = fixture.document.querySelector('.image-editor-comment-popover input');
    input.value = '中文输入';
    const composingEnter = new fixture.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(composingEnter, 'isComposing', { value: true });
    input.dispatchEvent(composingEnter);
    assert.ok(fixture.document.querySelector('.image-editor-comment-popover.active'),
      'IME composition Enter must not confirm a comment');
    fixture.document.querySelector('.image-editor-comment-cancel').click();
    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}


async function testEditorRejectsOverlongEditTextInsteadOfSilentlyTruncating() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), {});
    await tick();
    const commentButton = [...fixture.document.querySelectorAll('.image-editor-tool')]
      .find(button => String(button.textContent || '').trim() === '标记评论');
    commentButton.click();
    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }));
    const commentInput = fixture.document.querySelector('.image-editor-comment-popover input');
    commentInput.value = 'x'.repeat(1001);
    fixture.document.querySelector('.image-editor-comment-confirm').click();
    assert.strictEqual(modificationCards(fixture.document).length, 0,
      'an overlong comment must be rejected, not truncated into a different instruction');
    assert.ok(fixture.toasts.some(message => message.includes('不能超过')));
    fixture.document.querySelector('.image-editor-comment-cancel').click();
    findAction(fixture.document, '取消编辑').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

module.exports = [
  testEditorOpensNeutralAndRequiresAToolBeforeApplying,
  testUndoRemovesOneWholeEraseStrokeGesture,
  testResetClearsAllEditsAndReturnsToInitialState,
  testEraseToolBuildsTheSelectedAreaInstructionPrompt,
  testCommentToolCollectsNumberedCommentsAndSendsThemAsTheUserMessage,
  testCommentPanelRendersNumberedCardsAndCount,
  testCommentColorIsChosenAtPlacementTime,
  testDefaultCanvasUsesAFitWindowWithoutScrolling,
  testEnhanceToolSubmitsTheClarityPromptWithoutAMask,
  testRemoveBackgroundCannotMixWithOtherOperations,
  testMixedToolsProduceOneCompositeEdit,
  testRemoveBackgroundToolUsesTheChatGptPrompt,
  testResizeMenuAddsTheSelectedAspectRatioAndSubmitsIt,
  testResizeSelectionCanBeReplacedAndDeleted,
  testResizeCannotMixWithRemoveBackground,
  testCommentRecordsCanBeEditedAndDeletedWithContinuousRenumbering,
  testGlobalOperationRecordsCanBeDeleted,
  testEraseRecordsCanBeDeleted,
  testRecordThumbnailsSampleSmallWindowAroundTheMarkerAndStrokeCenter,
  testCommentEditorKeepsTheOriginalTextSizeAndSupportsMultipleLines,
  testEraseInstructionRowIsVisibleOnlyForEraseMode,
  testPortraitImageFitsTheNarrowCanvasViewport,
  testEditingCommentDraftSurvivesRerenderAndIsApplied,
  testComposingEnterDoesNotConfirmCommentOrCloseEditor,
  testEditorRejectsOverlongEditTextInsteadOfSilentlyTruncating,
];
