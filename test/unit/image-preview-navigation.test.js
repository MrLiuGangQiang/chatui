'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createImagePreviewWorkflow } = require('../../client/app/image-preview-workflow');
const { createImageActionsWorkflow } = require('../../client/app/image-actions-workflow');

function createEnvironment({ openImageEdit = null } = {}) {
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
  const editCalls = [];
  const workflow = createImagePreviewWorkflow({
    document: dom.window.document,
    getElement: id => dom.window.document.getElementById(id),
    getImageBlob: async () => null,
    canWriteImageClipboard: () => true,
    imageClipboardUnsupportedMessage: () => 'unsupported',
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL: value => revoked.push(value) },
    openImageEdit: openImageEdit || (options => { editCalls.push(options); }),
  });
  return { dom, workflow, revoked, editCalls };
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
  assert.notStrictEqual(dom.window.document.activeElement?.id, 'imagePreviewClose', 'opening preview must not select an action button');
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

async function testPreviewEditEntryReusesTheImageEditButtonAndOpensEditor() {
  const { dom, workflow, editCalls } = createEnvironment();
  assert.strictEqual(dom.window.document.getElementById('imagePreviewEdit'), null,
    'the preview edit entry is created lazily with the first image');
  await workflow.openImagePreview('data:image/png;base64,one', 'one.png');
  const button = dom.window.document.getElementById('imagePreviewEdit');
  assert.ok(button, 'the preview must expose an edit entry');
  assert.ok(button.classList.contains('image-preview-action'), 'the preview edit entry must match the download/copy/close shell');
  assert.ok(button.classList.contains('image-preview-edit'), 'the preview entry must carry its positioning class');
  assert.ok(!button.classList.contains('image-edit-entry'),
    'the preview entry must not reuse the smaller transcript chip');
  assert.strictEqual(button.hidden, false, 'the edit entry must be visible with the previewed image');
  assert.ok(dom.window.document.getElementById('chatui-image-edit-style'),
    'the preview edit entry must reuse the shared edit entry style module');
  assert.strictEqual(button.querySelectorAll('path').length, 2,
    'the preview entry must keep the pencil plus wavy line icon');
  assert.strictEqual(button.querySelectorAll('stop').length, 0,
    'the preview entry must use the white preview-action icon style, not the colorful chip');
  button.click();
  assert.strictEqual(editCalls.length, 1, 'clicking the preview edit entry must open the editor');
  assert.strictEqual(editCalls[0].image, dom.window.document.getElementById('imagePreviewImg'));
  assert.strictEqual(editCalls[0].button, button);
  assert.strictEqual(dom.window.document.getElementById('imagePreview').classList.contains('show'), false,
    'entering the editor from the preview must close the preview surface');
  assert.strictEqual(button.hidden, true, 'closing the preview must hide the edit entry');
  await workflow.openImagePreview('data:image/png;base64,two', 'two.png');
  assert.strictEqual(dom.window.document.getElementById('imagePreviewEdit'), button,
    'reopening the preview must reuse the same edit entry');
}

async function testPreviewEditButtonRecoversWhenOpeningThrowsSynchronously() {
  const { dom, workflow } = createEnvironment({
    openImageEdit: () => { throw new Error('synchronous open failure'); },
  });
  await workflow.openImagePreview('data:image/png;base64,one', 'one.png');
  const button = dom.window.document.getElementById('imagePreviewEdit');
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(button.disabled, false, 'a synchronous open failure must not strand the button disabled');
  assert.strictEqual(dom.window.document.getElementById('imagePreview').classList.contains('show'), false,
    'a failed open attempt must still close the transient preview surface');
}

async function testPreviewEditButtonRecoversFromInterruptedBusyState() {
  const { dom, workflow, editCalls } = createEnvironment();
  await workflow.openImagePreview('data:image/png;base64,one', 'one.png');
  const button = dom.window.document.getElementById('imagePreviewEdit');
  button.disabled = true;
  button.classList.add('downloading', 'is-disabled');
  await workflow.navigateImagePreview(0);
  assert.strictEqual(button.disabled, false,
    'showing the preview again must clear a stale disabled state left by an interrupted edit');
  assert.strictEqual(button.classList.contains('downloading'), false);
  assert.strictEqual(button.classList.contains('is-disabled'), false);

  button.classList.add('busy');
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(editCalls.length, 1, 'the recovered button must still open the editor');
  assert.strictEqual(button.disabled, false, 'the button must be restored after the edit open flow settles');
  assert.strictEqual(button.classList.contains('busy'), false);
}

function testPreviewEditWiringReusesTheSharedEntryAndActionsWorkflow() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(!app.includes('createImageEditEntry:'),
    'the preview workflow must resolve the shared entry module itself');
  assert.ok(app.includes('openImageEdit:options=>getImageActionsWorkflow().openImageEditorForElement(options.image,{button:options.button})'),
    'the preview must reuse the transcript edit open flow');
  assert.ok(index.includes('client/ui/image-edit-entry.js?v=1.0.0-frosted-circle')
    && index.includes('image-actions-workflow.js?v=1.2.84-action-lifecycle')
    && index.includes('image-preview-workflow.js?v=1.2.73-preview-edit-sync-guard'),
  'the shared edit entry must ship as its own module with refreshed asset revisions');
}

module.exports = [
  testImagePreviewNavigatesImagesFromTheSameCollection,
  testMessagePreviewPassesAllMessageImagesAndSelectedPosition,
  testClosingPreviewClearsNavigationState,
  testPreviewEditEntryReusesTheImageEditButtonAndOpensEditor,
  testPreviewEditButtonRecoversWhenOpeningThrowsSynchronously,
  testPreviewEditButtonRecoversFromInterruptedBusyState,
  testPreviewEditWiringReusesTheSharedEntryAndActionsWorkflow,
];

