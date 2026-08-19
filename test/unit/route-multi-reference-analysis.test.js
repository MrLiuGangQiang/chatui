'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

const INTENT_FORMAT = 'chatui_route_intent_v3';
const INSTRUCTION_FORMAT = 'chatui_image_instruction_v1';

function attachment(id, index) {
  return {
    id, imageId: id, name: `${id}.png`, type: 'image/png',
    dataUrl: `data:image/png;base64,${id}`,
    sourceIndex: index,
    routeResourceId: `res:image:${id}`,
  };
}

function createWorkflow({ intentOperation, refs, analysisOutput = '深色渐变科技风封面：深蓝渐变背景，金色大标题，底部三条政策卡片。', analysisError = null }) {
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    requestJson: async (_url, payload) => {
      const formatName = payload?.text?.format?.name || '';
      calls.push(formatName || 'plain-analysis');
      if (formatName === INTENT_FORMAT) {
        return { output_text: JSON.stringify({ operation: intentOperation, relation: 'new', goal: 'goal', goal_mode: 'replace', task_shape: 'single', resource_refs: refs }) };
      }
      if (formatName === INSTRUCTION_FORMAT) {
        return { output_text: JSON.stringify({ schema_version: 'image_instruction.v1', status: 'ready', instruction: 'goal', clarification: '' }) };
      }
      if (analysisError) throw analysisError;
      return { output_text: analysisOutput };
    },
  });
  return { workflow, calls };
}

async function getRoute(workflow, attachments) {
  return workflow.getEffectiveRoute('goal', attachments, 'session-multi-ref');
}

async function testMultiReferenceTaskDecomposesToTextToImage() {
  const { workflow, calls } = createWorkflow({
    intentOperation: 'image_reference_gen',
    refs: [
      { candidate_key: 'i1', role: 'reference' },
      { candidate_key: 'i2', role: 'reference' },
    ],
  });
  const route = await getRoute(workflow, [attachment('img1', 1), attachment('img2', 2)]);
  assert.ok(calls.includes('plain-analysis'), 'multi-reference tasks must run the reference analysis model call');
  assert.strictEqual(route.operationType, 'text_to_image', 'multi-reference tasks decompose to single-image generation');
  assert.deepStrictEqual(route.resources, []);
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
  assert.match(route.dispatchContract.arguments.prompt, /^请生成一张图片：/);
  assert.strictEqual(route.referenceAnalysisSource, 'image_reference_gen');
}

async function testSingleImageEditStaysDirect() {
  const { workflow, calls } = createWorkflow({
    intentOperation: 'edit_image',
    refs: [
      { candidate_key: 'i1', role: 'target' },
      { candidate_key: 'i2', role: 'mask' },
    ],
  });
  const route = await getRoute(workflow, [attachment('target1', 1), attachment('mask1', 2)]);
  assert.ok(!calls.includes('plain-analysis'), 'single-image edits must not run the reference analysis');
  assert.strictEqual(route.operationType, 'edit_image');
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
}

async function testSingleReferenceStaysDirect() {
  const { workflow, calls } = createWorkflow({
    intentOperation: 'image_reference_gen',
    refs: [{ candidate_key: 'i1', role: 'reference' }],
  });
  const route = await getRoute(workflow, [attachment('img1', 1)]);
  assert.ok(!calls.includes('plain-analysis'), 'single-reference tasks stay on the direct generation path');
  assert.strictEqual(route.operationType, 'image_reference_gen');
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
}

async function testMultiReferenceAnalysisFailureFailsClosed() {
  const { workflow } = createWorkflow({
    intentOperation: 'image_reference_gen',
    refs: [
      { candidate_key: 'i1', role: 'reference' },
      { candidate_key: 'i2', role: 'reference' },
    ],
    analysisError: Object.assign(new Error('analysis upstream failed'), { statusCode: 502 }),
  });
  const route = await getRoute(workflow, [attachment('img1', 1), attachment('img2', 2)]);
  assert.strictEqual(route.needClarification, false);
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.match(route.outcomeMessage, /参考图分析失败/);
}

module.exports = [
  testMultiReferenceTaskDecomposesToTextToImage,
  testSingleImageEditStaysDirect,
  testSingleReferenceStaysDirect,
  testMultiReferenceAnalysisFailureFailsClosed,
];
