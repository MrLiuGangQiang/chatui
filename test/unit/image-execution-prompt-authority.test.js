'use strict';

const assert = require('assert');

const imageWorkflow = require('../../client/app/image-workflow');
const imageGenerationService = require('../../client/services/image-generation-service');
const imageRouteContext = require('../../client/core/image-route-context');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

async function testCanonicalPlanPromptWinsOverSelectorTokensAndPersistsAsExecutionInput() {
  const resolvedPrompt = 'A detailed fashion portrait of an adult woman on a New York street.';
  const selectorTokens = '1\n\n2';
  const contract = makeExecutionFixture({
    prompt: resolvedPrompt,
    operation: 'text_to_image',
    relation: 'continuation',
  });
  const session = { id: 'session-prompt-authority', messages: [], display: [] };
  const state = {
    activeSessionId: session.id,
    sessions: [session],
    messages: session.messages,
    followingImageJobs: new Set(),
    lastGeneratedImage: null,
  };
  const liveItem = {
    id: 'display-prompt-authority',
    role: 'assistant',
    pending: '1',
    responseIndex: '0',
    rawText: 'pending image',
    jobId: '',
  };
  session.display.push(liveItem);
  const loadingNode = { isConnected: false, dataset: {} };
  const captures = {
    payload: null,
    startOptions: null,
    resultPrompt: '',
    completionPrompt: '',
    savedJobs: [],
    pendingMessages: [],
  };
  const noop = () => {};

  function updateSessionDisplayItem(_sessionId, item, role, content, options = {}) {
    item.role = role;
    item.html = options.html ? String(content || '') : '';
    item.rawText = options.rawText ?? String(content || '');
    if (options.responseIndex !== undefined && options.responseIndex !== null) {
      item.responseIndex = String(options.responseIndex);
    }
    if (options.imageContext !== undefined) item.imageContext = options.imageContext;
    if (options.metaText !== undefined) item.metaText = options.metaText;
    if (options.pending !== undefined) item.pending = options.pending ? '1' : '';
  }

  const workflow = imageWorkflow.createImageWorkflow({
    state,
    window: {
      ChatUIServices: {
        images: {
          buildImageRequestPayload: ({ model, prompt }) => ({ model, prompt }),
          createImageContext: imageGenerationService.createImageContext,
          buildImageCompletionMessage: ({ prompt }) => {
            captures.completionPrompt = prompt;
            return `[image generated] ${prompt}`;
          },
        },
      },
    },
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', imageModel: 'image-model', imageSize: 'auto' }),
    ensureActiveRun: () => ({ stopped: false, token: 'run-prompt-authority', abortController: new AbortController() }),
    setActiveOutputForSession: noop,
    getActiveSession: () => session,
    persistSessionDisplay: noop,
    clearReasoning: noop,
    clearPendingFeedback: noop,
    buildImagePromptWithStylePrompt: prompt => prompt,
    getEffectiveImageStylePrompt: () => '',
    persistImageAttachmentRefs: async attachments => attachments,
    normalizeImageContextForStorage: value => value,
    makeImageItemId: (_referenceId, ordinal) => `image-${ordinal}`,
    makeClientImageJobId: () => 'imgjob-prompt-authority',
    shouldSuppressRunUi: () => false,
    pendingFeedbackHtml: text => `<p class="pending-image-feedback">${text}</p>`,
    addMessage: (role, content, options = {}) => {
      captures.pendingMessages.push({ role, content, options });
      return loadingNode;
    },
    updateLiveDisplay: updateSessionDisplayItem,
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval: noop,
    performance: { now: () => 100 },
    addActiveRunJob: noop,
    saveImageJob: (_sessionId, job) => {
      captures.savedJobs.push(job);
      return job;
    },
    clearImageJob: noop,
    startImageGenerationJob: async (payload, _config, id, options) => {
      captures.payload = payload;
      captures.startOptions = options;
      return { id, createdAt: 1 };
    },
    waitImageGenerationJob: async () => ({ status: 'completed' }),
    formatElapsed: () => '1.0s',
    jobDurationMs: () => 1000,
    imageResultToHtml: async (_job, _elapsed, options) => {
      captures.resultPrompt = options.prompt;
      return {
        html: '<div class="generated-image-grid"></div>',
        raw: 'image result',
        metaText: 'RT 1.0s',
        imageContext: { prompt: options.prompt, routePrompt: options.routePrompt, attachments: [] },
      };
    },
    updateSessionDisplayItem,
    updateMessage: noop,
    setImageContext: noop,
    cloneMessageList: messages => messages.map(message => ({ ...message })),
    saveSessionMessages: async (_sessionId, messages) => {
      session.messages = messages.map(message => ({ ...message }));
    },
    reconcileSuccessfulImageResult: noop,
    playDoneSound: noop,
    mergeSelectedGeneratedImages: noop,
    normalizeLastGeneratedImage: value => value,
  });

  const executionPreviewText = '将修改：橘猫坐在窗边；修改内容：把背景改成雪山';
  const executionPreviewHtml = '<section class="route-execution-preview" data-route-execution-preview="1"><img data-persisted-src="indexeddb://chosen-cat" /></section>';

  await workflow.sendImage(selectorTokens, {
    liveItem,
    sessionId: session.id,
    userAlreadyAdded: true,
    dispatchContract: contract.dispatchContract,
    executionMedia: contract.executionResources,
    originalPrompt: '2',
    routePrompt: selectorTokens,
    executionPreviewText,
    executionPreviewHtml,
    clientJobId: 'imgjob-prompt-authority',
  });

  assert.strictEqual(captures.payload.prompt, resolvedPrompt,
    'the provider payload must use the canonical resolved plan prompt');
  assert.strictEqual(captures.startOptions.dispatchContract.arguments.prompt, resolvedPrompt);
  assert.strictEqual(captures.resultPrompt, resolvedPrompt,
    'result image context must persist the executed prompt, not the selector token');
  assert.strictEqual(captures.completionPrompt, resolvedPrompt,
    'the completion message must persist the executed prompt');
  assert.ok(captures.savedJobs.every(job => job.prompt === resolvedPrompt));
  assert.strictEqual(state.messages[0].content, `[image generated] ${resolvedPrompt}`);
  assert.strictEqual(JSON.parse(state.messages[0].imageContext).prompt, resolvedPrompt);
  assert.ok(!JSON.stringify(state.messages).includes(selectorTokens));

  assert.strictEqual(captures.pendingMessages.length, 1,
    'the first visible processing state must be created through the real image workflow');
  assert.doesNotMatch(captures.pendingMessages[0].content, /data-route-execution-preview="1"/,
    'internal route execution previews must not appear in the processing state');
  assert.match(captures.pendingMessages[0].content, /正在准备图片生成参数/,
    'the first visible processing state must describe the actual image operation');
  assert.strictEqual(state.messages[0].metaText, 'RT 1.0s',
    'the saved result must show elapsed time instead of an internal execution label');
  assert.strictEqual(liveItem.metaText, 'RT 1.0s',
    'the displayed result must show the same elapsed-time metadata');
  assert.strictEqual((state.messages[0].html.match(/data-route-execution-preview="1"/g) || []).length, 0,
    'the final result must immediately remove the processing-only reference preview');
  assert.strictEqual((liveItem.html.match(/data-route-execution-preview="1"/g) || []).length, 0,
    'the live completion must remove the processing-only reference preview without a refresh');
  assert.deepStrictEqual(imageRouteContext.extractPersistedImageRefs(state.messages[0].html), [],
    'the preview itself must not be recorded as a newly generated image');
}

module.exports = [
  testCanonicalPlanPromptWinsOverSelectorTokensAndPersistsAsExecutionInput,
];
