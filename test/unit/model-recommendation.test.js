'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const {
  DEFAULT_MODEL_RECOMMENDATION,
  MAX_MODEL_NAME_LENGTH,
  normalizeModelRecommendation,
} = require('../../shared/model-recommendation');
const { readModelRecommendation } = require('../../server/services/model-recommendation.service');
const { applyModelRecommendation, registerWithAppContext } = require('../../client/ui/model-recommendation');

function testModelRecommendationFileOverridesRuntimeDefaults() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-model-recommendation-'));
  const filePath = path.join(root, 'model-recommendation.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      route_model: 'route-next',
      chat_model: 'chat-next',
      image_model: 'image-next',
      note: '使用新版模型。',
    }), 'utf8');
    assert.deepStrictEqual(readModelRecommendation({ filePath }), {
      routeModel: 'route-next',
      chatModel: 'chat-next',
      imageModel: 'image-next',
      note: '使用新版模型。',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testInvalidModelRecommendationFallsBackToDefaults() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-model-recommendation-invalid-'));
  const filePath = path.join(root, 'model-recommendation.json');
  try {
    fs.writeFileSync(filePath, '{ invalid json', 'utf8');
    assert.deepStrictEqual(readModelRecommendation({ filePath }), DEFAULT_MODEL_RECOMMENDATION);
    assert.deepStrictEqual(readModelRecommendation({ filePath: path.join(root, 'missing.json') }), DEFAULT_MODEL_RECOMMENDATION);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testModelRecommendationNormalizesUnsafeTextAndLengths() {
  const normalized = normalizeModelRecommendation({
    route_model: `  route\u0000name  `,
    chat_model: 'x'.repeat(MAX_MODEL_NAME_LENGTH + 20),
    image_model: '',
    note: 'note\u0007text',
  });
  assert.strictEqual(normalized.routeModel, 'route name');
  assert.strictEqual(normalized.chatModel.length, MAX_MODEL_NAME_LENGTH);
  assert.strictEqual(normalized.imageModel, DEFAULT_MODEL_RECOMMENDATION.imageModel);
  assert.strictEqual(normalized.note, 'note text');
}

function testModelRecommendationUpdatesAnnouncementAndWelcomeText() {
  const dom = new JSDOM(`<!doctype html><body>
    <span data-model-recommendation="routeModel"></span>
    <span data-model-recommendation="chatModel"></span>
    <span data-model-recommendation="imageModel"></span>
    <p class="welcome-model-note"></p>
  </body>`);
  applyModelRecommendation(dom.window.document, {
    route_model: 'route-next',
    chat_model: 'chat-next',
    image_model: 'image-next',
    note: '请优先使用新版模型。',
  });
  assert.strictEqual(dom.window.document.querySelector('[data-model-recommendation="routeModel"]').textContent, 'route-next');
  assert.strictEqual(dom.window.document.querySelector('[data-model-recommendation="chatModel"]').textContent, 'chat-next');
  assert.strictEqual(dom.window.document.querySelector('[data-model-recommendation="imageModel"]').textContent, 'image-next');
  assert.strictEqual(
    dom.window.document.querySelector('.welcome-model-note').textContent,
    '推荐模型：意图 route-next / 聊天 chat-next / 生图 image-next ｜ 请优先使用新版模型。'
  );
}

function testModelRecommendationRegistersWithAppWorkflowRegistry() {
  const registrations = [];
  const moduleApi = Object.freeze({ applyModelRecommendation: () => null });
  const root = { ChatUIApp: { appContext: { registerWorkflowModule(name, api) { registrations.push({ name, api }); return api; } } } };
  assert.strictEqual(registerWithAppContext(root, moduleApi), true);
  assert.deepStrictEqual(registrations, [{ name: 'modelRecommendationUi', api: moduleApi }]);
  assert.strictEqual(registerWithAppContext({}, moduleApi), false);
}
function testModelRecommendationScriptsLoadBeforeConfigWorkflow() {
  const root = path.join(__dirname, '../..');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sharedIndex = index.indexOf('./shared/model-recommendation.js');
  const uiIndex = index.indexOf('./client/ui/model-recommendation.js');
  const configIndex = index.indexOf('./client/app/config-workflow.js');
  assert.ok(sharedIndex > 0 && uiIndex > sharedIndex && configIndex > uiIndex, 'recommendation scripts must load before config workflow');
  const recommendation = JSON.parse(fs.readFileSync(path.join(root, 'data/announcements/model-recommendation.json'), 'utf8'));
  for (const field of ['route_model', 'chat_model', 'image_model']) {
    assert.strictEqual(typeof recommendation[field], 'string');
    assert.ok(recommendation[field].trim(), `${field} must not be empty`);
  }
  assert.strictEqual(typeof recommendation.note, 'string');
}

module.exports = [
  testModelRecommendationFileOverridesRuntimeDefaults,
  testInvalidModelRecommendationFallsBackToDefaults,
  testModelRecommendationNormalizesUnsafeTextAndLengths,
  testModelRecommendationUpdatesAnnouncementAndWelcomeText,
  testModelRecommendationRegistersWithAppWorkflowRegistry,
  testModelRecommendationScriptsLoadBeforeConfigWorkflow,
];
