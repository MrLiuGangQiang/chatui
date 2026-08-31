'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createImagePreviewWorkflow } = require('../../client/app/image-preview-workflow');
const { createImageActionsWorkflow } = require('../../client/app/image-actions-workflow');

function createEnvironment() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="imagePreview" aria-hidden="true"><div class="image-preview-mask"></div>
      <button id="imagePreviewPrevious" type="button" hidden></button>
      <button id="imagePreviewNext" type="button" hidden></button>
      <span id="imagePreviewPosition" hidden></span>
      <button id="imagePreviewDownload" type="button" hidden></button>
      <button id="imagePreviewCopy" type="button" hidden></button>
      <button id="imagePreviewClose" type="button"></button>
      <img id="imagePreviewImg" />
    </div>
    <button id="origin" type="button">origin</button>
  </body>`, { pretendToBeVisual: true });
  const revoked = [];
  const workflow = createImagePreviewWorkflow({
    document: dom.window.document,
    getElement: id => dom.window.document.getElementById(id),
    getImageBlob: async () => null,
    canWriteImageClipboard: () => true,
    imageClipboardUnsupportedMessage: () => 'unsupported',
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL: value => revoked.push(value) },
  });
  return { dom, workflow, revoked };
}

async function testImagePreviewNavigatesImagesFromTheSameCollection() {
  const { dom, workflow } = createEnvironment();
  const origin = dom.window.document.getElementById('origin');
  origin.focus();
  await workflow.openImagePreview('data:image/png;base64,one', 'one.png', {
    items: [
      { source: 'data:image/png;base64,one', filename: 'one.png' },
      { source: 'data:image/png;base64,two', filename: 'two.png' },
      { source: 'data:image/png;base64,three', filename: 'three.png' },
    ],
    index: 0,
  });
  const preview = dom.window.document.getElementById('imagePreview');
  const image = dom.window.document.getElementById('imagePreviewImg');
  const previous = dom.window.document.getElementById('imagePreviewPrevious');
  const next = dom.window.document.getElementById('imagePreviewNext');
  const position = dom.window.document.getElementById('imagePreviewPosition');
  assert.strictEqual(preview.classList.contains('show'), true);
  assert.strictEqual(image.dataset.filename, 'one.png');
  assert.strictEqual(position.textContent, '1 / 3');
  assert.strictEqual(previous.disabled, true);
  assert.strictEqual(next.disabled, false);

  await workflow.navigateImagePreview(1);
  assert.strictEqual(image.dataset.persistedSrc, 'data:image/png;base64,two');
  assert.strictEqual(image.dataset.filename, 'two.png');
  assert.strictEqual(position.textContent, '2 / 3');
  assert.strictEqual(previous.disabled, false);

  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(image.dataset.persistedSrc, 'data:image/png;base64,three');
  assert.strictEqual(position.textContent, '3 / 3');
  assert.strictEqual(next.disabled, true);

  await workflow.navigateImagePreview(1);
  assert.strictEqual(image.dataset.persistedSrc, 'data:image/png;base64,three', 'next must stop at the last image');
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(image.dataset.persistedSrc, 'data:image/png;base64,two');
}

function testMessagePreviewPassesAllMessageImagesAndSelectedPosition() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="messages">
      <article class="message assistant"><div class="content">
        <img id="first" data-persisted-src="indexeddb://first" data-filename="first.png" />
      </div></article>
      <article class="message user"><div class="content">
        <img id="second" data-persisted-src="indexeddb://second" data-filename="second.png" />
        <img class="clarification-choice-image" data-persisted-src="indexeddb://excluded" />
      </div></article>
    </div>
  </body>`);
  const calls = [];
  const workflow = createImageActionsWorkflow({
    document: dom.window.document,
    window: dom.window,
    navigator: {},
    openImagePreview: (...args) => calls.push(args),
    escapeAttr: value => String(value),
  });
  const message = dom.window.document.getElementById('messages');
  workflow.bindImagePreview(message);
  dom.window.document.getElementById('second').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(calls.length, 1);
  const [source, filename, options] = calls[0];
  assert.strictEqual(source, 'indexeddb://second');
  assert.strictEqual(filename, 'second.png');
  assert.strictEqual(options.index, 1, 'opening the second image must retain its collection index');
  assert.deepStrictEqual(options.items.map(item => item.source), ['indexeddb://first', 'indexeddb://second'], 'preview navigation must include images from adjacent messages');
}

async function testClosingPreviewClearsNavigationState() {
  const { dom, workflow } = createEnvironment();
  await workflow.openImagePreview('data:image/png;base64,one', 'one.png', {
    items: [
      { source: 'data:image/png;base64,one', filename: 'one.png' },
      { source: 'data:image/png;base64,two', filename: 'two.png' },
    ],
  });
  workflow.closeImagePreview();
  const preview = dom.window.document.getElementById('imagePreview');
  const previous = dom.window.document.getElementById('imagePreviewPrevious');
  const next = dom.window.document.getElementById('imagePreviewNext');
  assert.strictEqual(preview.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(previous.hidden, true);
  assert.strictEqual(next.hidden, true);
  assert.strictEqual(dom.window.document.getElementById('imagePreviewImg').getAttribute('src'), null);
}

module.exports = [
  testImagePreviewNavigatesImagesFromTheSameCollection,
  testMessagePreviewPassesAllMessageImagesAndSelectedPosition,
  testClosingPreviewClearsNavigationState,
];

