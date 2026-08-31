'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

function imagePlanTask(prompt, taskType = 'generate') {
  return { task_type: taskType, prompt, input_images: [] };
}

function imagePlan(tasks) {
  return { schema_version: 'image_plan.v1', tasks };
}
async function testImagePlanUsesReturnedTasksWithoutCountRepair() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const calls = [];
  try {
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
      getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
      getSessionRouteModel: () => 'route-model',
      getSessionChatModel: () => 'chat-model',
      buildRouteAttachmentMetadata: () => [],
      requestJson: async (url, payload, apiKey, options = {}) => {
        const name = payload?.text?.format?.name;
        calls.push(name);
        if (name === 'chatui_intent_understanding_v1') {
          return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', dependency: 'new', actions: [{ index: 1, kind: 'image_generate', target: '五个视角的加菲猫', resolved_refs: [] }] }) };
        }
        if (name === 'chatui_route_intent_v3') {
          return { output_text: JSON.stringify({ operation: 'text_to_image', relation: 'new', goal: '五个视角的加菲猫', goal_mode: 'replace', resource_refs: [], task_shape: 'multi' }) };
        }
        if (name === 'chatui_image_plan_v1') {
          return { output_text: JSON.stringify(imagePlan([imagePlanTask('一只加菲猫')])) };
        }
        throw new Error('unexpected request ' + String(name || '<missing>'));
      },
    });

    const route = await workflow.getEffectiveRoute('按刚才的分别生成', [], 'session-1');

    assert.strictEqual(route.outcome, 'ready');
    assert.strictEqual(route.taskShape, 'single', 'the returned single-task plan must be used directly');
    assert.strictEqual(calls.filter(name => name === 'chatui_image_plan_v1').length, 1, 'no count-mismatch repair round should run');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testImagePlanCeilingGuardFailsClosedBeforeCallingThePlanner() {
  assert.strictEqual(routeService.IMAGE_PLAN_ABSOLUTE_MAX_TASKS, 50);
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const calls = [];
  try {
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
      getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
      getSessionRouteModel: () => 'route-model',
      getSessionChatModel: () => 'chat-model',
      buildRouteAttachmentMetadata: () => [],
      requestJson: async (url, payload, apiKey, options = {}) => {
        const name = payload?.text?.format?.name;
        calls.push(name);
        if (name === 'chatui_route_intent_v3') {
          return {
            output_text: JSON.stringify({
              operation: 'text_to_image',
              relation: 'new',
              goal: '生成 60 张猫',
              goal_mode: 'replace',
              resource_refs: [],
              task_shape: 'multi',
            }),
          };
        }
        if (name === 'chatui_image_plan_v1') {
          throw new Error('the planner must not run for an over-ceiling request');
        }
        throw new Error('unexpected request ' + String(name || '<missing>'));
      },
    });

    const route = await workflow.getEffectiveRoute('生成 60 张猫', [], 'session-1');

    assert.strictEqual(route.outcome, 'business_clarification');
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.match(route.clarificationQuestion, /一次最多生成 5 张/);
    assert.ok(!calls.includes('chatui_image_plan_v1'),
      'an over-ceiling request must fail closed before the image planner runs');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}
module.exports = [
  testImagePlanUsesReturnedTasksWithoutCountRepair,
  testImagePlanCeilingGuardFailsClosedBeforeCallingThePlanner,
];
