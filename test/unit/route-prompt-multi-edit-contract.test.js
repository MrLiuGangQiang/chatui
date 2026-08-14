
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
      size: 'auto',
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
      return calls.length === 1 ? routeResponse(intent) : routeResponse(plan);
    },
  });
  const route = await workflow.getEffectiveRoute(input, [], `multi-edit-${count}`, null, context, {});
  return { route, calls };
}

function assertIndependentEditBatch({ route, calls }, count) {
  assert.strictEqual(calls.length, 2, 'independent edits require route classification plus one image-plan call');
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


function testRoutePromptKeepsCrossOperationStepsVisible() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /multi=独立dispatch\/结果或跨operation步骤/);
  assert.match(prompt, /跨operation取首个必做步骤/);
  assert.match(prompt, /不跳前置/);
  assert.match(prompt, /图片multi[^。\n]*其他multi[^。\n]*拆分/);
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
  testRoutePromptKeepsCrossOperationStepsVisible,
  testRoutePromptSeparatesEditTargetsFromReferenceGeneration,
];
