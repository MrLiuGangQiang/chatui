#!/usr/bin/env node
const assert = require('assert');
const routeWorkflow = require('../../client/app/route-decision-workflow');

const calls = { local: 0, request: 0 };
const routeDecision = routeWorkflow.createRouteDecisionWorkflow({
  state: { autoMode: true, mode: 'chat', activeSessionId: 's1', attachments: [] },
  getConfig: () => ({ baseUrl: 'https://api.example.test/v1', chatModel: 'router', routeModel: '', apiKey: 'k' }),
  buildRequestHeaders: () => ({ 'x-test': '1' }),
  hasImageAttachments: () => false,
  buildRouteAttachmentMetadata: attachments => attachments,
  buildRouteContext: () => ({}),
  normalizeRoute: route => ({ mode: route.mode || 'chat', target: route.target || 'none', contextualImagePrompt: route.contextual_image_prompt || route.contextualImagePrompt || '', confidence: route.confidence || 0, evidence: route.evidence || '' }),
  parseRouteResult: text => JSON.parse(text),
  requestJson: async () => { calls.request += 1; return { choices: [{ message: { content: '{"mode":"chat","target":"none","confidence":0.9}' } }] }; },
});

global.window = {
  ChatUIServices: {
    route: {
      buildRoutePayload: ({ model, input }) => ({ model, messages: [{ role: 'user', content: input }] }),
      extractRouteText: result => result.choices[0].message.content,
      inferLocalImageRoute: () => {
        calls.local += 1;
        return { mode: 'image', target: 'new', contextualImagePrompt: '不应使用本地兜底覆盖模型判断' };
      },
    },
  },
};

(async () => {
  const route = await routeDecision.getEffectiveRoute('生成两张图片：一个红色圆点，一个黑色圆点', [], 's1');
  assert.strictEqual(calls.request, 1, 'model router is attempted');
  assert.strictEqual(calls.local, 0, 'local image fallback must not override model route decision');
  assert.strictEqual(route.mode, 'chat', 'model route decision is authoritative');
  console.log('image route local fallback disabled ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
