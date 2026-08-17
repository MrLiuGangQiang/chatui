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
    goal_mode: 'replace',
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
    quality: 'auto',
    background: 'auto',
    output_format: 'auto',
    count: 1,
  }));
}

function stageTwoResponse(count) {
  return { choices: [{ message: { content: JSON.stringify({ schema_version: 'image_plan.v1', tasks: planTasks(count) }) } }] };
}

function materializationResponse(instruction = '分别生成一只猫、一只狗和一只鸟，每张图都是独立结果。') {
  return {
    choices: [{ message: { content: JSON.stringify({
      schema_version: 'image_instruction.v1',
      status: 'ready',
      instruction,
      clarification: '',
    }) } }],
  };
}

function createWorkflow({
  stageOne = stageOneIntent(),
  materialization = materializationResponse(),
  stageTwo = null,
  stageTwoError = null,
} = {}) {
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    requestJson: async (url, payload, apiKey, options) => {
      calls.push({ url, payload, apiKey, options });
      const formatName = payload.text?.format?.name;
      if (formatName === 'chatui_route_intent_v3') return { choices: [{ message: { content: stageOne } }] };
      if (formatName === 'chatui_image_instruction_v1') return materialization;
      if (formatName === 'chatui_image_plan_v1') {
        if (stageTwoError) throw stageTwoError;
        return stageTwo === null ? { choices: [{ message: { content: 'not json' } }] } : stageTwo;
      }
      throw new Error(`unexpected structured request: ${formatName || '<missing>'}`);
    },
  });
  return { workflow, calls };
}


function testMultiImageRouteIsAPlanningEnvelopeWithoutParentDispatchAuthority() {
  const inspected = routeService.inspectModelRouteResult(stageOneIntent('multi'), {
    input: '分别生成一只猫、一只狗、一只鸟',
    attachments: [],
    context: {},
  });
  assert.ok(inspected.route, inspected.reason || inspected.error);
  assert.strictEqual(inspected.route.taskShape, 'multi');
  assert.strictEqual(inspected.route.readiness, 'ready');
  assert.strictEqual(routeService.shouldRequestImagePlan(inspected.route), true);
  assert.strictEqual(inspected.route.dispatchAuthorized, false,
    'a multi-image parent must not authorize one accidental pre-plan image request');
  assert.strictEqual(inspected.route.dispatchContract, null,
    'only image_plan.v1 child routes may carry executable dispatch contracts');
}

async function testMultiImageRouteRequestsSecondPlanningCallAndCompilesBatch() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const { workflow, calls } = createWorkflow({ stageTwo: stageTwoResponse(3) });
    const route = await workflow.getEffectiveRoute('分别生成一只猫、一只狗、一只鸟', [], 'session-plan', null, {});
    assert.strictEqual(calls.length, 2,
      'a self-contained new multi-image request must route once and plan once without a redundant instruction-materialization call');
    assert.strictEqual(calls[0].payload.text.format.name, 'chatui_route_intent_v3');
    assert.strictEqual(calls[1].payload.text.format.name, 'chatui_image_plan_v1');
    assert.strictEqual(calls.some(call => call.payload.text?.format?.name === 'chatui_image_instruction_v1'), false,
      'the canonical route goal is already standalone, so materialization must not make a third request');
    const planningInput = JSON.parse(calls[1].payload.input[1].content);
    assert.strictEqual(planningInput.current_input, undefined,
      'the multi-image planner must consume the canonical route goal instead of a raw conversational request');
    assert.strictEqual(planningInput.route_goal, route.userGoal,
      'the planner must receive the route model’s canonical task goal on the fast path');
    assert.strictEqual(route.taskShape, 'multi');
    assert.strictEqual(route.imagePlanCompiled.kind, 'batch');
    assert.strictEqual(route.imagePlanCompiled.items.length, 3);
    assert.deepStrictEqual(route.imagePlanCompiled.items.map(item => item.dispatchContract.arguments.prompt),
      ['一张猫', '一张狗', '一张鸟']);
    assert.strictEqual(route.imagePlanCompiled.items.every(item => dispatchContract.hasExactDispatchContract(item.dispatchContract)), true);
    assert.strictEqual(new Set(route.imagePlanCompiled.items.map(item => item.dispatchContract.idempotency_key)).size, 3);
    assert.deepStrictEqual({
      logical_rounds: route.modelAttemptLedger.logical_rounds,
      provider_attempts: route.modelAttemptLedger.provider_attempts,
      primary_attempts: route.modelAttemptLedger.primary_attempts,
      planning_attempts: route.modelAttemptLedger.planning_attempts,
    }, { logical_rounds: 2, provider_attempts: 2, primary_attempts: 1, planning_attempts: 1 });
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

async function testHistoricalFourImagePlanEditsFirstAndLastTargets() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const input = '分别将第一张图片和最后一张图片转换为卡通风格，保留各自原有的主体、构图、姿态、背景和主要色彩不变，仅进行卡通化处理。';
    const context = {
      recent_messages: [
        { index: 1, role: 'assistant', content: '[图片生成完成] 四张图片' },
      ],
      image_candidates: Array.from({ length: 4 }, (_, index) => ({
        candidate_key: `i${index + 1}`,
        index: index + 1,
        source_index: index + 1,
        source: 'history',
        image_id: `batch-image-${index + 1}`,
        reference_id: 'batch-reference',
        target: 'previous',
        description: `第${index + 1}张图片`,
      })),
      file_candidates: [],
    };
    const stageOne = JSON.stringify({
      operation: 'edit_image',
      relation: 'followup',
      goal: input,
      task_shape: 'multi',
      resource_refs: [
        { candidate_key: 'i1', role: 'target' },
        { candidate_key: 'i4', role: 'target' },
      ],
    });
    const stageTwo = {
      choices: [{ message: { content: JSON.stringify({
        schema_version: 'image_plan.v1',
        tasks: [
          {
            task_type: 'edit',
            prompt: '将第一张图片转换为卡通风格，保持主体、构图、姿态、背景和主要色彩不变。',
            input_images: [{ candidate_key: 'i1', role: 'target' }],
          },
          {
            task_type: 'edit',
            prompt: '将第四张图片转换为卡通风格，保持主体、构图、姿态、背景和主要色彩不变。',
            input_images: [{ candidate_key: 'i4', role: 'target' }],
          },
        ],
      }) } }],
    };
    const { workflow } = createWorkflow({ stageOne, stageTwo });
    const route = await workflow.getEffectiveRoute(input, [], 'session-history-batch', null, context, {});

    assert.strictEqual(route.needClarification, false);
    assert.strictEqual(route.imagePlanCompiled.kind, 'batch');
    assert.deepStrictEqual(route.imagePlanCompiled.items.map(item => item.route.relation), ['followup', 'followup']);
    assert.deepStrictEqual(route.imagePlanCompiled.items.map(item => item.dispatchContract.bindings[0].resource_id), [
      'res:image:batch-image-1',
      'res:image:batch-image-4',
    ]);
    assert.strictEqual(routeService.isRouteDispatchable(route), true,
      'a validated compiled batch must pass the top-level dispatch gate');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testFiveTaskPlanRemainsWithinTheProductLimit() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const { workflow, calls } = createWorkflow({ stageTwo: stageTwoResponse(5) });
    const route = await workflow.getEffectiveRoute('分别生成五张不同主题的图片', [], 'session-plan', null, {});
    assert.strictEqual(calls.length, 2,
      'standalone new multi-image requests must retain the two-call route-plus-plan budget at every supported task count');
    assert.strictEqual(route.needClarification, false);
    assert.strictEqual(route.taskShape, 'multi');
    assert.strictEqual(route.imagePlanCompiled.kind, 'batch');
    assert.strictEqual(route.imagePlanCompiled.items.length, 5);
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testPlanningRequestFailureDoesNotMisdiagnoseFiveTaskLimit() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const error = new Error('upstream unavailable');
    error.statusCode = 503;
    const { workflow } = createWorkflow({ stageTwoError: error });
    const route = await workflow.getEffectiveRoute('分别生成五张不同主题的图片', [], 'session-plan', null, {});
    assert.strictEqual(route.needClarification, false);
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.strictEqual(route.outcome, 'transient_error');
    assert.strictEqual(route.readiness, 'failed');
    assert.match(route.outcomeMessage, /规划模型服务异常/);
    assert.doesNotMatch(route.outcomeMessage, /减少任务数量|最多生成/);
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
    assert.strictEqual(route.needClarification, false);
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.strictEqual(route.outcome, 'invalid_model_output');
    assert.strictEqual(route.readiness, 'failed');
    assert.match(route.outcomeMessage, /规划/);
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
  testMultiImageRouteIsAPlanningEnvelopeWithoutParentDispatchAuthority,
  testMultiImageRouteRequestsSecondPlanningCallAndCompilesBatch,
  testSingleImageRouteDoesNotPayForPlanningCall,
  testFiveTaskPlanRemainsWithinTheProductLimit,
  testHistoricalFourImagePlanEditsFirstAndLastTargets,
  testPlanningRequestFailureDoesNotMisdiagnoseFiveTaskLimit,
  testOverLimitPlanReturnsAnExplicitClarification,
  testSingleTaskPlanCollapsesBackToLegacySingleRoute,
  testInvalidPlanFailsClosedIntoClarification,
  testImagePlanPromptExplainsPerTaskEditRoles,
];
