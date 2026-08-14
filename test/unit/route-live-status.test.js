'use strict';

const assert = require('assert');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

function makeResolvedRoute(operationType = 'image_compare') {
  return {
    mode: 'chat',
    api: 'chat',
    operationType,
    operationApi: 'chat',
    operationMode: 'chat',
    relation: 'new',
    readiness: 'ready',
    dispatchAuthorized: true,
    needClarification: false,
    dispatchContract: { operation: operationType },
  };
}

function makeRouteService(route) {
  return {
    buildRoutePayload: ({ model, input }) => ({
      model,
      messages: [{ role: 'user', content: String(input || '') }],
    }),
    extractRouteText: response => response?.text || '',
    inspectModelRouteResult: () => ({ route }),
  };
}

async function testRouteLiveStatusFollowsActualPrimaryModelEvents() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const route = makeResolvedRoute('image_compare');
  globalThis.ChatUIRouteService = makeRouteService(route);
  const events = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: 'route-model',
      chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    buildRouteAttachmentMetadata: attachments => attachments.map((item, index) => ({
      type: 'image',
      id: item.id,
      index: index + 1,
      source: 'current',
    })),
    requestJson: async () => ({ text: '{}' }),
  });

  try {
    const result = await workflow.getEffectiveRoute(
      '比较第一张和第二张图片',
      [{ id: 'image-1' }, { id: 'image-2' }],
      'session-1',
      null,
      null,
      { onStage: (text, event) => events.push({ text, ...event }) },
    );

    assert.strictEqual(result, route);
    assert.deepStrictEqual(events.map(event => event.stage), [
      'reading_context',
      'collecting_resources',
      'recognizing_intent',
      'validating_route',
      'route_ready',
    ]);
    assert.strictEqual(events.at(-1).text, '正在准备需要比较的图片');
    assert.ok(!events.some(event => Object.prototype.hasOwnProperty.call(event, 'route')),
      'live status events must stay high-level and must not expose the full route plan');
    assert.ok(!events.some(event => event.stage === 'retrying_route_model'));
    assert.ok(!events.some(event => event.stage === 'local_fallback'));
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

async function testRouteLiveStatusReportsBackupModelRetry() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const route = makeResolvedRoute('plain_chat');
  globalThis.ChatUIRouteService = makeRouteService(route);
  const calls = [];
  const events = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: 'primary-route-model',
      chatModel: 'fallback-chat-model',
    }),
    getSessionRouteModel: () => 'primary-route-model',
    getSessionChatModel: () => 'fallback-chat-model',
    requestJson: async (_url, payload) => {
      calls.push(payload.model);
      if (payload.model === 'primary-route-model') {
        const error = new Error('primary unavailable');
        error.code = 'NETWORK_REQUEST_FAILED';
        error.retryable = true;
        throw error;
      }
      return { text: '{}' };
    },
  });

  try {
    const result = await workflow.getEffectiveRoute(
      '解释这段内容',
      [],
      'session-1',
      null,
      null,
      { onStage: (text, event) => events.push({ text, ...event }) },
    );

    assert.strictEqual(result, route);
    assert.deepStrictEqual(calls, ['primary-route-model', 'fallback-chat-model']);
    assert.strictEqual(events.filter(event => event.stage === 'retrying_route_model').length, 1);
    assert.strictEqual(
      events.find(event => event.stage === 'retrying_route_model')?.text,
      '正在重新确认任务意图',
    );
    assert.ok(events.some(event => event.stage === 'validating_route' && event.modelRole === 'fallback'));
    assert.ok(!events.some(event => event.stage === 'local_fallback'));
    assert.strictEqual(events.at(-1).stage, 'route_ready');
    assert.strictEqual(events.at(-1).text, '正在准备回答');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


async function testRouteLiveStatusReportsMultiImagePlanning() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const route = {
    ...makeResolvedRoute('edit_image'),
    taskShape: 'multi',
    userGoal: '分别修改两张图片',
  };
  const plan = {
    schema_version: 'image_plan.v1',
    tasks: [
      { operation: 'edit_image', prompt: '修改第一张', count: 1, resource_refs: ['candidate:1'] },
      { operation: 'edit_image', prompt: '修改第二张', count: 1, resource_refs: ['candidate:2'] },
    ],
  };
  globalThis.ChatUIRouteService = {
    ...makeRouteService(route),
    shouldRequestImagePlan: value => value?.taskShape === 'multi',
    buildImagePlanPayload: ({ model }) => ({
      model,
      messages: [{ role: 'user', content: 'plan images' }],
    }),
    inspectImagePlanResult: () => ({ plan }),
    compileImagePlan: () => ({
      ok: true,
      kind: 'batch',
      items: [{ operation: 'edit_image' }, { operation: 'edit_image' }],
    }),
  };
  const events = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: 'route-model',
      chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    buildRouteAttachmentMetadata: attachments => attachments.map((item, index) => ({
      type: 'image',
      id: item.id,
      index: index + 1,
      source: 'current',
    })),
    requestJson: async () => ({ text: '{}' }),
  });

  try {
    const result = await workflow.getEffectiveRoute(
      '分别修改这两张图',
      [{ id: 'image-1' }, { id: 'image-2' }],
      'session-1',
      null,
      null,
      { onStage: (text, event) => events.push({ text, ...event }) },
    );

    assert.strictEqual(result.taskShape, 'multi');
    assert.strictEqual(result.imagePlan, plan);
    assert.deepStrictEqual(
      events.map(event => event.stage),
      [
        'reading_context',
        'collecting_resources',
        'recognizing_intent',
        'validating_route',
        'planning_image_tasks',
        'route_ready',
      ],
    );
    assert.strictEqual(
      events.find(event => event.stage === 'planning_image_tasks')?.text,
      '正在拆分多个图片任务',
    );
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

module.exports = [
  testRouteLiveStatusFollowsActualPrimaryModelEvents,
  testRouteLiveStatusReportsBackupModelRetry,
  testRouteLiveStatusReportsMultiImagePlanning,
];
