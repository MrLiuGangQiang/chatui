'use strict';

const assert = require('assert');
const { File: BufferFile } = require('buffer');

const attachmentsWorkflow = require('../../client/app/attachments-workflow');
const chatService = require('../../client/services/chat-service');
const fileInputs = require('../../shared/file-inputs');
const { createCoreRoutes } = require('../../server/api/routes/core');
const packageJson = require('../../package.json');

const FileCtor = globalThis.File || BufferFile;

function createHarness(options = {}) {
  const writes = [];
  const state = {
    sessions: [{ id: 'session-file-inputs' }],
    activeSessionId: 'session-file-inputs',
    attachments: [],
    uploadTasks: [],
    attachmentDrafts: new Map([['session-file-inputs', []]]),
    attachmentDraftVersions: new Map(),
    uploadTaskDrafts: new Map([['session-file-inputs', []]]),
    uploadTaskSessionIds: new Map(),
    uploadProgressTimers: new Map(),
    disposedSessionIds: new Set(),
  };
  const workflow = attachmentsWorkflow.createAttachmentsWorkflow({
    root: options.root,
    getState: () => state,
    getElement: options.getElement || (() => null),
    fileInputs: options.fileInputs || fileInputs,
    isImageFile: item => String(item?.type || item?.file?.type || '').startsWith('image/'),
    isCompressibleRasterImage: () => false,
    putImageBlob: async (key, blob) => writes.push({ key, blob }),
    blobToDataUrl: options.blobToDataUrl,
    autoResize() {},
    updateSendAvailability() {},
    toast() {},
  });

  function cancelCleanupTimer() {
    for (const timer of state.uploadProgressTimers.values()) clearTimeout(timer);
    state.uploadProgressTimers.clear();
  }

  return { state, workflow, writes, cancelCleanupTimer };
}

function testUploadErrorShowsTheLimitAndRemainsVisible() {
  let dismiss = null;
  const dismissButton = {
    dataset: { dismissUploadError: 'too-large' },
    addEventListener(type, callback) { if (type === 'click') dismiss = callback; },
  };
  const uploadProgress = {
    innerHTML: '',
    classList: { toggle() {} },
    querySelectorAll() { return [dismissButton]; },
  };
  const harness = createHarness({
    getElement: id => id === 'uploadProgress' ? uploadProgress : null,
    root: { setTimeout(callback) { callback(); return 1; }, clearTimeout() {} },
  });
  harness.state.uploadTasks.push({
    id: 'too-large', name: 'archive.zip', percent: 100,
    status: '文件必须小于 10 MB：archive.zip', done: true, error: true,
  });

  harness.workflow.renderUploadProgress();

  assert.match(uploadProgress.innerHTML, /role="alert"/);
  assert.match(uploadProgress.innerHTML, /上传失败/);
  assert.match(uploadProgress.innerHTML, /文件必须小于 10 MB：archive\.zip/);
  assert.match(uploadProgress.innerHTML, /data-dismiss-upload-error="too-large"/);
  harness.workflow.finishUploadProgressSoon();
  assert.strictEqual(harness.state.uploadTasks.length, 1, 'failed uploads stay visible until another file selection replaces them');
  dismiss();
  assert.strictEqual(harness.state.uploadTasks.length, 0, 'the dismiss button removes the failed upload');
}

async function withoutExpectedWarnings(callback) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await callback();
  } finally {
    console.warn = originalWarn;
  }
}

async function testAddFilesPersistsSupportedPdfAsNativeInput() {
  const harness = createHarness();
  const file = new FileCtor(['%PDF-test-body'], 'quarterly.pdf', { type: 'application/pdf' });
  try {
    await harness.workflow.addFiles([file]);

    assert.strictEqual(harness.state.attachments.length, 1);
    const [attachment] = harness.state.attachments;
    assert.strictEqual(attachment.file, file);
    assert.strictEqual(attachment.name, 'quarterly.pdf');
    assert.strictEqual(attachment.type, 'application/pdf');
    assert.strictEqual(attachment.size, file.size);
    assert.match(attachment.attachmentId, /^att_[a-z0-9]+_1_[a-z0-9]+_quarterly\.pdf$/);
    assert.strictEqual(attachment.inputFile, true);
    assert.strictEqual(Object.hasOwn(attachment, 'status'), false);
    assert.strictEqual(attachment.pdfDetail, 'auto');
    assert.strictEqual(attachment.dataUrl, '', 'native documents are encoded only when a request is prepared');
    assert.strictEqual(attachment.text, '', 'PDF local text extraction is not the native primary path');
    assert.strictEqual(attachment.persistedSrc, `indexeddb://${harness.writes[0].key}`);
    assert.deepStrictEqual(harness.writes, [{
      key: `attachment-file-${attachment.attachmentId}`,
      blob: file,
    }]);
    assert.strictEqual(harness.state.uploadTasks[0].done, true);
    assert.strictEqual(harness.state.uploadTasks[0].error, false);
  } finally {
    harness.cancelCleanupTimer();
  }
}

async function testEveryDocumentCategoryUsesNativeInput() {
  const harness = createHarness();
  const files = [
    new FileCtor(['plain text'], 'notes.md', { type: 'text/markdown' }),
    new FileCtor(['word bytes'], 'report.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    new FileCtor(['slides bytes'], 'briefing.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }),
    new FileCtor(['sheet bytes'], 'budget.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  ];
  try {
    await harness.workflow.addFiles(files);

    assert.strictEqual(harness.state.attachments.length, files.length);
    assert.strictEqual(harness.writes.length, files.length);
    harness.state.attachments.forEach((attachment, index) => {
      assert.strictEqual(attachment.file, files[index]);
      assert.strictEqual(attachment.inputFile, true);
      assert.strictEqual(attachment.text, '', `${attachment.name} must not use local text extraction`);
      assert.strictEqual(attachment.dataUrl, '', `${attachment.name} must be encoded only when the request is prepared`);
      assert.match(attachment.persistedSrc, /^indexeddb:\/\/attachment-file-/);
    });
  } finally {
    harness.cancelCleanupTimer();
  }
}

async function testAddFilesRejectsUnsupportedNativeType() {
  const harness = createHarness();
  const file = new FileCtor(['binary'], 'payload.exe', { type: 'application/x-msdownload' });
  try {
    await withoutExpectedWarnings(() => harness.workflow.addFiles([file]));

    assert.deepStrictEqual(harness.state.attachments, []);
    assert.deepStrictEqual(harness.writes, []);
    assert.strictEqual(harness.state.uploadTasks.length, 1);
    assert.strictEqual(harness.state.uploadTasks[0].done, true);
    assert.strictEqual(harness.state.uploadTasks[0].error, true);
    assert.match(harness.state.uploadTasks[0].status, /暂不支持该文件类型：payload\.exe/);
  } finally {
    harness.cancelCleanupTimer();
  }
}

async function testAddFilesRejectsAggregateAtExactlyTenMegabytes() {
  const harness = createHarness();
  const half = fileInputs.MAX_REQUEST_BYTES / 2;
  const files = [
    { name: 'first.txt', type: 'text/plain', size: half },
    { name: 'second.txt', type: 'text/plain', size: half },
  ];
  try {
    await withoutExpectedWarnings(() => harness.workflow.addFiles(files));

    assert.deepStrictEqual(harness.state.attachments, []);
    assert.deepStrictEqual(harness.writes, []);
    assert.strictEqual(harness.state.uploadTasks.length, 2);
    for (const task of harness.state.uploadTasks) {
      assert.strictEqual(task.done, true);
      assert.strictEqual(task.error, true);
      assert.match(task.status, /合计必须小于 10 MB/);
    }
  } finally {
    harness.cancelCleanupTimer();
  }
}

async function testPrepareChatAttachmentsEncodesBase64WithoutUploading() {
  const harness = createHarness();
  const file = new FileCtor(['native document'], 'analysis.py', { type: '' });
  const attachment = {
    file,
    name: file.name,
    type: file.type,
    size: file.size,
    inputFile: true,
    text: 'stale extracted text must not be sent beside a native file',
    status: 'uploaded',
    upstreamFileId: 'file-stale-id',
    upstreamScope: 'stale-scope',
  };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('prepareChatAttachments must not call fetch');
  };

  try {
    const [prepared] = await harness.workflow.prepareChatAttachments([attachment], {
      config: { baseUrl: 'https://api.example.test/v1', apiKey: 'not-used' },
      headers: { 'OpenAI-Project': 'not-used' },
    });

    assert.notStrictEqual(prepared, attachment);
    assert.strictEqual(prepared.file, file);
    assert.strictEqual(prepared.name, 'analysis.py');
    assert.strictEqual(prepared.type, 'text/x-python', 'the Data URL MIME must be inferred from the filename');
    assert.strictEqual(prepared.inputFile, true);
    assert.strictEqual(prepared.fileData, `data:text/x-python;base64,${Buffer.from('native document').toString('base64')}`);
    assert.strictEqual(prepared.text, '');
    assert.strictEqual(Object.hasOwn(prepared, 'status'), false);
    assert.strictEqual(Object.hasOwn(prepared, 'upstreamFileId'), false);
    assert.strictEqual(Object.hasOwn(prepared, 'upstreamScope'), false);
    assert.strictEqual(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testPrepareChatAttachmentsMaterializesExtractedTextAsNativeInput() {
  const harness = createHarness();
  const legacy = {
    name: 'legacy-notes.txt',
    type: 'text/plain',
    size: 17,
    text: 'legacy extracted text',
    inputFile: false,
    status: 'uploaded',
  };

  const [prepared] = await harness.workflow.prepareChatAttachments([legacy]);

  assert.notStrictEqual(prepared, legacy);
  assert.strictEqual(prepared.inputFile, true, 'text-only attachments must use the same native input_file wire path');
  assert.strictEqual(prepared.name, 'legacy-notes.txt');
  assert.strictEqual(prepared.type, 'text/plain');
  assert.strictEqual(prepared.size, Buffer.byteLength(legacy.text));
  assert.strictEqual(prepared.fileData, `data:text/plain;base64,${Buffer.from(legacy.text, 'utf8').toString('base64')}`);
  assert.strictEqual(prepared.text, '', 'extracted text must be materialized into input_file rather than duplicated inline');
  assert.strictEqual(Object.hasOwn(prepared, 'status'), false);
  assert.deepStrictEqual(
    chatService.buildUserContentWithAttachments('Review this.', [prepared]),
    [
      { type: 'input_file', filename: 'legacy-notes.txt', file_data: prepared.fileData },
      { type: 'text', text: 'Review this.' },
    ],
  );

}

async function testPrepareChatAttachmentsUsesLowDetailForOcrImagesOnly() {
  const harness = createHarness();
  const image = {
    attachmentId: 'badge-1',
    name: 'badge.png',
    type: 'image/png',
    size: 4,
    dataUrl: 'data:image/png;base64,AAAA',
  };

  const [ocrPrepared] = await harness.workflow.prepareChatAttachments([image], { operation: 'ocr' });
  const [qaPrepared] = await harness.workflow.prepareChatAttachments([image], { operation: 'image_qa' });
  const [explicitPrepared] = await harness.workflow.prepareChatAttachments([{ ...image, imageDetail: 'high' }], { operation: 'ocr' });

  assert.strictEqual(ocrPrepared.imageDetail, 'low');
  assert.strictEqual(Object.hasOwn(qaPrepared, 'imageDetail'), false);
  assert.strictEqual(explicitPrepared.imageDetail, 'high', 'an explicit transport detail must not be overwritten');
}

async function testPrepareChatAttachmentsValidatesRealBlobMetadataBeforeEncoding() {
  let validatedFiles = null;
  let encodingCalls = 0;
  const aggregateError = Object.assign(new Error('本次上传的文件合计必须小于 10 MB'), {
    code: 'FILE_INPUT_REQUEST_TOO_LARGE',
  });
  const harness = createHarness({
    fileInputs: {
      ...fileInputs,
      validateRequestFiles(files) {
        validatedFiles = files;
        throw aggregateError;
      },
    },
    blobToDataUrl: async () => {
      encodingCalls += 1;
      return 'data:text/plain;base64,dW5yZWFjaGFibGU=';
    },
  });
  const first = new FileCtor(['123456'], 'actual-first.txt', { type: 'text/plain' });
  const second = new FileCtor(['12345'], 'actual-second.txt', { type: 'text/plain' });
  const attachments = [first, second].map((file, index) => ({
    file,
    name: `stale-${index + 1}.exe`,
    type: 'application/x-msdownload',
    size: 1,
    inputFile: true,
  }));

  await assert.rejects(
    () => harness.workflow.prepareChatAttachments(attachments),
    error => error === aggregateError
  );

  assert.deepStrictEqual(validatedFiles, [
    { name: 'actual-first.txt', type: 'text/plain', size: first.size },
    { name: 'actual-second.txt', type: 'text/plain', size: second.size },
  ]);
  assert.strictEqual(encodingCalls, 0, 'aggregate validation runs before any Base64 encoding');
}

function testLegacyLocalExtractionSurfaceIsRemoved() {
  for (const name of ['mammoth', 'officeparser', 'pdf-parse', 'word-extractor']) {
    assert.strictEqual(Object.hasOwn(packageJson.dependencies, name), false, `${name} must not remain a runtime dependency`);
  }
  for (const name of ['extractAttachmentText', 'readFileAsText', 'readFileAsArrayBuffer', 'canExtractAttachmentText']) {
    assert.strictEqual(Object.hasOwn(attachmentsWorkflow, name), false, `${name} must not remain on the attachment module`);
  }

  const { routeCoreApi } = createCoreRoutes({
    appVersion: 'test',
    buildIdentity: { version: 'test' },
    readPublicConfig: () => ({}),
    sendJson() {},
    sendMethodNotAllowed() {},
    proxyImage() {},
    registerChatStreamJob() {},
  });
  assert.strictEqual(routeCoreApi({ pathname: '/api/extract-file', method: 'POST' }, {}), false);
}

module.exports = [
  testUploadErrorShowsTheLimitAndRemainsVisible,
  testAddFilesPersistsSupportedPdfAsNativeInput,
  testEveryDocumentCategoryUsesNativeInput,
  testAddFilesRejectsUnsupportedNativeType,
  testAddFilesRejectsAggregateAtExactlyTenMegabytes,
  testPrepareChatAttachmentsEncodesBase64WithoutUploading,
  testPrepareChatAttachmentsMaterializesExtractedTextAsNativeInput,
  testPrepareChatAttachmentsUsesLowDetailForOcrImagesOnly,
  testPrepareChatAttachmentsValidatesRealBlobMetadataBeforeEncoding,
  testLegacyLocalExtractionSurfaceIsRemoved,
];
