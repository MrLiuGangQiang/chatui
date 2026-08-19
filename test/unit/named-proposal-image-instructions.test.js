'use strict';

const assert = require('assert');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const routeService = require('../../client/services/route-service');

const SELECTED_OPTION = '一栋两层现代住宅，白色石材与深色木饰面立面，落地玻璃窗，前景有浅水景观池与疏朗绿植，黄昏暖光，建筑可视化效果图，广角透视。';
const UNSELECTED_OPTION = '一栋红砖工业风住宅，阴雨天，黑白纪实摄影。';
const OPTIONS_MESSAGE = `可以考虑以下方案：\n\n### **A.** ${SELECTED_OPTION}\n\n### **B.** ${UNSELECTED_OPTION}`;

function routeIntent(operation, input, resourceRefs = [], taskShape = 'single') {
  return {
    operation,
    relation: 'followup',
    goal: input,
    goal_mode: 'replace',
    resource_refs: resourceRefs,
    task_shape: taskShape,
  };
}

async function runPipeline({
  operation = 'text_to_image',
  input,
  attachments = [],
  resourceRefs = [],
  taskShape = 'single',
  materialization,
  imagePlan = null,
}) {
  const originalRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const requests = [];
  const requestPayloads = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'image', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'test-key', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    buildRouteAttachmentMetadata: items => items.map((item, index) => ({
      type: String(item.type || '').startsWith('image/') ? 'image' : 'file',
      image_id: item.image_id || item.imageId || '',
      file_id: item.file_id || item.fileId || '',
      resource_id: item.resource_id || item.resourceId || '',
      index: index + 1,
      source_index: index + 1,
      source: 'current',
      name: item.name || '',
    })),
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      requests.push(options.requestPurpose);
      requestPayloads.push({ purpose: options.requestPurpose, payload });
      const formatName = payload.text?.format?.name;
      if (formatName === 'chatui_route_intent_v3') {
        return { output_text: JSON.stringify(routeIntent(operation, input, resourceRefs, taskShape)) };
      }
      if (formatName === 'chatui_image_instruction_v1') return { output_text: JSON.stringify(materialization) };
      if (formatName === 'chatui_image_plan_v1' && imagePlan) {
        return { output_text: JSON.stringify(imagePlan) };
      }
      throw new Error(`unexpected structured request: ${formatName || '<missing>'}`);
    },
  });
  try {
    const result = await workflow.getEffectiveRoute(input, attachments, 'session-1', null, {
      recent_messages: [{ index: 1, id: 'assistant-options', resource_id: 'res:message:assistant-options', role: 'assistant', content: OPTIONS_MESSAGE }],
    });
    return { result, requests, requestPayloads };
  } finally {
    if (originalRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = originalRouteService;
  }
}

function readyInstruction(instruction = SELECTED_OPTION) {
  return {
    schema_version: 'image_instruction.v1',
    status: 'ready',
    instruction,
    clarification: '',
  };
}

function testPipelineMaterializesSelectedOptionBeforeTextToImageDispatch() {
  return runPipeline({
    input: '按照方案A重新生成',
    materialization: readyInstruction(),
  }).then(({ result, requests }) => {
    assert.deepStrictEqual(requests, ['intent_recognition', 'image_instruction_materialization']);
    assert.strictEqual(result.dispatchAuthorized, true);
    assert.ok(result.dispatchContract.arguments.prompt.includes(SELECTED_OPTION));
    assert.ok(!result.dispatchContract.arguments.prompt.includes(UNSELECTED_OPTION));
    assert.ok(!result.dispatchContract.arguments.prompt.includes('按照方案A'));
  });
}

function testPipelineMaterializesEditInstructionBeforeDispatch() {
  return runPipeline({
    operation: 'edit_image',
    input: '按照方案A编辑这张图',
    attachments: [{ type: 'image/png', image_id: 'target-image', resource_id: 'res:image:target-image', name: 'target.png' }],
    resourceRefs: [{ candidate_key: 'i1', role: 'target' }],
    materialization: readyInstruction('保留人物姿态和服装，将背景改为黄昏海边，加入电影感侧逆光与浅景深。'),
  }).then(({ result, requests }) => {
    assert.deepStrictEqual(requests, ['intent_recognition', 'image_instruction_materialization']);
    assert.strictEqual(result.dispatchAuthorized, true);
    assert.doesNotMatch(result.dispatchContract.arguments.prompt, /方案A|这张图/);
    assert.deepStrictEqual(result.dispatchContract.bindings.map(binding => ({ type: binding.type, role: binding.role })), [
      { type: 'image', role: 'target' },
    ]);
  });
}

function testMultiImageSelectionMaterializesBeforePlanningAndNeverForwardsTheRawReference() {
  const imagePlan = {
    schema_version: 'image_plan.v1',
    tasks: [
      {
        task_type: 'generate',
        prompt: `${SELECTED_OPTION}，正面广角视角，晴朗黄昏氛围。`,
        input_images: [],
        quality: 'auto',
        background: 'auto',
        output_format: 'auto',
      },
      {
        task_type: 'generate',
        prompt: `${SELECTED_OPTION}，鸟瞰视角，突出浅水景观池与疏朗绿植。`,
        input_images: [],
        quality: 'auto',
        background: 'auto',
        output_format: 'auto',
      },
    ],
  };
  return runPipeline({
    input: '按照方案A生成两张不同角度的图',
    taskShape: 'multi',
    materialization: readyInstruction(),
    imagePlan,
  }).then(({ result, requests, requestPayloads }) => {
    assert.deepStrictEqual(requests, [
      'intent_recognition',
      'image_instruction_materialization',
      'intent_recognition',
    ]);
    const plannerPayload = requestPayloads.find(request => request.payload.text?.format?.name === 'chatui_image_plan_v1')?.payload;
    assert.ok(plannerPayload, 'the multi-image planner must run after instruction materialization');
    const plannerEnvelope = JSON.parse(plannerPayload.input.find(item => item.role === 'user').content);
    assert.strictEqual(plannerEnvelope.current_input, undefined,
      'the planner must not receive the raw conversational selection as executable input');
    assert.strictEqual(plannerEnvelope.route_goal, SELECTED_OPTION);
    assert.strictEqual(result.imagePlanCompiled.kind, 'batch');
    for (const item of result.imagePlanCompiled.items) {
      assert.ok(item.dispatchContract.arguments.prompt.includes(SELECTED_OPTION));
      assert.ok(!item.dispatchContract.arguments.prompt.includes('按照方案A'));
      assert.ok(!item.dispatchContract.arguments.prompt.includes(UNSELECTED_OPTION));
    }
  });
}

function testPipelineStopsWhenReadyMaterializationStillContainsAConversationReference() {
  return runPipeline({
    input: '按照方案A重新生成',
    materialization: readyInstruction('按照方案A重新生成'),
  }).then(({ result, requests }) => {
    assert.deepStrictEqual(requests, ['intent_recognition', 'image_instruction_materialization']);
    assert.strictEqual(result.dispatchAuthorized, false);
    assert.strictEqual(result.dispatchContract, null);
    assert.strictEqual(result.readiness, 'failed');
  });
}

function testPipelineStopsWhenInstructionMaterializerNeedsClarification() {
  return runPipeline({
    input: '按照方案C重新生成',
    materialization: {
      schema_version: 'image_instruction.v1',
      status: 'needs_clarification',
      instruction: '',
      clarification: '没有找到方案C的明确内容，请确认要采用哪一项。',
    },
  }).then(({ result, requests }) => {
    assert.deepStrictEqual(requests, ['intent_recognition', 'image_instruction_materialization']);
    assert.strictEqual(result.dispatchAuthorized, false);
    assert.strictEqual(result.dispatchContract, null);
    assert.match(result.clarificationQuestion, /方案C/);
  });
}

module.exports = [
  testPipelineMaterializesSelectedOptionBeforeTextToImageDispatch,
  testPipelineMaterializesEditInstructionBeforeDispatch,
  testMultiImageSelectionMaterializesBeforePlanningAndNeverForwardsTheRawReference,
  testPipelineStopsWhenReadyMaterializationStillContainsAConversationReference,
  testPipelineStopsWhenInstructionMaterializerNeedsClarification,
];
