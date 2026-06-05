#!/usr/bin/env node
const assert = require('assert');
const { JSDOM } = require('jsdom');
const workflow = require('../../client/app/attachments-workflow');

assert.strictEqual(workflow.inferMimeByName('a.md'), 'text/markdown');
assert.strictEqual(workflow.inferMimeByName('a.unknown'), 'application/octet-stream');
assert.strictEqual(workflow.isPdfFile({ name: 'x.pdf' }), true);
assert.strictEqual(workflow.isOfficeFile({ name: 'x.docx' }), true);
assert.strictEqual(workflow.isProbablyTextFile({ name: 'x.ts' }), true);
assert.strictEqual(workflow.looksBinary('abc'), false);
assert.strictEqual(workflow.looksBinary('a\0b'), true);
assert.strictEqual(workflow.replaceExt('a.bmp', '.png'), 'a.png');
assert.ok(workflow.decodedTextQuality('中文 abc') > workflow.decodedTextQuality('\uFFFD\uFFFD'));

const dom = new JSDOM('<div id="attachmentBar"></div><div id="uploadProgress"></div>');
const document = dom.window.document;
const state = { attachments: [{ name: 'a.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==', text: '', size: 1 }], uploadTasks: [] };
let resized = 0;
let sendUpdated = 0;
let previewed = '';
const controller = workflow.createAttachmentsWorkflow({
  getState: () => state,
  getElement: id => document.getElementById(id),
  escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  autoResize: () => { resized += 1; },
  updateSendAvailability: () => { sendUpdated += 1; },
  openImagePreview: src => { previewed = src; },
  isImageFile: item => /^image\//.test(item.type || ''),
  isCompressibleRasterImage: () => false,
  formatBytes: bytes => `${bytes} B`,
  parseResponseJson: async response => response.json(),
  normalizeError: () => 'error',
  getImageBlob: async () => new Blob(['x'], { type: 'image/png' }),
  blobToDataUrl: async () => 'data:image/png;base64,eA==',
  FileReader: global.FileReader,
  File: global.File,
  document,
});

controller.renderAttachments();
assert.ok(document.querySelector('.attachment-chip-image'));
document.querySelector('[data-preview-attachment]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
assert.strictEqual(previewed, 'data:image/png;base64,AA==');
document.querySelector('[data-remove-attachment]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
assert.strictEqual(state.attachments.length, 0);
assert.ok(resized >= 1);

state.uploadTasks = [{ id: 'u1', name: 'file.txt', percent: 25, status: '读取文本', done: false }];
controller.renderUploadProgress();
assert.ok(document.getElementById('uploadProgress').innerHTML.includes('读取文本'));
assert.strictEqual(sendUpdated >= 1, true);
controller.setUploadPhase('u1', '完成', 100);
assert.strictEqual(state.uploadTasks[0].percent, 100);
assert.strictEqual(controller.hasPendingUploads(), true);
controller.setUploadTask('u1', { done: true });
assert.strictEqual(controller.hasPendingUploads(), false);

(async () => {
  const data = await controller.imageRefToDataUrl('indexeddb://x');
  assert.strictEqual(data, 'data:image/png;base64,eA==');
  console.log('app attachments workflow ok');
})().catch(err => { console.error(err); process.exit(1); });
