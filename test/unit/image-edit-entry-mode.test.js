'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createImageActionsWorkflow } = require('../../client/app/image-actions-workflow');
const imageEditEntry = require('../../client/ui/image-edit-entry');

function createFixture({ editorResult = null, images = null } = {}) {
  const imageItems = (Array.isArray(images) && images.length
    ? images
    : [{ src: 'blob:image-1', persisted: 'indexeddb://image-1', filename: 'image-1.png', alt: '第 1 张生成图片' }]
  ).map((item, index) => {
    const src = item.src || `blob:image-${index + 1}`;
    const persisted = item.persisted || `indexeddb://image-${index + 1}`;
    const filename = item.filename || `image-${index + 1}.png`;
    const alt = item.alt || `第 ${index + 1} 张生成图片`;
    return `<div class="generated-image-item"><img class="generated-thumb" src="${src}" data-persisted-src="${persisted}" data-filename="${filename}" alt="${alt}" /></div>`;
  }).join('');
  const dom = new JSDOM(`
    <main id="messages">
      <article class="message assistant">
        <div class="avatar"></div>
        <div class="bubble-wrap">
          <div class="bubble"><div class="content markdown-body">
            <div class="generated-image-grid">${imageItems}</div>
          </div></div>
          <div class="msg-actions"><button class="copy-btn"></button><button class="refresh-btn"></button></div>
        </div>
      </article>
    </main>
  `);
  const document = dom.window.document;
  const opened = [];
  const applyCalls = [];
  const workflow = createImageActionsWorkflow({
    document,
    window: dom.window,
    navigator: dom.window.navigator,
    URL: dom.window.URL,
    Image: dom.window.Image,
    fetch: async () => { throw new Error('unexpected fetch'); },
    getImageBlob: async () => new dom.window.Blob(['image-bytes'], { type: 'image/png' }),
    toast: () => {},
    resetActionButtonState: () => {},
    markActionButtonBusy: () => {},
    restoreActionButtonSoon: () => {},
    openImagePreview: () => {},
    escapeAttr: value => String(value),
    getImageEditor: () => ({
      open: async (_blob, options = {}) => {
        opened.push({ tool: String(options.tool || ''), filename: String(options.filename || '') });
        return editorResult;
      },
    }),
    applyImageEdit: async payload => { applyCalls.push(payload); },
  });
  return { dom, document, workflow, opened, applyCalls };
}

function testEditEntryStaysVisibleAndDoesNotInsertInlineControls() {
  const fixture = createFixture();
  try {
    const message = fixture.document.querySelector('.message');
    fixture.workflow.moveImageActionsToMessageActions(message);
    const content = message.querySelector('.content');
    const entry = content.querySelector('[data-image-edit-entry]');

    assert.ok(entry, 'the generated image must expose an edit entry button');
    assert.strictEqual(entry.parentElement, content.querySelector('.generated-image-item'),
      'the edit entry must sit on the image itself');
    assert.strictEqual(fixture.dom.window.getComputedStyle(entry).opacity, '1',
      'the edit entry must stay visible without hover');
    assert.strictEqual(content.querySelector('[data-image-edit-toolbar]'), null,
      'no tool strip may be inserted into the transcript');
    assert.strictEqual(fixture.document.querySelector('[data-image-edit-overlay]'), null,
      'no intermediate overlay may exist before the entry is used');
  } finally {
    fixture.dom.window.close();
  }
}

async function testEditEntryOpensTheSingleSurfaceEditorDirectly() {
  const fixture = createFixture();
  try {
    const message = fixture.document.querySelector('.message');
    fixture.workflow.moveImageActionsToMessageActions(message);
    message.querySelector('[data-image-edit-entry]').click();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepStrictEqual(fixture.opened, [{ tool: '', filename: 'image-1.png' }],
      'the entry must open the image editor directly without preselecting a destructive tool');
    assert.strictEqual(fixture.document.querySelector('[data-image-edit-overlay]'), null,
      'the editor must be the only fullscreen surface');
    assert.strictEqual(fixture.applyCalls.length, 0, 'opening the editor must not dispatch an edit');
  } finally {
    fixture.dom.window.close();
  }
}

async function testEditEntryAppliesTheEditorResultThroughTheImageWorkflow() {
  const edit = { mode: 'comment', maskBlob: { type: 'image/png' }, prompt: 'Use the comment mask.' };
  const fixture = createFixture({ editorResult: edit });
  try {
    const message = fixture.document.querySelector('.message');
    fixture.workflow.moveImageActionsToMessageActions(message);
    message.querySelector('[data-image-edit-entry]').click();
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(fixture.applyCalls.length, 1, 'the editor result must dispatch through the existing image workflow');
    assert.deepStrictEqual(fixture.applyCalls[0].edit, edit);
  } finally {
    fixture.dom.window.close();
  }
}

async function testEditEntryCancelDoesNotDispatchAnEdit() {
  const fixture = createFixture();
  try {
    const message = fixture.document.querySelector('.message');
    fixture.workflow.moveImageActionsToMessageActions(message);
    const entry = message.querySelector('[data-image-edit-entry]');
    entry.click();
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(fixture.applyCalls.length, 0, 'cancelling the editor must not dispatch an edit');
    assert.ok(entry.isConnected, 'the persistent edit entry must stay on the image after closing the editor');
  } finally {
    fixture.dom.window.close();
  }
}

function testEditEntryUsesColorfulPencilAndWavyLine() {
  const fixture = createFixture();
  try {
    const message = fixture.document.querySelector('.message');
    fixture.workflow.moveImageActionsToMessageActions(message);
    const entry = message.querySelector('[data-image-edit-entry]');
    const style = fixture.document.getElementById('chatui-image-edit-style');
    assert.ok(entry && style, 'the edit entry and its style must exist');
    const css = String(style.textContent || '');
    assert.match(css, /\.image-edit-entry\{[^}]*width:26px;height:26px/,
      'the edit entry must stay a small circle');
    assert.match(css, /\.image-edit-entry\{[^}]*border:none/,
      'the frosted circle must not draw a border');
    assert.match(css, /\.image-edit-entry\{[^}]*border-radius:999px/,
      'the edit entry must be circular');
    assert.match(css, /\.image-edit-entry\{[^}]*background:rgba\(255,255,255/,
      'the edit entry must use a frosted glass background');
    assert.match(css, /\.image-edit-entry\{[^}]*backdrop-filter:blur\(12px\)/,
      'the edit entry must frost the image behind it');
    const svg = entry.querySelector('svg');
    assert.ok(svg, 'the edit entry must render an icon');
    const gradientStrokes = [...svg.querySelectorAll('path[stroke^="url("]')];
    assert.ok(gradientStrokes.length >= 2, 'both the pencil and the wavy line must use the gradient');
    const squiggle = gradientStrokes.find(path => String(path.getAttribute('d') || '').includes('21.5'));
    assert.ok(squiggle, 'the icon must include a wavy underline');
    assert.strictEqual(squiggle.getAttribute('fill'), 'none');
    assert.ok(gradientStrokes.some(path => String(path.getAttribute('fill') || '').startsWith('url(')),
      'the pencil must be filled with the colorful gradient');
    const stops = [...svg.querySelectorAll('stop')].map(stop => stop.getAttribute('stop-color'));
    assert.ok(new Set(stops).size >= 3, 'the pencil must combine at least three colors');
  } finally {
    fixture.dom.window.close();
  }
}

function testSharedImageEditEntryFactoryServesTranscriptAndPreview() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  try {
    const transcript = imageEditEntry.createImageEditEntryButton(dom.window.document);
    const preview = imageEditEntry.createImageEditEntryButton(dom.window.document, { variant: 'preview' });
    assert.ok(transcript.classList.contains('image-edit-entry'));
    assert.strictEqual(transcript.querySelectorAll('stop').length, 4,
      'the transcript variant must keep the colorful pencil icon');
    assert.ok(preview.classList.contains('image-preview-action'));
    assert.ok(preview.classList.contains('image-preview-edit'));
    assert.ok(!preview.classList.contains('image-edit-entry'),
      'the preview variant must not reuse the transcript chip');
    assert.strictEqual(preview.querySelectorAll('stop').length, 0);
    assert.strictEqual(preview.querySelectorAll('path').length, 2,
      'the preview variant must keep the white pencil plus wavy line icon');
    const style = dom.window.document.getElementById('chatui-image-edit-style');
    assert.ok(style, 'the shared factory must inject its own style');
    assert.ok(style.textContent.includes('.image-preview-edit{right:140px}'));
    imageEditEntry.ensureImageEditStyle(dom.window.document);
    assert.strictEqual(dom.window.document.querySelectorAll('#chatui-image-edit-style').length, 1,
      'style injection must stay idempotent');
  } finally {
    dom.window.close();
  }
}

async function testEachGeneratedImageOwnsItsEditEntry() {
  const fixture = createFixture({
    images: [
      { src: 'blob:image-1', persisted: 'indexeddb://image-1', filename: 'image-1.png' },
      { src: 'blob:image-2', persisted: 'indexeddb://image-2', filename: 'image-2.png' },
    ],
  });
  try {
    const message = fixture.document.querySelector('.message');
    fixture.workflow.moveImageActionsToMessageActions(message);
    const items = [...message.querySelectorAll('.generated-image-item')];
    assert.strictEqual(items.length, 2);
    assert.deepStrictEqual(
      items.map(item => item.querySelectorAll('[data-image-edit-entry]').length),
      [1, 1],
      'every generated image must own its own edit entry',
    );
    items[0].querySelector('[data-image-edit-entry]').click();
    await new Promise(resolve => setImmediate(resolve));
    items[1].querySelector('[data-image-edit-entry]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(
      fixture.opened.map(entry => entry.filename),
      ['image-1.png', 'image-2.png'],
      'each edit entry must open the image it belongs to',
    );
  } finally {
    fixture.dom.window.close();
  }
}

module.exports = [
  testEditEntryStaysVisibleAndDoesNotInsertInlineControls,
  testEachGeneratedImageOwnsItsEditEntry,
  testSharedImageEditEntryFactoryServesTranscriptAndPreview,
  testEditEntryUsesColorfulPencilAndWavyLine,
  testEditEntryOpensTheSingleSurfaceEditorDirectly,
  testEditEntryAppliesTheEditorResultThroughTheImageWorkflow,
  testEditEntryCancelDoesNotDispatchAnEdit,
];
