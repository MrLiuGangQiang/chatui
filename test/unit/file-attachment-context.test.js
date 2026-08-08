'use strict';

const assert = require('assert');
const { File: BufferFile } = require('buffer');

const coreAttachments = require('../../client/core/attachments');
const imageRouteContext = require('../../client/core/image-route-context');
const imageContextWorkflow = require('../../client/app/image-context-workflow');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');

const FileCtor = globalThis.File || BufferFile;

function createWorkflow(media, writes = []) {
  return imageContextWorkflow.createImageContextWorkflow({
    File: FileCtor,
    isImageFile: item => String(item?.type || item?.file?.type || '').startsWith('image/'),
    putImageBlob: async (key, blob) => {
      writes.push(key);
      media.set(key, blob);
    },
    imageRefToFile: async (ref, name) => {
      assert.match(ref, /^indexeddb:\/\//);
      const blob = media.get(ref.slice('indexeddb://'.length));
      if (!blob) throw new Error(`missing test blob: ${ref}`);
      return new FileCtor([blob], name, { type: blob.type || 'application/octet-stream' });
    },
    imageRefToDataUrl: async ref => ref,
    parseImageContext: coreAttachments.parseImageContext,
  });
}

async function testNativePdfContextPersistsOriginalBlobWithoutBase64Payload() {
  const media = new Map();
  const writes = [];
  const workflow = createWorkflow(media, writes);
  const file = new FileCtor(['quarterly report'], 'quarterly.pdf', { type: 'application/pdf', lastModified: 1234 });
  const attachment = {
    attachmentId: 'local-report-id',
    file,
    name: file.name,
    type: file.type,
    size: file.size,
    inputFile: true,
    text: 'legacy extracted text must not be duplicated',
    pdfDetail: 'high',
    fileData: 'data:application/pdf;base64,cXVhcnRlcmx5IHJlcG9ydA==',
    file_data: 'data:application/pdf;base64,dHJhbnNpZW50',
  };

  const context = await workflow.buildUserAttachmentContext('review this report', [attachment]);
  const stored = context.attachments[0];

  assert.strictEqual(stored.id, 'local-report-id');
  assert.strictEqual(stored.src, 'indexeddb://attachment-file-local-report-id');
  assert.strictEqual(stored.persistedSrc, stored.src);
  assert.strictEqual(attachment.persistedSrc, stored.src);
  assert.strictEqual(stored.inputFile, true);
  assert.strictEqual(stored.text, '', 'native input files must not persist a duplicate inline-text channel');
  assert.strictEqual(stored.pdfDetail, 'high');
  assert.strictEqual(Object.hasOwn(stored, 'status'), false);
  assert.strictEqual(Object.hasOwn(stored, 'fileData'), false);
  assert.strictEqual(Object.hasOwn(stored, 'file_data'), false);
  assert.deepStrictEqual(writes, ['attachment-file-local-report-id']);
  assert.strictEqual(await media.get('attachment-file-local-report-id').text(), 'quarterly report');

  const [restored] = await workflow.restoreUserAttachmentsFromContext(JSON.stringify(context));
  assert.ok(restored.file instanceof FileCtor, 'history restore must return a File that request preparation can encode');
  assert.strictEqual(restored.file.name, 'quarterly.pdf');
  assert.strictEqual(restored.file.type, 'application/pdf');
  assert.strictEqual(await restored.file.text(), 'quarterly report');
  assert.strictEqual(restored.attachmentId, 'local-report-id');
  assert.strictEqual(restored.persistedSrc, stored.src);
  assert.strictEqual(restored.src, stored.src);
  assert.strictEqual(restored.inputFile, true);
  assert.strictEqual(restored.text, '');
  assert.strictEqual(restored.pdfDetail, 'high');
  assert.strictEqual(Object.hasOwn(restored, 'status'), false);
  assert.strictEqual(Object.hasOwn(restored, 'fileData'), false);
  assert.strictEqual(Object.hasOwn(restored, 'file_data'), false);
}

async function testExistingDurableDocumentKeepsLocalFileIdentityWithoutRepersisting() {
  const media = new Map([
    ['existing-document', new Blob(['document body'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })],
  ]);
  const writes = [];
  const workflow = createWorkflow(media, writes);
  const attachment = {
    fileId: 'local-route-file-id',
    name: 'notes.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 13,
    persistedSrc: 'indexeddb://existing-document',
    inputFile: true,
    fileData: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,ZG9jdW1lbnQgYm9keQ==',
  };

  const context = await workflow.buildUserAttachmentContext('', [attachment]);
  assert.strictEqual(context.attachments[0].id, 'local-route-file-id');
  assert.strictEqual(context.attachments[0].src, 'indexeddb://existing-document');
  assert.strictEqual(Object.hasOwn(context.attachments[0], 'status'), false);
  assert.strictEqual(Object.hasOwn(context.attachments[0], 'fileData'), false);
  assert.deepStrictEqual(writes, [], 'an existing durable Blob reference must be reused');

  const [restored] = await workflow.restoreUserAttachmentsFromContext(context);
  assert.strictEqual(restored.attachmentId, 'local-route-file-id');
  assert.strictEqual(Object.hasOwn(restored, 'status'), false);
  assert.strictEqual(Object.hasOwn(restored, 'fileData'), false);
  assert.strictEqual(restored.file.name, 'notes.docx');
  assert.strictEqual(await restored.file.text(), 'document body');
}

async function testMissingNativeDocumentBlobFailsInsteadOfDroppingAttachment() {
  const workflow = createWorkflow(new Map());
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => workflow.restoreUserAttachmentsFromContext({
        attachments: [{
          id: 'local-missing-file',
          name: 'missing.pdf',
          type: 'application/pdf',
          src: 'indexeddb://missing-file',
          inputFile: true,
        }],
      }),
      error => error?.code === 'FILE_CONTENT_UNAVAILABLE' && /missing\.pdf/.test(error.message),
    );
  } finally {
    console.warn = originalWarn;
  }
}

async function testHistoricalNativeMarkdownKeepsReadableRouteCandidate() {
  const name = '\u516c\u53f8OpenClaw\u5b89\u88c5\u8fc7\u7a0b.md';
  const media = new Map([
    ['historical-markdown', new Blob(['# OpenClaw\n\nInstall steps.'], { type: 'text/markdown' })],
  ]);
  const workflow = createWorkflow(media);
  const context = await workflow.buildUserAttachmentContext('uploaded the guide', [{
    attachmentId: 'historical-native-markdown',
    name,
    type: 'text/markdown',
    size: 27,
    persistedSrc: 'indexeddb://historical-markdown',
    inputFile: true,
    text: '',
  }]);
  const stored = context.attachments[0];

  assert.strictEqual(stored.inputFile, true);
  assert.strictEqual(stored.src, 'indexeddb://historical-markdown');
  assert.strictEqual(coreAttachments.isInputFileAvailable(stored), true, 'a durable IndexedDB source makes native history content readable');

  const [restored] = await workflow.restoreUserAttachmentsFromContext(context);
  assert.strictEqual(restored.inputFile, true);
  assert.strictEqual(coreAttachments.isInputFileAvailable(restored), true);
  assert.strictEqual(await restored.file.text(), '# OpenClaw\n\nInstall steps.');

  const routeContext = imageRouteContext.buildRouteContext({
    messages: [{
      role: 'user',
      content: 'uploaded the guide',
      attachmentContext: JSON.stringify(context),
    }],
  });
  assert.strictEqual(routeContext.file_candidates.length, 1);
  assert.deepStrictEqual({
    source: routeContext.file_candidates[0].source,
    file_id: routeContext.file_candidates[0].file_id,
    has_extracted_text: routeContext.file_candidates[0].has_extracted_text,
    input_file_available: routeContext.file_candidates[0].input_file_available,
  }, {
    source: 'history',
    file_id: 'historical-native-markdown',
    has_extracted_text: false,
    input_file_available: true,
  });

  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: 'summarize the previously uploaded Markdown file',
    attachments: [],
    context: routeContext,
  });
  const routeUser = JSON.parse(payload.messages[1].content);
  assert.ok(routeUser.resource_candidates.some(candidate => candidate.candidate_key === 'f1'
    && candidate.type === 'file'
    && candidate.source === 'history'
    && candidate.label === name));

  const intent = {
    operation: 'file_qa',
    relation: 'followup',
    goal: '测试用户目标',
    resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
  };
  const inspected = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input: 'summarize the previously uploaded Markdown file',
    attachments: [],
    context: routeContext,
  });
  assert.ok(inspected.route);
  assert.strictEqual(inspected.route.dispatchAuthorized, true);
  assert.strictEqual(inspected.route.resources[0].source, 'history');
  assert.deepStrictEqual(inspected.route.dispatchContract.bindings.map(binding => binding.key), ['r1']);
  assert.strictEqual(inspected.route.dispatchContract.bindings[0].resource_id, 'res:file:historical-native-markdown');
}

async function testNativeInputMarkerWithoutContentStaysUnavailableInHistory() {
  const workflow = createWorkflow(new Map());
  const context = await workflow.buildUserAttachmentContext('upload marker only', [{
    attachmentId: 'marker-only-markdown',
    name: 'marker-only.md',
    type: 'text/markdown',
    size: 32,
    inputFile: true,
    text: '',
  }]);
  const stored = context.attachments[0];
  assert.strictEqual(stored.inputFile, true);
  assert.strictEqual(Object.hasOwn(stored, 'src'), false);
  assert.strictEqual(coreAttachments.isInputFileAvailable(stored), false, 'native transport mode alone must not claim readable content');

  const routeContext = imageRouteContext.buildRouteContext({
    messages: [{ role: 'user', content: 'upload marker only', attachmentContext: JSON.stringify(context) }],
  });
  assert.strictEqual(routeContext.file_candidates[0].input_file_available, false);
  const routeUser = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: 'summarize that file',
    context: routeContext,
  }).messages[1].content);
  const unavailable = routeUser.resource_candidates.filter(candidate => candidate.type === 'file');
  assert.strictEqual(unavailable.length, 1, 'unavailable files remain in the catalog so the compiler can explain why they cannot execute');
  assert.strictEqual(unavailable[0].availability, 'unavailable');
  assert.ok(unavailable[0].unavailable_reason);
}

async function testLegacyFileMarkersBecomeAmbiguousClarificationChoices() {
  const messages = [
    {
      role: 'user',
      content: '这是什么\n\n[file id=file-bug name=AI需求&BUG跟踪表.xlsx type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet size=28076]',
    },
    { role: 'assistant', content: '这是 AI 需求与 BUG 跟踪表。' },
    {
      role: 'user',
      content: '这是什么\n\n[file id=file-budget name=AI_Coding全员推广成本预算表.xlsx type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet size=18536]',
    },
    { role: 'assistant', content: '这是 AI Coding 成本预算表。' },
  ];
  const context = imageRouteContext.buildRouteContext({ messages });

  assert.strictEqual(context.file_candidates.length, 2);
  assert.strictEqual(context.file_candidates.every(candidate => candidate.input_file_available), true);
  assert.deepStrictEqual(new Set(context.file_candidates.map(candidate => candidate.file_id)), new Set(['file-bug', 'file-budget']));
  assert.deepStrictEqual(new Set(context.file_candidates.map(candidate => candidate.name)), new Set(['AI需求&BUG跟踪表.xlsx', 'AI_Coding全员推广成本预算表.xlsx']));

  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '目前有几个问题呢',
    attachments: [],
    context,
  });
  const routeUser = JSON.parse(payload.messages[1].content);
  const fileCandidates = routeUser.resource_candidates.filter(candidate => candidate.type === 'file');
  assert.strictEqual(fileCandidates.length, 2, 'the wire payload publishes every file in the bounded catalog for model selection');
  assert.deepStrictEqual(new Set(fileCandidates.map(candidate => candidate.label)), new Set(['AI需求&BUG跟踪表.xlsx', 'AI_Coding全员推广成本预算表.xlsx']));

  const intent = {
    operation: 'file_qa',
    relation: 'followup',
    goal: '请明确选择其中一个文件。',
    resource_refs: [],
  };
  const inspected = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input: '目前有几个问题呢',
    attachments: [],
    context,
  });

  assert.ok(inspected.route, inspected.error || inspected.reason);
  assert.strictEqual(inspected.route.needClarification, true);
  assert.strictEqual(inspected.route.dispatchAuthorized, false);
  assert.strictEqual(inspected.route.clarificationQuestion, '没有明确要使用哪个文件，请从下列文件中选择。');
  assert.strictEqual(inspected.route.clarificationSlots.length, 1);
  const [slot] = inspected.route.clarificationSlots;
  assert.deepStrictEqual({ type: slot.type, role: slot.role, reason: slot.reason }, {
    type: 'file',
    role: 'attachment',
    reason: 'ambiguous',
  });
  assert.strictEqual(slot.choices.length, 2);
  assert.deepStrictEqual(new Set(slot.choices.map(choice => choice.label)), new Set(['AI需求&BUG跟踪表.xlsx', 'AI_Coding全员推广成本预算表.xlsx']));
}

async function testLegacyFileMarkerSelectionRestoresDurableHistoricalFile() {
  const messages = [{
    role: 'user',
    content: '这是什么\n\n[file id=file-bug name=AI需求&BUG跟踪表.xlsx type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet size=28076]',
  }];
  const route = {
    executionResources: {
      files: [{
        key: 'r1',
        type: 'file',
        role: 'attachment',
        source: 'history',
        index: 1,
        id: 'file-bug',
        resource_id: 'res:file:file-bug',
        identity_aliases: ['res:file:file-bug', 'file-bug'],
      }],
    },
  };

  let restorationContext = null;
  const restored = await submitHelpers.restoreHistoricalFilePool(route, {
    messages,
    isImageFile: () => false,
    restoreUserAttachmentsFromContext: async value => {
      restorationContext = value;
      assert.strictEqual(value.attachments.length, 1);
      assert.strictEqual(value.attachments[0].id, 'file-bug');
      assert.strictEqual(value.attachments[0].persistedSrc, 'indexeddb://attachment-file-file-bug');
      return [{
        attachmentId: 'file-bug',
        name: 'AI需求&BUG跟踪表.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        persistedSrc: value.attachments[0].persistedSrc,
        inputFile: true,
      }];
    },
  });

  assert.ok(restorationContext, 'marker-only history must synthesize a restoration context');
  assert.strictEqual(restored.length, 1);
  assert.strictEqual(restored[0].attachmentId, 'file-bug');
  assert.strictEqual(restored[0].routeSource, 'history');
  assert.strictEqual(restored[0].sourceIndex, 1);
  assert.strictEqual(restored[0].routeMessageIndex, 1);
}
module.exports = [
  testNativePdfContextPersistsOriginalBlobWithoutBase64Payload,
  testExistingDurableDocumentKeepsLocalFileIdentityWithoutRepersisting,
  testMissingNativeDocumentBlobFailsInsteadOfDroppingAttachment,
  testHistoricalNativeMarkdownKeepsReadableRouteCandidate,
  testNativeInputMarkerWithoutContentStaysUnavailableInHistory,
  testLegacyFileMarkersBecomeAmbiguousClarificationChoices,
  testLegacyFileMarkerSelectionRestoresDurableHistoricalFile,
];
