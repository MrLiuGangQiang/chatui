'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

const USER_INPUT = '请结合附件和下面内容，帮我生成一页PPT图片\n政策信号已经从\"鼓励探索\"走向\"规模应用与安全治理\"\n建议不要堆叠政策原文，而是做成三层递进：\n国家战略：持续推进\"人工智能+\"\n2.png\n1.png';

const TWO_IMAGES = [
  { id: 'img1', imageId: 'img1', name: '1.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAAA', referenceId: 'imgref-1', sourceIndex: 1 },
  { id: 'img2', imageId: 'img2', name: '2.png', type: 'image/png', dataUrl: 'data:image/png;base64,BBBB', referenceId: 'imgref-2', sourceIndex: 2 },
];

function testGenericAttachmentGenerationCompilesDeterministicTextToImage() {
  const compiled = routeService.compileAttachmentTextGenerationRoute({
    input: USER_INPUT,
    attachments: TWO_IMAGES,
    context: {},
  });
  assert.strictEqual(compiled.reason, '');
  assert.strictEqual(compiled.route.operationType, 'text_to_image');
  assert.deepStrictEqual(compiled.route.resources, []);
  assert.strictEqual(routeService.isRouteDispatchable(compiled.route), true);
}

async function testGenericAttachmentGenerationSkipsTheIntentModel() {
  let modelCalls = 0;
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    requestJson: async () => {
      modelCalls += 1;
      throw new Error('the intent model must not be called for generic attachment text generation');
    },
  });

  const route = await workflow.getEffectiveRoute(USER_INPUT, TWO_IMAGES, 'session-attachment-gen');
  assert.strictEqual(modelCalls, 0, 'generic “结合附件+生成图片” must be routed deterministically without an intent-model call');
  assert.strictEqual(route.operationType, 'text_to_image');
  assert.deepStrictEqual(route.resources, []);
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
}

function testExplicitImageReferenceWordingStillUsesTheModel() {
  for (const input of [
    '请结合附件里的两张图，帮我生成一张新的海报',
    '参考这张海报的构图，生成一张水彩风格的版本。',
  ]) {
    const compiled = routeService.compileAttachmentTextGenerationRoute({
      input,
      attachments: TWO_IMAGES,
      context: {},
    });
    assert.strictEqual(compiled.route, null, `explicit image reference wording must not be downgraded locally: ${input}`);
  }
}

function testAttachmentTextGenerationGuidanceIsInTheRoutePrompt() {
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /附件与生图/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /结合附件/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /text_to_image/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /image_reference_gen/);
}

module.exports = [
  testGenericAttachmentGenerationCompilesDeterministicTextToImage,
  testGenericAttachmentGenerationSkipsTheIntentModel,
  testExplicitImageReferenceWordingStillUsesTheModel,
  testAttachmentTextGenerationGuidanceIsInTheRoutePrompt,
];
