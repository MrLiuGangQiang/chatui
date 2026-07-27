'use strict';

const assert = require('assert');

const coreAttachments = require('../../client/core/attachments');
const imageGenerationService = require('../../client/services/image-generation-service');
const imageContextWorkflow = require('../../client/app/image-context-workflow');
const imageWorkflow = require('../../client/app/image-workflow');
const jobResumeWorkflow = require('../../client/app/job-resume-workflow');
const jobService = require('../../client/services/job-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');

function isImageFile(item = {}) {
  return String(item.type || item.file?.type || '').startsWith('image/');
}

function makeContextWorkflow() {
  return imageContextWorkflow.createImageContextWorkflow({
    getState: () => ({ activeSessionId: 'session-mask', sessions: [] }),
    getActiveSession: () => ({}),
    isImageFile,
    imageRefToFile: async (src, name) => ({ name, type: 'image/png', size: 1, src }),
    imageRefToDataUrl: async src => src,
    makeImageItemId: (reference, index) => `img_${reference}_${index}`,
    normalizeImageSelection: value => Array.isArray(value) ? value : [],
    normalizeSelectedImageIds: value => Array.isArray(value) ? value : [],
  });
}

async function testImageMaskContextPersistsAndRestoresRoleSeparately() {
  const contextApi = makeContextWorkflow();
  const context = imageGenerationService.createImageContext({
    prompt: 'replace the sky',
    mode: 'edit_image',
    selectedReferenceId: 'imgref-mask',
    attachments: [{ id: 'target-1', name: 'target.png', type: 'image/png', src: 'indexeddb://target-1', routeRole: 'target' }],
    masks: [{ id: 'mask-1', name: 'mask.png', type: 'image/png', src: 'indexeddb://mask-1', routeResourceKey: 'r2' }],
  });
  const normalized = contextApi.normalizeImageContextForStorage(context);

  assert.strictEqual(normalized.attachments.length, 1);
  assert.strictEqual(normalized.masks.length, 1);
  assert.strictEqual(normalized.maskCount, 1);
  assert.strictEqual(normalized.masks[0].routeRole, 'mask');
  assert.strictEqual(normalized.masks[0].routeResourceKey, 'r2');

  const parsed = coreAttachments.parseImageContext(JSON.stringify(normalized));
  assert.strictEqual(parsed.masks.length, 1, 'the shared context parser must not discard durable masks');
  assert.strictEqual(parsed.masks[0].routeRole, 'mask');

  const targets = await contextApi.restoreImageAttachmentsFromContext(normalized);
  const masks = await contextApi.restoreImageAttachmentsFromContext(normalized, { role: 'mask' });
  assert.deepStrictEqual(targets.map(item => item.name), ['target.png']);
  assert.deepStrictEqual(masks.map(item => item.name), ['mask.png']);
  assert.strictEqual(masks[0].routeRole, 'mask');
}

function editRoute() {
  const taskContract = {
    schema_version: 'task_contract.v5',
    readiness: 'ready',
    operation: 'edit_image',
    relation: 'new',
    resources: [
      { key: 'r1', type: 'image', source: 'current', role: 'target', index: 1, id: 'target-1', reference_id: '', missing: false },
      { key: 'r2', type: 'image', source: 'current', role: 'mask', index: 2, id: 'mask-1', reference_id: '', missing: false },
    ],
    directive: { mode: 'patch', base_resource_keys: ['r1', 'r2'], unmentioned_policy: 'preserve', operations: [], constraints: [] },
    clarification: { question: '', unresolved_resources: [] },
    confidence: 1,
    review_reasons: [],
    rationale: 'mask edit test',
  };
  return {
    taskContract,
    executionResources: {
      version: 'execution_resources.v1',
      operation: 'edit_image',
      images: [
        { key: 'r1', type: 'image', source: 'current', role: 'target', index: 1, id: 'target-1', reference_id: '', identity_aliases: [], index_aliases: [] },
        { key: 'r2', type: 'image', source: 'current', role: 'mask', index: 2, id: 'mask-1', reference_id: '', identity_aliases: [], index_aliases: [] },
      ],
      files: [],
    },
  };
}

async function testCanonicalImageDispatchSendsOnlyTargetAndMaskBindings() {
  const current = [
    { attachmentId: 'target-1', name: 'target.png', type: 'image/png', dataUrl: 'data:image/png;base64,dGFyZ2V0' },
    { attachmentId: 'mask-1', name: 'mask.png', type: 'image/png', dataUrl: 'data:image/png;base64,bWFzaw==' },
    { attachmentId: 'unselected-1', name: 'unselected.png', type: 'image/png', dataUrl: 'data:image/png;base64,dW5zZWxlY3RlZA==' },
  ];
  const route = editRoute();
  const pools = submitHelpers.buildExecutionResourcePools({ current }, { isImageFile });
  const executionMedia = submitHelpers.projectRouteExecutionMedia(route, pools);
  const contextApi = makeContextWorkflow();
  const savedJobs = [];
  const dispatches = [];
  const stopAfterDispatch = new Error('stop after dispatch capture');
  let handoffs = 0;
  const state = {
    activeSessionId: 'session-mask',
    sessions: [{ id: 'session-mask', messages: [] }],
    messages: [],
    attachments: current,
    followingImageJobs: new Set(),
    lastGeneratedImage: null,
  };
  const liveItem = { id: 'display-mask', responseIndex: '1', rawText: '' };
  const workflow = imageWorkflow.createImageWorkflow({
    state,
    window: {
      ChatUIServices: {
        images: {
          buildImageRequestPayload: ({ model, prompt }) => ({ model, prompt }),
          createImageContext: imageGenerationService.createImageContext,
        },
      },
    },
    getConfig: () => ({ baseUrl: 'https://api.example.com/v1', imageModel: 'gpt-image-1', imageSize: 'auto' }),
    ensureActiveRun: () => ({ stopped: false, token: 'run-mask', abortController: new AbortController() }),
    setActiveOutputForSession() {},
    getActiveSession: () => state.sessions[0],
    persistSessionDisplay() {},
    clearReasoning() {},
    buildImagePromptWithStylePrompt: prompt => prompt,
    buildPromptWithTextAttachments: prompt => prompt,
    getEffectiveImageStylePrompt: () => '',
    buildRequestHeaders: () => ({}),
    isImageFile,
    persistImageAttachmentRefs: async list => list.map(item => ({
      ...item,
      id: item.attachmentId,
      src: `indexeddb://${item.attachmentId}`,
    })),
    normalizeImageContextForStorage: contextApi.normalizeImageContextForStorage,
    restoreImageAttachmentsFromContext: contextApi.restoreImageAttachmentsFromContext,
    makeImageItemId: (reference, index) => `img_${reference}_${index}`,
    makeClientImageJobId: () => 'imgjob-mask',
    shouldSuppressRunUi: () => false,
    pendingFeedbackHtml: text => text,
    updateLiveDisplay() {},
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval() {},
    performance: { now: () => 10 },
    addActiveRunJob() {},
    imageFilesToJobPayload: async list => list.map(item => ({
      name: item.name,
      type: item.type,
      data: `payload:${item.attachmentId || item.id}`,
    })),
    saveImageJob: (sessionId, job) => {
      savedJobs.push({ sessionId, job: structuredClone(job) });
      return job;
    },
    clearImageJob() {},
    startImageGenerationJob: async (payload, config, jobId, options) => {
      dispatches.push({ payload, config, jobId, options: structuredClone({ ...options, signal: null, onUploadProgress: null }) });
      throw stopAfterDispatch;
    },
  });

  await assert.rejects(
    workflow.sendImage('replace the sky', {
      loadingNode: { isConnected: false, dataset: {} },
      liveItem,
      attachments: executionMedia.imageInputs,
      maskAttachments: executionMedia.masks,
      executionMedia,
      taskContract: route.taskContract,
      originalPrompt: 'replace the sky',
      routePrompt: 'replace the sky',
      sessionId: 'session-mask',
      clientJobId: 'imgjob-mask',
      submissionId: 'submit-mask',
      onDurableHandoff: () => { handoffs += 1; },
    }),
    error => error === stopAfterDispatch,
  );

  assert.strictEqual(dispatches.length, 1);
  assert.deepStrictEqual(dispatches[0].options.files.map(item => item.data), ['payload:target-1']);
  assert.deepStrictEqual(dispatches[0].options.masks.map(item => item.data), ['payload:mask-1']);
  assert.ok(!JSON.stringify(dispatches[0]).includes('unselected-1'), 'an attachment outside the route contract must never reach the formal image request');
  assert.strictEqual(handoffs, 1);
  assert.strictEqual(savedJobs[0].job.imageContext.masks.length, 1, 'the pre-handoff durable snapshot must retain the mask');
  assert.strictEqual(savedJobs[0].job.imageContext.masks[0].routeRole, 'mask');
}

async function testImageWorkflowRejectsNonCanonicalDispatchBeforeRequest() {
  let dispatches = 0;
  const state = {
    activeSessionId: 'session-gate',
    sessions: [{ id: 'session-gate', messages: [] }],
    messages: [],
    followingImageJobs: new Set(),
  };
  const workflow = imageWorkflow.createImageWorkflow({
    state,
    getConfig: () => ({ baseUrl: 'https://api.example.com/v1', imageModel: 'gpt-image-1' }),
    ensureActiveRun: () => ({ stopped: false, token: 'run-gate', abortController: new AbortController() }),
    setActiveOutputForSession() {},
    getActiveSession: () => state.sessions[0],
    appendSessionDisplayMessage: () => ({ id: 'display-gate' }),
    persistSessionDisplay() {},
    startImageGenerationJob: async () => { dispatches += 1; },
  });
  const validRoute = editRoute();

  await assert.rejects(
    workflow.sendImage('edit', { sessionId: 'session-gate', executionMedia: validRoute.executionResources }),
    /task_contract\.v5/,
  );
  await assert.rejects(
    workflow.sendImage('edit', { sessionId: 'session-gate', taskContract: validRoute.taskContract }),
    /execution_resources\.v1/,
  );
  await assert.rejects(
    workflow.sendImage('edit', {
      sessionId: 'session-gate',
      taskContract: validRoute.taskContract,
      executionMedia: { ...validRoute.executionResources, operation: 'text_to_image' },
    }),
    /execution_resources\.v1/,
  );
  assert.strictEqual(dispatches, 0, 'an invalid contract or projection must never reach the image request service');
}

async function testImageJobServiceForwardsMasksInManagedRequest() {
  let body = null;
  const response = await jobService.startImageGenerationJob({
    payload: { model: 'gpt-image-1', prompt: 'edit' },
    config: { baseUrl: 'https://api.example.com/v1', apiKey: 'secret' },
    jobId: 'imgjob-mask-service',
    mode: 'edit_image',
    files: [{ name: 'target.png', type: 'image/png', data: 'target' }],
    masks: [{ name: 'mask.png', type: 'image/png', data: 'mask' }],
    fetchImpl: async (url, request) => {
      body = { url, ...JSON.parse(request.body) };
      return { ok: true, text: async () => '{"id":"imgjob-mask-service"}' };
    },
    parseResponseJson: async result => JSON.parse(await result.text()),
    normalizeError: () => 'request failed',
  });
  assert.strictEqual(response.id, 'imgjob-mask-service');
  assert.strictEqual(body.url, '/api/image-jobs');
  assert.deepStrictEqual(body.masks.map(item => item.name), ['mask.png']);
}

async function testImageResumeRestoresMasksIntoTheirDedicatedSlot() {
  const context = {
    mode: 'edit_image',
    attachments: [{ id: 'target-1', src: 'indexeddb://target-1' }],
    masks: [{ id: 'mask-1', src: 'indexeddb://mask-1', routeRole: 'mask' }],
  };
  const missing = new Error('missing managed job');
  const stopAfterRestart = new Error('stop after restart capture');
  const restoredRoles = [];
  const restarts = [];
  const state = {
    activeSessionId: 'session-mask',
    sessions: [{ id: 'session-mask', display: [], messages: [] }],
    resumingJobs: new Set(),
    followingImageJobs: new Set(),
  };
  const workflow = jobResumeWorkflow.createJobResumeWorkflow({
    state,
    window: { ChatUIApp: { runs: {} } },
    loadImageJob: () => ({ id: 'imgjob-mask-resume', mode: 'edit_image', payload: { prompt: 'edit' }, imageContext: context }),
    clearImageJob() {},
    hasSuccessfulImageResult: () => false,
    isFollowingImageJob: () => false,
    findImageDisplayItemByJob: () => null,
    takePendingLiveItem: () => ({ id: 'display-mask-resume', responseIndex: '1' }),
    normalizeImageContextForStorage: value => value,
    persistSessionDisplay() {},
    setSessionBusy() {},
    pendingFeedbackHtml: text => text,
    updateLiveDisplay() {},
    shouldFollowScroll: () => false,
    setInterval: () => 2,
    clearInterval() {},
    getConfig: () => ({ baseUrl: 'https://api.example.com/v1' }),
    getImageGenerationJob: async () => { throw missing; },
    isMissingJobError: error => error === missing,
    restoreImageAttachmentsFromContext: async (value, options = {}) => {
      const role = options.role || 'target';
      restoredRoles.push(role);
      return role === 'mask'
        ? [{ attachmentId: 'mask-1', name: 'mask.png', type: 'image/png' }]
        : [{ attachmentId: 'target-1', name: 'target.png', type: 'image/png' }];
    },
    imageFilesToJobPayload: async list => list.map(item => ({ name: item.name, data: item.attachmentId })),
    startImageGenerationJob: async (payload, config, jobId, options) => {
      restarts.push({ payload, config, jobId, options });
      throw stopAfterRestart;
    },
    buildRequestHeaders: () => ({}),
    showRunError() {},
    findMessageNodeByDisplayItem: () => null,
    addMessage() {},
    finishSessionTask: (sessionId, options = {}) => {
      state.resumingJobs.delete(options.resumeKey);
      state.followingImageJobs.delete(options.jobId);
    },
  });

  await workflow.resumeImageJob('session-mask');
  assert.deepStrictEqual(restoredRoles, ['target', 'mask']);
  assert.strictEqual(restarts.length, 1);
  assert.deepStrictEqual(restarts[0].options.files.map(item => item.data), ['target-1']);
  assert.deepStrictEqual(restarts[0].options.masks.map(item => item.data), ['mask-1']);
}

module.exports = [
  testImageMaskContextPersistsAndRestoresRoleSeparately,
  testCanonicalImageDispatchSendsOnlyTargetAndMaskBindings,
  testImageWorkflowRejectsNonCanonicalDispatchBeforeRequest,
  testImageJobServiceForwardsMasksInManagedRequest,
  testImageResumeRestoresMasksIntoTheirDedicatedSlot,
];
