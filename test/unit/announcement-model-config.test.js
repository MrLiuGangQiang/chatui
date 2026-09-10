'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testAnnouncementSidebarKeepsFallbackModelRecommendation() {
  const root = path.join(__dirname, '../..');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(index.includes('推荐模型配置'));
  assert.ok(index.includes('data-model-recommendation="routeModel"'));
  assert.ok(index.includes('data-model-recommendation="chatModel"'));
  assert.ok(index.includes('data-model-recommendation="imageModel"'));
  for (const model of ['gpt-6-astra', 'gpt-image-2']) assert.ok(index.includes(model));
  assert.doesNotMatch(index, /deepseek-v4-flash/, 'DeepSeek must not be recommended for intent recognition');
}

function testWelcomePageKeepsFallbackModelRecommendation() {
  const root = path.join(__dirname, '../..');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(app.includes('welcome-model-note'));
  assert.ok(app.includes('推荐模型：意图 gpt-6-astra / 聊天 gpt-6-astra / 生图 gpt-image-2 ｜ 处理文档、联网搜索请使用 GPT 系列。'));
  assert.doesNotMatch(app, /deepseek-v4-flash/, 'welcome page must not recommend DeepSeek for intent recognition');
}

function testRuntimeModelRecommendationFileHasEditableShape() {
  const root = path.join(__dirname, '../..');
  const recommendation = JSON.parse(fs.readFileSync(path.join(root, 'data/announcements/model-recommendation.json'), 'utf8'));
  for (const field of ['route_model', 'chat_model', 'image_model']) {
    assert.strictEqual(typeof recommendation[field], 'string');
    assert.ok(recommendation[field].trim(), `${field} must not be empty`);
  }
  assert.strictEqual(typeof recommendation.note, 'string');
}

module.exports = [
  testAnnouncementSidebarKeepsFallbackModelRecommendation,
  testWelcomePageKeepsFallbackModelRecommendation,
  testRuntimeModelRecommendationFileHasEditableShape,
];
