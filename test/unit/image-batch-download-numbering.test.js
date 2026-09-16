'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const fileNames = require('../../shared/file-names');
const imageActionsWorkflow = require('../../client/app/image-actions-workflow');

function createFixture(imageCount) {
  const dom = new JSDOM('<main id="messages"></main>');
  const { window } = dom;
  const document = window.document;
  window.ChatUIFileNames = fileNames;
  const thumbs = Array.from({ length: imageCount }, (_, i) =>
    `<img class="generated-thumb" data-persisted-src="indexeddb://image-${i + 1}" data-filename="pic.png" src="blob:live" />`).join('');
  const node = document.createElement('article');
  node.className = 'message assistant';
  node.innerHTML = `<div class="bubble"><div class="content">${thumbs}</div></div><div class="msg-actions"></div>`;
  document.getElementById('messages').appendChild(node);
  window.URL.createObjectURL = () => 'blob:mock-download';
  window.URL.revokeObjectURL = () => {};
  const downloads = [];
  const originalClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function patchedClick() {
    if (this.hasAttribute('download')) downloads.push(this.download);
    else return originalClick.apply(this, arguments);
  };
  const workflow = imageActionsWorkflow.createImageActionsWorkflow({
    document,
    window,
    navigator: window.navigator,
    ClipboardItem: window.ClipboardItem,
    File: window.File,
    Image: window.Image,
    URL: window.URL,
    fetch: async () => { throw new Error('unexpected fetch'); },
    getImageBlob: async () => new window.Blob(['x'], { type: 'image/png' }),
    toast: () => {},
    resetActionButtonState: () => {},
    markActionButtonBusy: () => {},
    restoreActionButtonSoon: () => {},
    openImagePreview: () => {},
    escapeAttr: value => String(value),
    getImageEditor: () => ({ open: async () => null }),
    applyImageEdit: async () => {},
    reconcileMessageActions: () => {},
  });
  return { dom, downloads, node, workflow, restore: () => { window.HTMLAnchorElement.prototype.click = originalClick; } };
}

async function testMultiImageBatchDownloadNumbersEveryFile() {
  const fixture = createFixture(3);
  try {
    await fixture.workflow.downloadAllImagesFromMessage(fixture.node);
    assert.strictEqual(fixture.downloads.length, 3, 'every generated image must be downloaded');
    const stamps = fixture.downloads.map(name => name.match(/^(\d{14})-(\d)\.png$/));
    assert.ok(stamps.every(Boolean), `multi-image files must be numbered N.png under one shared timestamp, got ${fixture.downloads.join(', ')}`);
    const prefixes = new Set(stamps.map(match => match[1]));
    assert.strictEqual(prefixes.size, 1, 'the whole batch must share one timestamp so ordering is stable');
    assert.deepStrictEqual(stamps.map(match => match[2]), ['1', '2', '3'], 'files must be numbered in transcript order');
  } finally {
    fixture.restore();
    fixture.dom.window.close();
  }
}

async function testSingleImageBatchDownloadKeepsUnnumberedFilename() {
  const fixture = createFixture(1);
  try {
    await fixture.workflow.downloadAllImagesFromMessage(fixture.node);
    assert.strictEqual(fixture.downloads.length, 1);
    assert.match(fixture.downloads[0], /^\d{14}\.png$/, 'a lone image must not gain a suffix');
  } finally {
    fixture.restore();
    fixture.dom.window.close();
  }
}

module.exports = [
  testMultiImageBatchDownloadNumbersEveryFile,
  testSingleImageBatchDownloadKeepsUnnumberedFilename,
];
