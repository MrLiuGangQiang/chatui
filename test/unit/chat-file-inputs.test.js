const assert = require('assert');
const fs = require('fs');
const path = require('path');

const chatService = require('../../client/services/chat-service');
const chatWorkflow = require('../../client/app/chat-workflow');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');
const dispatchContractContract = require('../../shared/dispatch-contract');

const PDF_DATA = 'data:application/pdf;base64,JVBERi0x';
const WORKBOOK_DATA = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBAo=';
const TEXT_DATA = 'data:text/plain;base64,UmVhZCB0aGlzLg==';

function appFunctionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `app.js must define ${name}`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start) : -1;
  assert.ok(end > start, `app.js must define ${nextName} after ${name}`);
  return source.slice(start, end);
}

function testChatJobBase64FileDataUsesIndexedDbMediaReferences() {
  const source = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const persist = appFunctionSource(source, 'persistJobPayloadMedia', 'restoreJobPayloadMedia');
  const restore = appFunctionSource(source, 'restoreJobPayloadMedia', 'compactJobForIndexedDbPayload');
  const compact = appFunctionSource(source, 'compactJobForIndexedDbPayload', 'stripLargePayloadData');
  const saveStart = source.indexOf('function saveChatJobWithMedia');
  const saveEnd = source.indexOf('function replaceAssistantMessageAt', saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart, 'app.js must define saveChatJobWithMedia');
  const save = source.slice(saveStart, saveEnd);

  assert.ok(persist.includes('e.startsWith("data:")'), 'Data URLs must be recognized as durable job media');
  assert.ok(persist.includes('await dataUrlToBlob(e)'), 'Data URLs must be decoded before IndexedDB persistence');
  assert.ok(persist.includes('await putImageBlob(n,s)'), 'decoded file media must be written to IndexedDB');
  assert.ok(persist.includes('`indexeddb://${n}`'), 'persisted job media must be replaced with an indexeddb:// reference');
  assert.ok(compact.includes('s.payload=await persistJobPayloadMedia(s.payload,t)'), 'job payload compaction must persist nested Base64 file data');
  assert.ok(save.includes('await compactJobForIndexedDbPayload(t,'), 'chat jobs must use IndexedDB payload compaction before saving');
  assert.ok(save.includes('return saveChatJob(e,s)'), 'chat jobs must save the compacted payload');
  assert.ok(restore.includes('e.startsWith("indexeddb://")'), 'job restore must recognize IndexedDB media references');
  assert.ok(restore.includes('await getImageBlob('), 'job restore must read the persisted Blob');
  assert.ok(restore.includes('await blobToDataUrl(t)'), 'job restore must reconstruct a Data URL for the API payload');
}

function testResponsesInputFilePayloadUsesFilenameBase64AndPdfDetail() {
  const attachment = {
    attachmentId: 'local-attachment-17',
    name: 'analysis.pdf',
    type: 'application/pdf',
    inputFile: true,
    fileData: PDF_DATA,
    text: 'native file text must not be inlined',
    pdfDetail: ' HIGH ',
  };

  const content = chatService.buildUserContentWithAttachments('Summarize the document.', [attachment]);
  assert.deepStrictEqual(content, [
    { type: 'input_file', filename: 'analysis.pdf', file_data: PDF_DATA, detail: 'high' },
    { type: 'text', text: 'Summarize the document.' },
  ]);

  const input = chatService.responsesInputFromChatMessages([{ role: 'user', content }]);
  assert.deepStrictEqual(input, [{
    role: 'user',
    content: [
      { type: 'input_file', filename: 'analysis.pdf', file_data: PDF_DATA, detail: 'high' },
      { type: 'input_text', text: 'Summarize the document.' },
    ],
  }]);
  assert.strictEqual(JSON.stringify(input).includes(attachment.attachmentId), false);
  assert.strictEqual(Object.hasOwn(input[0].content[0], 'file_id'), false);
}

function testNonPdfInputFilePayloadOmitsDetail() {
  const content = chatService.buildUserContentWithAttachments('Inspect the workbook.', [{
    attachmentId: 'local-workbook-1',
    name: 'forecast.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    inputFile: true,
    fileData: WORKBOOK_DATA,
    pdfDetail: 'high',
  }]);

  assert.deepStrictEqual(content[0], {
    type: 'input_file',
    filename: 'forecast.xlsx',
    file_data: WORKBOOK_DATA,
  });
  assert.deepStrictEqual(chatService.responsesInputFromChatMessages([{ role: 'user', content }])[0].content[0], {
    type: 'input_file',
    filename: 'forecast.xlsx',
    file_data: WORKBOOK_DATA,
  });
  assert.strictEqual(Object.hasOwn(content[0], 'detail'), false);
}

function testOcrImageDetailSurvivesBothChatTransports() {
  const content = chatService.buildUserContentWithAttachments('Read the badge.', [{
    attachmentId: 'badge-1',
    name: 'badge.png',
    type: 'image/png',
    dataUrl: 'data:image/png;base64,AAAA',
    imageDetail: ' LOW ',
  }]);

  assert.deepStrictEqual(content, [
    { type: 'text', text: 'Read the badge.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } },
  ]);
  assert.deepStrictEqual(chatService.responsesInputFromChatMessages([{ role: 'user', content }]), [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'Read the badge.' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'low' },
    ],
  }]);
}

function testExecutionImagesUseSelectedAttachmentOrderWithoutPromptAnnotations() {
  const content = chatService.buildUserContentWithAttachments('第二张和最后一张图片里面的文字是什么', [
    {
      name: 'second.png',
      type: 'image/png',
      dataUrl: 'data:image/png;base64,SECOND',
      routeResourceKey: 'r1',
      routeSource: 'current',
      routeIndex: 2,
    },
    {
      name: 'last.png',
      type: 'image/png',
      dataUrl: 'data:image/png;base64,LAST',
      routeResourceKey: 'r2',
      routeSource: 'current',
      routeIndex: 13,
    },
  ]);

  assert.deepStrictEqual(content, [
    { type: 'text', text: '第二张和最后一张图片里面的文字是什么' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,SECOND' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,LAST' } },
  ]);
  assert.deepStrictEqual(chatService.responsesInputFromChatMessages([{ role: 'user', content }])[0].content, [
    { type: 'input_text', text: '第二张和最后一张图片里面的文字是什么' },
    { type: 'input_image', image_url: 'data:image/png;base64,SECOND' },
    { type: 'input_image', image_url: 'data:image/png;base64,LAST' },
  ]);
}

function testOcrExecutionAddsLiteralReadingGuard() {
  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const prompt = workflow.composeSystemPrompt({
    dispatchContract: { operation: 'ocr' },
    systemContext: '<media_map>image_part_1: source_index=1</media_map>',
  }, {}, {});

  assert.match(prompt, /逐字 OCR/);
  assert.match(prompt, /只报告图片中实际可见的文字/);
  assert.match(prompt, /media_map/);
}

function testResponsesPayloadOmitsReasoningWhenDisabled() {
  const messages = [{
    role: 'user',
    content: [
      { type: 'input_file', filename: 'notes.txt', file_data: TEXT_DATA },
      { type: 'text', text: 'Read this.' },
    ],
  }];
  const payload = chatService.buildResponsesPayload('gpt-test', messages, {
    reasoningEnabled: false,
    reasoningEffort: 'high',
    summary: 'detailed',
    stream: false,
  });

  assert.deepStrictEqual(payload, {
    model: 'gpt-test',
    input: [{
      role: 'user',
      content: [
        { type: 'input_file', filename: 'notes.txt', file_data: TEXT_DATA },
        { type: 'input_text', text: 'Read this.' },
      ],
    }],
    temperature: 0,
    stream: false,
  });
  assert.strictEqual(Object.hasOwn(payload, 'reasoning'), false);
  assert.strictEqual(chatService.messagesHaveInputFiles(messages), true);
}

function testNativeFileHistoryNeverProjectsLegacyInlineText() {
  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const context = {
    attachments: [
      { name: 'native.pdf', type: 'application/pdf', inputFile: true, text: 'must not be inlined' },
      { name: 'legacy.txt', type: 'text/plain', text: 'legacy extracted text remains supported' },
    ],
  };
  assert.strictEqual(workflow.quotedAttachmentTextFromContext(context), '[引用附件：legacy.txt]\nlegacy extracted text remains supported');
}

async function testChatWorkflowPreparesPdfBeforeBuildingAndForcesResponsesWithoutReasoning() {
  const previousServices = globalThis.ChatUIServices;
  const events = [];
  let responseBuildOptions = null;
  let savedJob = null;
  let streamedRequest = null;
  const wrappedChatService = Object.freeze({
    ...chatService,
    buildUserContentWithAttachments(prompt, attachments) {
      events.push('build-messages');
      assert.deepStrictEqual(events.slice(0, 2), ['prepare-attachments', 'build-messages']);
      assert.strictEqual(attachments[0].inputFile, true);
      assert.strictEqual(attachments[0].fileData, PDF_DATA);
      assert.strictEqual(attachments[0].text, '');
      return chatService.buildUserContentWithAttachments(prompt, attachments);
    },
    messagesHaveInputFiles(messages) {
      events.push('detect-input-file');
      return chatService.messagesHaveInputFiles(messages);
    },
    buildResponsesPayload(model, messages, options) {
      events.push('build-responses-payload');
      responseBuildOptions = { ...options };
      return chatService.buildResponsesPayload(model, messages, options);
    },
  });
  globalThis.ChatUIServices = { ...(previousServices || {}), chat: wrappedChatService };

  try {
    const session = { id: 'session-file-input', messages: [], display: [], reasoningMode: false, reasoningType: 'high' };
    const state = {
      sessions: [session],
      activeSessionId: session.id,
      messages: session.messages,
      reasoningMode: false,
      reasoningType: 'high',
    };
    const run = { token: 'run-file-input', stopped: false, abortController: new AbortController() };
    const liveItem = { id: 'display-file-input', role: 'assistant', pending: '1', responseIndex: '1' };
    const config = { baseUrl: 'https://api.example.test/v1', apiKey: 'secret' };
    const headers = { 'X-ChatUI-Session': session.id };
    const localAttachment = {
      attachmentId: 'local-pdf-1',
      name: 'report.pdf',
      type: 'application/pdf',
      size: 12,
      inputFile: true,
      pdfDetail: 'high',
    };

    const workflow = chatWorkflow.createChatWorkflow({
      state,
      loadPublicContext: async () => {},
      getConfig: () => config,
      getSessionChatModel: () => 'gpt-4.1-mini',
      ensureActiveRun: () => run,
      getActiveSession: () => session,
      prepareChatAttachments: async (attachments, options) => {
        events.push('prepare-attachments');
        assert.strictEqual(attachments[0].fileData, undefined);
        assert.strictEqual(options.config, config);
        assert.strictEqual(options.signal, run.abortController.signal);
        assert.strictEqual(options.sessionId, session.id);
        assert.deepStrictEqual(options.headers, {});
        assert.strictEqual(options.operation, 'file_qa');
        return attachments.map(item => ({
          ...item,
          inputFile: true,
          fileData: PDF_DATA,
          text: '',
        }));
      },
      shouldUseResponsesReasoning: (model, enabled) => {
        assert.strictEqual(model, 'gpt-4.1-mini');
        assert.strictEqual(enabled, false);
        return false;
      },
      buildChatPayload: () => { throw new Error('input_file must not use Chat Completions'); },
      saveChatHistory: async () => {},
      saveSessionMessages: async () => {},
      addMessage: () => ({ isConnected: false, dataset: {} }),
      pendingFeedbackHtml: text => text,
      appendSessionDisplayMessage: () => liveItem,
      persistSessionDisplay: () => {},
      armStreamingOutputFocus: () => {},
      makeClientChatJobId: () => 'chatjob-file-input',
      addActiveRunJob: () => {},
      makeDisplayItemId: () => 'display-generated',
      saveChatJobWithMedia: async (sessionId, job) => {
        savedJob = { sessionId, ...structuredClone(job) };
        return savedJob;
      },
      createRealtimeRenderer: callback => ({ set: callback, final: callback }),
      shouldSuppressRunUi: () => false,
      updateLiveDisplay: () => {},
      shouldFollowScroll: () => false,
      streamManagedChatCompletions: async (payload, requestConfig, jobId, onChunk, options) => {
        streamedRequest = { payload: structuredClone(payload), requestConfig, jobId, options: { ...options, signal: null, onAccepted: null } };
        onChunk({ content: 'PDF received.', reasoning: '' });
        return { content: 'PDF received.', reasoning: '', firstTokenMs: 5, durationMs: 9 };
      },
      normalizeReasoningText: value => String(value || ''),
      normalizeContentText: value => String(value || ''),
      compactAdjacentDuplicateMessages: items => items,
      cloneMessageList: items => items.map(item => ({ ...item })),
      clearPendingFeedback: () => {},
      clearReasoning: () => {},
      updateReasoning: () => {},
      showReasoningUnavailable: () => {},
      setPendingFeedback: () => {},
      updateMessageContentLight: () => {},
      updateMessage: () => {},
      settleActiveOutput: () => {},
      finishReasoning: () => {},
      firstTokenTimeText: () => '',
      setMessageMetaText: () => {},
      playDoneSound: () => {},
      clearChatJob: () => {},
      isRunStopped: () => false,
      isAbortLikeError: () => false,
      formatElapsed: value => String(value),
    });

    const dispatchContract = makeDispatchContract({
      operation: 'file_qa',
      prompt: 'Summarize this PDF.',
      resources: [{
        key: 'r1',
        type: 'file',
        role: 'attachment',
        source: 'current',
        id: 'local-pdf-1',
      }],
    });
    const bindingEvidence = [{
      key: 'r1',
      type: 'file',
      role: 'attachment',
      resource_id: 'res:file:local-pdf-1',
      source: 'current',
    }];
    await workflow.sendChat('Summarize this PDF.', [localAttachment], null, {
      sessionId: session.id,
      requestPurpose: 'final_execution',
      dispatchContract,
      executionMedia: { files: bindingEvidence },
      bindingEvidence,
    });

    assert.deepStrictEqual(responseBuildOptions, {
      stream: true,
      reasoningEnabled: false,
      reasoningEffort: 'none',
    });
    assert.strictEqual(savedJob.api, 'responses');
    assert.strictEqual(streamedRequest.options.api, 'responses');
    assert.strictEqual(streamedRequest.jobId, 'chatjob-file-input');
    assert.strictEqual(Object.hasOwn(streamedRequest.payload, 'reasoning'), false);
    assert.deepStrictEqual(streamedRequest.payload, {
      model: 'gpt-4.1-mini',
      input: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: 'report.pdf', file_data: PDF_DATA, detail: 'high' },
          { type: 'input_text', text: 'Summarize this PDF.' },
        ],
      }],
      temperature: 0,
      stream: true,
    });
    assert.ok(events.indexOf('prepare-attachments') < events.indexOf('build-messages'));
    assert.ok(events.indexOf('detect-input-file') < events.indexOf('build-responses-payload'));
  } finally {
    if (previousServices === undefined) delete globalThis.ChatUIServices;
    else globalThis.ChatUIServices = previousServices;
  }
}

module.exports = [
  testChatJobBase64FileDataUsesIndexedDbMediaReferences,
  testResponsesInputFilePayloadUsesFilenameBase64AndPdfDetail,
  testNonPdfInputFilePayloadOmitsDetail,
  testOcrImageDetailSurvivesBothChatTransports,
  testExecutionImagesUseSelectedAttachmentOrderWithoutPromptAnnotations,
  testOcrExecutionAddsLiteralReadingGuard,
  testResponsesPayloadOmitsReasoningWhenDisabled,
  testNativeFileHistoryNeverProjectsLegacyInlineText,
  testChatWorkflowPreparesPdfBeforeBuildingAndForcesResponsesWithoutReasoning,
];
