'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const imageWorkflow = require('../../client/app/image-workflow');
const submitHelpers = require('../../client/app/submit-workflow.helpers');
const imageGenerationService = require('../../client/services/image-generation-service');
const imageContextWorkflow = require('../../client/app/image-context-workflow');
const imageService = require('../../client/services/image-service');
const { prepareImageJobRequest } = require('../../server/jobs/image');

function isImageFile(item = {}) {
  return String(item.type || item.file?.type || '').startsWith('image/');
}

function makeContextWorkflow() {
  return imageContextWorkflow.createImageContextWorkflow({
    getState: () => ({ activeSessionId: 'session-ref', sessions: [] }),
    getActiveSession: () => ({}),
    isImageFile,
    imageRefToFile: async (src, name) => ({ name, type: 'image/png', size: 1, src }),
    imageRefToDataUrl: async src => src,
    makeImageItemId: (reference, index) => `img_${reference}_${index}`,
    normalizeImageSelection: value => Array.isArray(value) ? value : [],
    normalizeSelectedImageIds: value => Array.isArray(value) ? value : [],
  });
}

async function buildTwoReferenceRoute() {
  const input = '参考这两张图，帮我生成一页PPT封面';
  const attachments = [
    { id: 'att_zhsoob_1_2.png', imageId: 'att_zhsoob_1_2.png', attachmentId: 'att_zhsoob_1_2.png', name: '1.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAAA', referenceId: 'imgref-1', sourceIndex: 1, routeResourceId: 'res:image:att_zhsoob_1_2.png', resource_id: 'res:image:att_zhsoob_1_2.png' },
    { id: 'att_zhsooc_2_1.png', imageId: 'att_zhsooc_2_1.png', attachmentId: 'att_zhsooc_2_1.png', name: '2.png', type: 'image/png', dataUrl: 'data:image/png;base64,BBBB', referenceId: 'imgref-2', sourceIndex: 2, routeResourceId: 'res:image:att_zhsooc_2_1.png', resource_id: 'res:image:att_zhsooc_2_1.png' },
  ];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'k', routeModel: 'route-model', chatModel: 'chat-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    requestJson: async (_url, payload) => {
      const formatName = payload?.text?.format?.name || '';
      if (formatName === 'chatui_route_intent_v3') {
        return { output_text: JSON.stringify({ operation: 'image_reference_gen', relation: 'new', goal: input, goal_mode: 'replace', task_shape: 'single', resource_refs: [{ candidate_key: 'i1', role: 'reference' }, { candidate_key: 'i2', role: 'reference' }] }) };
      }
      return { output_text: JSON.stringify({ schema_version: 'image_instruction.v1', status: 'ready', instruction: input, clarification: '' }) };
    },
  });
  const route = await workflow.getEffectiveRoute(input, attachments, 'session-ref');
  assert.ok(route, 'route must compile');
  assert.strictEqual(route.operationType, 'image_reference_gen');
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
  return { input, attachments, route };
}

// Real end-to-end: route -> execution projection -> sendImage (real task
// preparation + real file serialization) -> real server validation. This is the
// exact multi-reference flow gpt-image-2 must accept: two reference files with
// binding metadata and no masks.
async function testDirectMultiReferenceGenerationSendsValidRequest() {
  const { input, attachments, route } = await buildTwoReferenceRoute();
  const contextApi = makeContextWorkflow();
  const current = attachments.map((item, index) => ({ ...item, file: { name: item.name, type: item.type, size: 4 }, routeSource: 'current', sourceIndex: index + 1, media_index: index + 1 }));
  const pools = submitHelpers.buildExecutionResourcePools({ current }, { isImageFile });
  const executionMedia = submitHelpers.projectRouteExecutionMedia(route, pools);
  assert.strictEqual(executionMedia.imageInputs.length, 2);
  assert.strictEqual(executionMedia.masks.length, 0, 'multi-reference generation must not carry masks');

  const dispatches = [];
  const stopAfterDispatch = new Error('stop after dispatch capture');
  const state = {
    activeSessionId: 'session-ref',
    sessions: [{ id: 'session-ref', messages: [] }],
    messages: [],
    attachments: current,
    followingImageJobs: new Set(),
    lastGeneratedImage: null,
  };
  const workflow = imageWorkflow.createImageWorkflow({
    state,
    window: {
      ChatUIServices: {
        images: {
          buildImageRequestPayload: imageGenerationService.buildImageRequestPayload,
          createImageContext: imageGenerationService.createImageContext,
        },
      },
    },
    getConfig: () => ({ baseUrl: 'https://api.example.com/v1', imageModel: 'gpt-image-2', imageSize: 'auto' }),
    ensureActiveRun: () => ({ stopped: false, token: 'run-ref', abortController: new AbortController() }),
    setActiveOutputForSession() {},
    getActiveSession: () => state.sessions[0],
    persistSessionDisplay() {},
    clearReasoning() {},
    buildImagePromptWithStylePrompt: prompt => prompt,
    buildPromptWithTextAttachments: prompt => prompt,
    getEffectiveImageStylePrompt: () => '',
    isImageFile,
    persistImageAttachmentRefs: async list => list.map(item => ({ ...item, id: item.attachmentId, src: `indexeddb://${item.attachmentId}` })),
    normalizeImageContextForStorage: contextApi.normalizeImageContextForStorage,
    restoreImageAttachmentsFromContext: contextApi.restoreImageAttachmentsFromContext,
    makeImageItemId: (reference, index) => `img_${reference}_${index}`,
    makeClientImageJobId: () => 'imgjob-multiref-direct',
    shouldSuppressRunUi: () => false,
    pendingFeedbackHtml: text => text,
    updateLiveDisplay() {},
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval() {},
    performance: { now: () => 10 },
    addActiveRunJob() {},
    imageFilesToJobPayload: (list) => imageService.imageFilesToJobPayload(list, async () => 'data:image/png;base64,AAAA'),
    saveImageJob: (_sessionId, job) => job,
    clearImageJob() {},
    startImageGenerationJob: async (payload, config, jobId, options) => {
      dispatches.push({ payload, config, jobId, options: structuredClone({ ...options, signal: null, onUploadProgress: null }) });
      throw stopAfterDispatch;
    },
    waitImageGenerationJob: async () => ({ status: 'completed' }),
    formatElapsed: () => '1.0s',
    jobDurationMs: () => 1000,
    imageResultToHtml: async () => ({ html: '<div></div>', raw: 'image', metaText: '', imageContext: { attachments: [] } }),
    updateSessionDisplayItem() {},
    updateMessage() {},
    setImageContext() {},
    cloneMessageList: messages => messages.map(message => ({ ...message })),
    saveSessionMessages: async () => {},
    reconcileSuccessfulImageResult() {},
    playDoneSound() {},
    mergeSelectedGeneratedImages() {},
    normalizeLastGeneratedImage: value => value,
  });

  await assert.rejects(
    workflow.sendImage(input, {
      loadingNode: { isConnected: false, dataset: {} },
      liveItem: { id: 'display-ref', responseIndex: '1', rawText: '' },
      attachments: executionMedia.imageInputs,
      maskAttachments: executionMedia.masks,
      executionMedia,
      dispatchContract: route.dispatchContract,
      originalPrompt: input,
      routePrompt: input,
      sessionId: 'session-ref',
      clientJobId: 'imgjob-multiref-direct',
      submissionId: 'submit-multiref-direct',
      onDurableHandoff() {},
    }),
    error => error === stopAfterDispatch,
  );

  assert.strictEqual(dispatches.length, 1);
  const { files, masks } = dispatches[0].options;
  assert.deepStrictEqual(masks, [], 'multi-reference generation must post zero masks');
  assert.strictEqual(files.length, 2);
  assert.deepStrictEqual(files.map(file => file.routeRole), ['reference', 'reference']);
  assert.ok(files.every(file => file.routeResourceKey && file.routeResourceId), 'reference files must carry binding metadata');

  // The exact body the client would send must pass the real server validation.
  const accepted = prepareImageJobRequest({
    payload: dispatches[0].payload,
    files,
    masks,
  });
  assert.strictEqual(accepted.mode, 'edit_image');
  assert.deepStrictEqual(accepted.files.map(file => file.routeRole), ['reference', 'reference']);
}

module.exports = [
  testDirectMultiReferenceGenerationSendsValidRequest,
];
