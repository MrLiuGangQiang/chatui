'use strict';

const assert = require('assert');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const routeService = require('../../client/services/route-service');
const dispatchContract = require('../../shared/dispatch-contract');

function stageOneIntent(taskShape = 'multi') {
  return JSON.stringify({
    operation: 'text_to_image',
    relation: 'new',
    goal: '分别生成一只猫、一只狗、一只鸟',
    resource_refs: [],
    task_shape: taskShape,
  });
}

function planTasks(count) {
  const names = ['猫', '狗', '鸟', '房子', '汽车', '飞机'];
  return Array.from({ length: count }, (_, index) => ({
    task_type: 'generate',
    prompt: `一张${names[index] || `图${index}`}`,
    input_images: [],
    size: 'auto',
    quality: 'auto',
    background: 'auto',
    output_format: 'auto',
    count: 1,
  }));
}

function stageTwoResponse(count) {
  return { choices: [{ message: { content: JSON.stringify({ schema_version: 'image_plan.v1', tasks: planTasks(count) }) } }] };
}

function createWorkflow({ stageTwo = null, modelCalls = 0 } = {}) {
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    requestJson: async (url, payload, apiKey, options) => {
      calls.push({ url, payload, apiKey, options });
      const intentPayloads = calls.filter(call => call.payload.response_format?.json_schema?.name === 'chatui_route_intent_v1');
      if (calls.length === 1) return { choices: [{ message: { content: stageOneIntent() } }] };
      return stageTwo === null ? { choices: [{ message: { content: 'not json' } }] } : stageTwo;
    },
  });
  return { workflow, calls };
}

async function testMultiImageRouteRequestsSecondPlanningCallAndCompilesBatch() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const { workflow, calls } = createWorkflow({ stageTwo: stageTwoResponse(3) });
    const route = await workflow.getEffectiveRoute('分别生成一只猫、一只狗、一只鸟', [], 'session-plan', null, {});
    assert.strictEqual(calls.length, 2, 'multi-image routes pay for exactly one planning call');
    assert.strictEqual(calls[1].payload.response_format.json_schema.name, 'chatui_image_plan_v1');
    assert.strictEqual(route.taskShape, 'multi');
    assert.strictEqual(route.imagePlanCompiled.kind, 'batch');
    assert.strictEqual(route.imagePlanCompiled.items.length, 3);
    assert.deepStrictEqual(route.imagePlanCompiled.items.map(item => item.dispatchContract.arguments.prompt),
      ['一张猫', '一张狗', '一张鸟']);
    assert.strictEqual(route.imagePlanCompiled.items.every(item => dispatchContract.hasExactDispatchContract(item.dispatchContract)), true);
    assert.strictEqual(new Set(route.imagePlanCompiled.items.map(item => item.dispatchContract.idempotency_key)).size, 3);
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testSingleImageRouteDoesNotPayForPlanningCall() {
  const previous = globalThis.ChatUIRouteService;
  const { service: singleService, route: singleRoute } = (() => {
    const route = { mode: 'image', api: 'image_generation', operationType: 'text_to_image', operationApi: 'image_generation', operationMode: 'image', relation: 'new', readiness: 'ready', dispatchAuthorized: true, needClarification: false, taskShape: 'single' };
    return { service: { ...routeService, inspectModelRouteResult: () => ({ route }) }, route };
  })();
  globalThis.ChatUIRouteService = singleService;
  try {
    const calls = [];
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
      getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
      getSessionRouteModel: () => 'route-model',
      getSessionChatModel: () => 'chat-model',
      requestJson: async () => { calls.push(1); return { choices: [{ message: { content: '{}' } }] }; },
    });
    const route = await workflow.getEffectiveRoute('画一只猫', [], 'session-plan', null, {});
    assert.strictEqual(calls.length, 1, 'single-image routes keep the legacy zero-extra-call path');
    assert.strictEqual(route.taskShape, 'single');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testOverLimitPlanReturnsAnExplicitClarification() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const { workflow } = createWorkflow({ stageTwo: stageTwoResponse(6) });
    const route = await workflow.getEffectiveRoute('一次生成六张图', [], 'session-plan', null, {});
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.match(route.clarificationQuestion, /最多生成 5 张/);
    assert.strictEqual(route.imagePlanCompiled, null);
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testSingleTaskPlanCollapsesBackToLegacySingleRoute() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const { workflow } = createWorkflow({ stageTwo: stageTwoResponse(1) });
    const route = await workflow.getEffectiveRoute('分别生成一只猫、一只狗、一只鸟', [], 'session-plan', null, {});
    assert.strictEqual(route.taskShape, 'single');
    assert.strictEqual(route.imagePlanCompiled, null);
    assert.strictEqual(dispatchContract.hasExactDispatchContract(route.dispatchContract), true);
    assert.strictEqual(route.dispatchContract.arguments.prompt, '一张猫');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testInvalidPlanFailsClosedIntoClarification() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const { workflow } = createWorkflow({ stageTwo: { choices: [{ message: { content: '{"schema_version":"image_plan.v2"}' } }] } });
    const route = await workflow.getEffectiveRoute('分别生成一只猫、一只狗、一只鸟', [], 'session-plan', null, {});
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.match(route.clarificationQuestion, /规划/);
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

function testImagePlanPromptExplainsPerTaskEditRoles() {
  const prompt = routeService.IMAGE_PLAN_SYSTEM_PROMPT;
  assert.match(prompt, /多图编辑时按子任务指定 target\/reference\/mask/);
  assert.match(prompt, /不同子任务的 target 可以不同/);
}

module.exports = [
  testMultiImageRouteRequestsSecondPlanningCallAndCompilesBatch,
  testSingleImageRouteDoesNotPayForPlanningCall,
  testOverLimitPlanReturnsAnExplicitClarification,
  testSingleTaskPlanCollapsesBackToLegacySingleRoute,
  testInvalidPlanFailsClosedIntoClarification,
  testImagePlanPromptExplainsPerTaskEditRoles,
];
