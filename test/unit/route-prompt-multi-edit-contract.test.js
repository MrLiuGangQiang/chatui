
'use strict';

const assert = require('assert');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const routeService = require('../../client/services/route-service');

function routeResponse(value) {
  return { choices: [{ message: { content: JSON.stringify(value) } }] };
}

function imageContext(count) {
  return {
    recent_messages: [{ index: 1, role: 'assistant', content: `[图片生成完成] ${count} 张图片` }],
    image_candidates: Array.from({ length: count }, (_, index) => ({
      candidate_key: `i${index + 1}`,
      index: index + 1,
      source_index: index + 1,
      source: 'history',
      image_id: `multi-edit-${count}-${index + 1}`,
      reference_id: `multi-edit-reference-${count}`,
      target: 'previous',
      description: `第 ${index + 1} 张图片`,
    })),
    file_candidates: [],
  };
}

async function runIndependentEditRoute(count) {
  const input = `把这 ${count} 张图片分别改成黑白效果`;
  const context = imageContext(count);
  const intent = {
    operation: 'edit_image',
    relation: 'followup',
    goal: input,
    resource_refs: Array.from({ length: count }, (_, index) => ({
      candidate_key: `i${index + 1}`,
      role: 'target',
    })),
    task_shape: 'multi',
  };
  const plan = {
    schema_version: 'image_plan.v1',
    tasks: Array.from({ length: count }, (_, index) => ({
      task_type: 'edit',
      prompt: `将第 ${index + 1} 张图片改成黑白效果，保留原有主体和构图。`,
      input_images: [{ candidate_key: `i${index + 1}`, role: 'target' }],
      quality: 'auto',
      background: 'auto',
      output_format: 'auto',
      count: 1,
    })),
  };
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: 'route-model',
      chatModel: 'chat-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    requestJson: async (url, payload) => {
      calls.push({ url, payload });
      const formatName = payload.text?.format?.name;
      if (formatName === 'chatui_route_intent_v3') return routeResponse(intent);
      if (formatName === 'chatui_image_instruction_v1') {
        return routeResponse({
          schema_version: 'image_instruction.v1',
          status: 'ready',
          instruction: '将已绑定的每张目标图片分别转换为黑白效果，保留各自原有主体和构图。',
          clarification: '',
        });
      }
      if (formatName === 'chatui_image_plan_v1') return routeResponse(plan);
      throw new Error(`unexpected structured request: ${formatName || '<missing>'}`);
    },
  });
  const route = await workflow.getEffectiveRoute(input, [], `multi-edit-${count}`, null, context, {});
  return { route, calls };
}

function assertIndependentEditBatch({ route, calls }, count) {
  assert.strictEqual(calls.length, 3, 'independent edits require route classification, instruction materialization, and one image-plan call');
  assert.strictEqual(calls[1].payload.text?.format?.name, 'chatui_image_instruction_v1');
  assert.strictEqual(calls[2].payload.text?.format?.name, 'chatui_image_plan_v1');
  assert.strictEqual(route.operationType, 'edit_image');
  assert.strictEqual(route.taskShape, 'multi');
  assert.strictEqual(route.needClarification, false);
  assert.strictEqual(route.imagePlanCompiled?.kind, 'batch');
  assert.strictEqual(route.imagePlanCompiled.items.length, count);
  assert.deepStrictEqual(route.imagePlanCompiled.items.map(item => item.operation), Array(count).fill('edit_image'));
  assert.deepStrictEqual(route.imagePlanCompiled.items.map(item => item.dispatchContract.bindings.map(binding => binding.role)),
    Array.from({ length: count }, () => ['target']));
  assert.deepStrictEqual(route.imagePlanCompiled.items.map(item => item.dispatchContract.bindings[0].resource_id),
    Array.from({ length: count }, (_, index) => `res:image:multi-edit-${count}-${index + 1}`));
}

async function testMainRoutePreservesTwoIndependentImageEdits() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    assertIndependentEditBatch(await runIndependentEditRoute(2), 2);
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testMainRoutePreservesFourIndependentImageEdits() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    assertIndependentEditBatch(await runIndependentEditRoute(4), 4);
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}


function testRoutePromptDefinesMultiAsIndependentExecutionAndGatesNonImageSplits() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /task_shape描述本轮需要几次独立执行，而不是资源数量/);
  assert.match(prompt, /task_shape：multi=多个独立执行/);
  assert.match(prompt, /对于可直接执行的图片生成\/编辑任务，multi=多个独立图片结果/);
  assert.match(prompt, /多图看\/比\/OCR\/汇总→single/);
  assert.match(prompt, /非图片或跨operation的多个必做步骤.*task_shape=multi.*需要拆分/);
  assert.match(prompt, /operation 填第一个必做步骤.*goal 保留全部任务/);
  assert.match(prompt, /不会进入图片规划或授权图片批次/);
}
function testRoutePromptSeparatesEditTargetsFromReferenceGeneration() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /多图分别改→edit_image\+multi\(target各绑\)/);
  assert.match(prompt, /共同参考生一张→image_reference_gen\+single/);
  assert.match(prompt, /分别参考生多张→image_reference_gen\+multi/);
  assert.doesNotMatch(prompt, /多图编辑用 image_reference_gen/);
}

module.exports = [
  testMainRoutePreservesTwoIndependentImageEdits,
  testMainRoutePreservesFourIndependentImageEdits,
  testRoutePromptDefinesMultiAsIndependentExecutionAndGatesNonImageSplits,
  testRoutePromptSeparatesEditTargetsFromReferenceGeneration,
];
