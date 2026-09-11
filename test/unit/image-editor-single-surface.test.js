'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const maskEditor = require('../../client/features/image-editor/mask-editor');

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function createEditorFixture() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const { window } = dom;
  const { document } = window;
  const originalCreateElement = document.createElement.bind(document);
  document.createElement = function createElement(tag, ...rest) {
    const node = originalCreateElement(tag, ...rest);
    if (String(tag).toLowerCase() === 'canvas') {
      node.getContext = () => {
        if (!node.__context) {
          node.__context = {
            arcCalls: [],
            clearRect() {}, beginPath() {},
            arc(x, y, radius) { this.arcCalls.push([x, y, radius]); },
            fill() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {}, drawImage() {}, fillText() {},
          };
        }
        return node.__context;
      };
      node.toBlob = callback => callback(new window.Blob(['mask'], { type: 'image/png' }));
    }
    return node;
  };
  const toasts = [];
  class FakeImage {
    constructor() {
      this.naturalWidth = 4;
      this.naturalHeight = 4;
      this.width = 4;
      this.height = 4;
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
  return { dom, document, editor, toasts };
}

function findAction(document, label) {
  return [...document.querySelectorAll('.image-editor-action')].find(button => String(button.textContent || '').trim() === label);
}

async function testEditorOpensNeutralAndRequiresAToolBeforeApplying() {
  const fixture = createEditorFixture();
  try {
    const pending = fixture.editor.open(new fixture.dom.window.Blob(['x'], { type: 'image/png' }), { filename: 'image.png' });
    await tick();
    const toolbar = fixture.document.querySelector('.image-editor-toolbar');
    assert.ok(toolbar, 'the three tools must live in a centered toolbar');
    const toolButtons = [...toolbar.querySelectorAll('.image-editor-tool')];
    assert.deepStrictEqual(toolButtons.map(button => button.textContent.trim()), ['评论', '移除背景', '擦除'],
      'the annotate and resize tools must stay removed from the editor toolbar');
    toolButtons.forEach(button => assert.ok(button.querySelector('svg'), 'every toolbar tool must carry an icon'));
    const commentIcon = toolButtons.find(button => button.textContent.trim() === '评论').querySelector('svg');
    assert.ok(commentIcon.querySelector('path[d="M12 8.5v5"]') && commentIcon.querySelector('path[d="M9.5 11h5"]'),
      'the comment tool must use the bubble-plus icon');
    const footerActions = fixture.document.querySelector('.image-editor-footer-actions');
    assert.ok(footerActions, 'apply and cancel must sit together in the footer');
    assert.deepStrictEqual(
      [...footerActions.querySelectorAll('.image-editor-action')].map(button => button.textContent.trim()),
      ['应用', '取消'],
      'the footer must order apply before cancel at the right edge',
    );
    [...footerActions.querySelectorAll('.image-editor-action')].forEach(button => {
      assert.ok(button.querySelector('svg'), 'apply and cancel must carry icons');
    });
    assert.strictEqual(fixture.document.querySelector('.image-editor-header .image-editor-action'), null,
      'cancel must not stay in the header');
    const pressed = toolButtons.filter(button => button.getAttribute('aria-pressed') === 'true');
    assert.strictEqual(pressed.length, 0, 'the editor must open without preselecting a destructive tool');
    assert.match(fixture.document.querySelector('.image-editor-hint').textContent, /选择工具/);

    findAction(fixture.document, '应用').click();
    await tick();
    assert.strictEqual(fixture.toasts.at(-1), '请先选择编辑工具',
      'applying without a tool must explain that a tool is required');
    assert.ok(fixture.document.querySelector('.image-editor-backdrop').isConnected,
      'the editor must stay open when no tool is selected');

    findAction(fixture.document, '取消').click();
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
      .find(button => String(button.textContent || '').trim() === '擦除');
    assert.ok(eraseButton, 'the editor must expose the erase/select-area tool');
    eraseButton.click();

    const instructionInput = [...fixture.document.querySelectorAll('input')]
      .find(input => String(input.placeholder || '').includes('选中区域'));
    assert.ok(instructionInput, 'the erase tool must accept an area modification instruction');
    instructionInput.value = '把选区改成夜景';

    const overlay = fixture.document.querySelector('.image-editor-overlay');
    overlay.dispatchEvent(new fixture.dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 2, clientY: 2 }));
    findAction(fixture.document, '应用').click();
    const result = await pending;

    assert.strictEqual(result.mode, 'erase');
    assert.match(result.prompt, /把选区改成夜景/, 'the selected-area instruction must reach the edit prompt');
    assert.match(result.label, /把选区改成夜景/, 'the transcript label must describe the requested area edit');
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
      .find(button => String(button.textContent || '').trim() === '评论');
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

    findAction(fixture.document, '应用').click();
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
      .find(entry => String(entry.textContent || '').trim() === '移除背景');
    assert.ok(button, 'the editor must expose the remove-background tool');
    button.click();
    findAction(fixture.document, '应用').click();
    const result = await pending;
    assert.strictEqual(result.mode, 'remove_background');
    assert.strictEqual(result.background, 'transparent');
    assert.strictEqual(result.output_format, 'png');
    assert.strictEqual(result.prompt, '移除此图像的背景。保持所有前景主体不变且完整无损，边缘干净平滑。将背景设为透明。');
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
      .find(button => String(button.textContent || '').trim() === '擦除');
    eraseButton.click();
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
    findAction(fixture.document, '撤销').click();
    assert.strictEqual(overlay.__context.arcCalls.length, 0,
      'one undo must remove the whole drag gesture instead of a single sample');

    findAction(fixture.document, '取消').click();
    assert.strictEqual(await pending, null);
  } finally {
    fixture.dom.window.close();
  }
}

module.exports = [
  testEditorOpensNeutralAndRequiresAToolBeforeApplying,
  testUndoRemovesOneWholeEraseStrokeGesture,
  testEraseToolBuildsTheSelectedAreaInstructionPrompt,
  testCommentToolCollectsNumberedCommentsAndSendsThemAsTheUserMessage,
  testRemoveBackgroundToolUsesTheChatGptPrompt,
];
