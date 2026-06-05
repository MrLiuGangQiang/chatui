#!/usr/bin/env node
const assert = require('assert');
const routeWorkflow = require('../../client/app/route-decision-workflow');

const calls = { request: 0, local: 0, payload: null };
const routeDecision = routeWorkflow.createRouteDecisionWorkflow({
  state: { autoMode: false, mode: 'image', activeSessionId: 's1', sessions: [], messages: [], attachments: [] },
  getConfig: () => ({ baseUrl: 'https://api.example.test/v1', chatModel: 'router', routeModel: '', apiKey: 'k' }),
  buildRequestHeaders: () => ({ 'x-test': '1' }),
  hasImageAttachments: () => false,
  buildRouteAttachmentMetadata: attachments => attachments,
  buildRouteContext: () => ({}),
  latestImageReferenceMeta: () => ({ target: 'none' }),
  collectRecentImageReferences: () => [],
  normalizeRoute: route => ({ mode: route.mode || 'chat', target: route.target || 'none', contextualImagePrompt: route.contextual_image_prompt || route.contextualImagePrompt || '', confidence: route.confidence || 0, evidence: route.evidence || '' }),
  parseRouteResult: text => JSON.parse(text),
  requestJson: async (_url, payload) => { calls.request += 1; calls.payload = payload; return { choices: [{ message: { content: '{"mode":"chat","target":"none","confidence":0.9}' } }] }; },
});

global.window = {
  ChatUIServices: {
    route: {
      buildRoutePayload: ({ model, input, currentMode, autoMode }) => ({ model, messages: [{ role: 'user', content: JSON.stringify({ input, currentMode, autoMode }) }] }),
      extractRouteText: result => result.choices[0].message.content,
      inferLocalImageRoute: () => { calls.local += 1; return { mode: 'image', target: 'new' }; },
    },
  },
};

(async () => {
  const route = await routeDecision.getEffectiveRoute('随便聊聊', [], 's1');
  assert.strictEqual(calls.request, 1, 'all modes should call intent router model');
  assert.strictEqual(calls.local, 0, 'local route fallback must not run');
  assert.strictEqual(route.mode, 'chat', 'model decision is authoritative even when current mode is image');
  const userPayload = JSON.parse(calls.payload.messages[0].content);
  assert.strictEqual(userPayload.currentMode, 'image');
  assert.strictEqual(userPayload.autoMode, false);
  console.log('route model authoritative ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
