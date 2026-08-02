'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
    getConfig: () => ({ baseUrl: 'https://api.example.com/v1', imageModel: 'gpt-image-1', imageSize: 'auto', imageStylePrompt: '全局风格不应进入编辑' }),
    ensureActiveRun: () => ({ stopped: false, token: 'run-mask', abortController: new AbortController() }),
    setActiveOutputForSession() {},
    getActiveSession: () => state.sessions[0],
    persistSessionDisplay() {},
    clearReasoning() {},
    buildImagePromptWithStylePrompt: (prompt, style) => style ? `${prompt} ${style}` : prompt,
    buildPromptWithTextAttachments: prompt => prompt,
    getEffectiveImageStylePrompt: () => '全局风格不应进入编辑',
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
      routeRole: item.routeRole,
      routeResourceKey: item.routeResourceKey,
      routeId: item.routeId,
      routeReferenceId: item.routeReferenceId,
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
  assert.strictEqual(dispatches[0].payload.prompt, 'replace the sky', 'edit_image must preserve the explicit edit prompt without a global style suffix');
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

function testRootImageJobAdapterForwardsMasksInBothPaths() {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
  const start = app.indexOf('async function startImageGenerationJob');
  const end = app.indexOf('async function getImageGenerationJob', start);
  const adapter = app.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the root image-job adapter must be present');
  assert.strictEqual((adapter.match(/masks:n\.masks\|\|\[\]/g) || []).length, 2, 'both the service path and fetch fallback must forward masks');
}

function testReferenceRolesReachTheImageRequestBoundary() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app', 'image-workflow.js'), 'utf8');
  const inputs = [
    { routeRole: 'reference', routeResourceKey: 'r1', routeId: 'content-1', routeReferenceId: 'refset-1' },
    { routeRole: 'style_reference', routeResourceKey: 'r2', routeId: 'style-2', routeReferenceId: 'refset-2' },
  ];
  assert.deepStrictEqual(imageWorkflow.buildImageRoleMap(inputs), [
    { position: 1, role: 'reference', resource_key: 'r1', id: 'content-1', reference_id: 'refset-1' },
    { position: 2, role: 'style_reference', resource_key: 'r2', id: 'style-2', reference_id: 'refset-2' },
  ], 'the role map must describe every uploaded image in exact multipart order');
  assert.match(imageWorkflow.buildImageRoleGuide(inputs), /图片1：作为内容参考/);
  assert.match(imageWorkflow.buildImageRoleGuide(inputs), /图片2：仅作为风格参考/);
  assert.ok(source.includes('随附图片角色（按上传顺序）'), 'the image model prompt must explain target, reference, and style-reference order');
  assert.ok(source.includes('u.image_role_map = JSON.stringify'), 'the managed job payload must retain an auditable role map');
  assert.ok(source.includes('buildImageRoleMap(canonicalExecution.imageInputs)'), 'the role map must cover the exact uploaded image array, not only a subset');
  assert.ok(source.includes('buildImageRoleGuide(canonicalExecution.imageInputs, t.taskContract)'), 'the final image prompt must derive precise target/reference rules from the validated task contract');
  assert.ok(source.includes('F.length !== f.length'), 'a partially restored multi-image request must fail before handoff');
  assert.ok(source.includes('canonicalExecution.operation === "edit_image" ? ""'), 'global image style must be disabled for preserve-oriented edits');
}

function testTargetReferenceEditGuideMakesTheFinalImagePromptUnambiguous() {
  const inputs = [
    { routeRole: 'target', routeResourceKey: 'r1', routeId: 'composite-cat', routeReferenceId: 'composite-ref' },
    { routeRole: 'reference', routeResourceKey: 'r2', routeId: 'selected-cat', routeReferenceId: 'selected-cat-ref' },
  ];
  const taskContract = {
    operation: 'edit_image',
    directive: { unmentioned_policy: 'preserve' },
  };
  const guide = imageWorkflow.buildImageRoleGuide(inputs, taskContract);
  const finalPrompt = ['不是这只猫，替换成你生成的猫', guide].join('\n\n');

  assert.match(finalPrompt, /图片1：作为编辑目标图（唯一需要修改的底图）/);
  assert.match(finalPrompt, /图片2：作为内容参考（用户已确认的替换或新增内容来源，不是编辑目标）/);
  assert.match(finalPrompt, /所有修改只作用于图片1/);
  assert.match(finalPrompt, /不要把参考图的背景、构图或无关元素带入目标图/);
  assert.match(finalPrompt, /除用户明确要求修改的部分外，保留目标图中的其他主体、背景、构图、文字、光线、色彩与风格/);
  assert.match(finalPrompt, /不要输出拼图、对比图或并排候选/);
  assert.doesNotMatch(finalPrompt, /第2张|候选2|选择2/, 'candidate locator text must never leak into the image-model prompt');
}

function testResumedImageResultPersistsReturnedImageInsteadOfJobInput() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app', 'job-resume-workflow.js'), 'utf8');
  assert.ok(source.includes('const resultImageContext = d.imageContext'), 'a completed resumed image job must derive its durable context from the returned result');
  assert.ok(source.includes('imageContext: resultImageContextText'), 'the returned image context must be written to both the completion display and canonical message');
  assert.ok(source.includes('setImageContext(e, resultImageContext)'), 'the live node must use the same returned image context as persistence');
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
  testRootImageJobAdapterForwardsMasksInBothPaths,
  testReferenceRolesReachTheImageRequestBoundary,
  testTargetReferenceEditGuideMakesTheFinalImagePromptUnambiguous,
  testResumedImageResultPersistsReturnedImageInsteadOfJobInput,
  testImageResumeRestoresMasksIntoTheirDedicatedSlot,
];
