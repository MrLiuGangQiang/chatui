'use strict';

const assert = require('assert');

const attachmentsWorkflow = require('../../client/app/attachments-workflow');
const fileInputs = require('../../shared/file-inputs');

const MIB = 1024 * 1024;

class FakeFile {
  constructor(parts = [], name = 'file', options = {}) {
    this.name = name;
    this.type = options.type || '';
    this.size = parts.reduce((sum, part) => sum + Number(part?.size || part?.byteLength || 0), 0);
  }
}

class FakeFileReader {
  readAsDataURL(file) {
    this.result = file?.dataUrl || `data:${file?.type || 'application/octet-stream'};base64,AAAA`;
    queueMicrotask(() => this.onload?.());
  }
}

function fakeCanvas(outputBlob) {
  return {
    width: 0,
    height: 0,
    getContext() { return { drawImage() {} }; },
    toBlob(callback, type) {
      callback({ size: outputBlob.size, type: outputBlob.type || type });
    },
  };
}

function createHarness(options = {}) {
  const existing = options.existing || [];
  const toasts = [];
  const writes = [];
  let bitmapCalls = 0;
  const state = {
    sessions: [{ id: 'session-attachments' }],
    activeSessionId: 'session-attachments',
    attachments: [...existing],
    uploadTasks: [],
    attachmentDrafts: new Map([['session-attachments', [...existing]]]),
    attachmentDraftVersions: new Map(),
    uploadTaskDrafts: new Map([['session-attachments', []]]),
    uploadTaskSessionIds: new Map(),
    uploadProgressTimers: new Map(),
    disposedSessionIds: new Set(),
  };
  const documentRef = {
    createElement() { return fakeCanvas(options.outputBlob || { size: 2 * MIB, type: 'image/jpeg' }); },
  };
  const workflow = attachmentsWorkflow.createAttachmentsWorkflow({
    getState: () => state,
    getElement: () => null,
    fileInputs,
    isImageFile: item => String(item?.type || item?.file?.type || '').startsWith('image/'),
    isCompressibleRasterImage: () => options.compressible !== false,
    getImageBlob: async () => null,
    putImageBlob: async (key, blob) => { writes.push({ key, blob }); },
    document: documentRef,
    FileReader: FakeFileReader,
    File: FakeFile,
    createImageBitmap: async () => {
      bitmapCalls += 1;
      return { width: options.width || 3000, height: options.height || 2000, close() {} };
    },
    imageUploadLimits: { maxLongEdge: 2048, maxBytes: 20 * MIB, minQuality: 0.72 },
    formatBytes: value => `${Math.round(Number(value || 0) / MIB * 10) / 10} MB`,
    autoResize() {},
    updateSendAvailability() {},
    openImagePreview() {},
    toast: message => toasts.push(String(message)),
  });
  return { state, workflow, toasts, writes, bitmapCalls: () => bitmapCalls };
}

async function testImageAtOrAboveTenMegabytesIsRejectedWithPrompt() {
  const harness = createHarness();
  await harness.workflow.addFiles([{ name: 'huge.png', type: 'image/png', size: 10 * MIB }]);

  assert.deepStrictEqual(harness.state.attachments, []);
  assert.strictEqual(harness.state.uploadTasks[0].error, true);
  assert.match(harness.state.uploadTasks[0].status, /文件必须小于 10 MB/);
  assert.match(harness.toasts.join('\n'), /文件必须小于 10 MB/);
  assert.strictEqual(harness.bitmapCalls(), 0, 'oversized images must be rejected before compression');
}

async function testMultipleAttachmentsAtTenMegabytesAreRejectedBeforeImageCompression() {
  const harness = createHarness();
  await harness.workflow.addFiles([
    { name: 'large-a.png', type: 'image/png', size: 6 * MIB },
    { name: 'large-b.png', type: 'image/png', size: 4 * MIB },
  ]);

  assert.deepStrictEqual(harness.state.attachments, []);
  assert.ok(harness.state.uploadTasks.every(task => task.error === true));
  assert.ok(harness.state.uploadTasks.every(task => /合计必须小于 10 MB/.test(task.status)));
  assert.match(harness.toasts.join('\n'), /合计必须小于 10 MB/);
  assert.strictEqual(harness.bitmapCalls(), 0, 'the aggregate limit must run before image compression');
}

async function testImageOverFiveMegabytesIsCompressedBeforeItBecomesAnAttachment() {
  const harness = createHarness({ outputBlob: { size: 2 * MIB, type: 'image/jpeg' } });
  await harness.workflow.addFiles([{ name: 'large.png', type: 'image/png', size: 6 * MIB, dataUrl: 'data:image/png;base64,AAAA' }]);

  assert.strictEqual(harness.state.attachments.length, 1);
  assert.strictEqual(harness.state.attachments[0].size, 2 * MIB);
  assert.match(harness.state.attachments[0].compressionNote, /已自动压缩/);
  assert.strictEqual(harness.state.uploadTasks[0].error, false);
  assert.strictEqual(harness.bitmapCalls(), 1);
}

async function testImageCompressionThatStaysOverFiveMegabytesShowsPromptWithoutThrowing() {
  const harness = createHarness({ outputBlob: { size: 6 * MIB, type: 'image/png' } });
  await harness.workflow.addFiles([{ name: 'stubborn.png', type: 'image/png', size: 6 * MIB }]);

  assert.deepStrictEqual(harness.state.attachments, []);
  assert.strictEqual(harness.state.uploadTasks[0].error, true);
  assert.match(harness.state.uploadTasks[0].status, /压缩后仍超过 5 MB/);
  assert.match(harness.toasts.join('\n'), /压缩后仍超过 5 MB/);
}

async function testImageAtOrBelowFiveMegabytesDoesNotUseSizeCompression() {
  const harness = createHarness({ width: 1200, height: 800 });
  await harness.workflow.addFiles([{ name: 'small.png', type: 'image/png', size: 4 * MIB, dataUrl: 'data:image/png;base64,AAAA' }]);

  assert.strictEqual(harness.state.attachments.length, 1);
  assert.strictEqual(harness.state.attachments[0].size, 4 * MIB);
  assert.strictEqual(harness.state.attachments[0].compressionNote, '');
  assert.strictEqual(harness.bitmapCalls(), 1, 'dimensions are inspected before deciding to skip image encoding');
}

async function testPrepareChatAttachmentsRejectsFinalTotalAtTenMegabytes() {
  const harness = createHarness();
  await assert.rejects(
    () => harness.workflow.prepareChatAttachments([
      { name: 'one.png', type: 'image/png', size: 6 * MIB, dataUrl: 'data:image/png;base64,AAAA' },
      { name: 'two.png', type: 'image/png', size: 4 * MIB, dataUrl: 'data:image/png;base64,BBBB' },
    ]),
    error => error?.code === 'FILE_INPUT_REQUEST_TOO_LARGE',
  );
}

module.exports = [
  testImageAtOrAboveTenMegabytesIsRejectedWithPrompt,
  testMultipleAttachmentsAtTenMegabytesAreRejectedBeforeImageCompression,
  testImageOverFiveMegabytesIsCompressedBeforeItBecomesAnAttachment,
  testImageCompressionThatStaysOverFiveMegabytesShowsPromptWithoutThrowing,
  testImageAtOrBelowFiveMegabytesDoesNotUseSizeCompression,
  testPrepareChatAttachmentsRejectsFinalTotalAtTenMegabytes,
];
