'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseAnnouncementDocument } = require('../../server/services/announcements.service');

function testAnnouncementKeepsRecommendedModelConfigOnlyInSidebar() {
  const root = path.join(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, 'docs/announcements/v1.10.85.md'), 'utf8');
  const announcement = parseAnnouncementDocument(source);

  // The formal body must not repeat the recommended model configuration.
  assert.doesNotMatch(announcement.body, /^##\s*推荐模型配置\s*$/m);
  assert.doesNotMatch(announcement.body, /deepseek-v4-flash|gpt-5\.6-luna|gpt-image-2/);
  assert.ok(!announcement.summary.includes('推荐模型配置'), 'summary must not promise a body section that no longer exists');

  // The static announcement side panel still provides the same concise reference.
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(index.includes('推荐模型配置'));
  assert.ok(index.includes('gpt-5.6-terra'), 'intent recognition must recommend gpt-5.6-terra');
  assert.doesNotMatch(index, /deepseek-v4-flash/, 'DeepSeek must not be recommended for intent recognition');

  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(app.includes('welcome-model-note'));
  assert.ok(app.includes('gpt-5.6-terra'), 'welcome page must recommend gpt-5.6-terra for intent recognition');
  assert.doesNotMatch(app, /deepseek-v4-flash/, 'welcome page must not recommend DeepSeek for intent recognition');
  for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-image-2']) {
    assert.ok(index.includes(model));
  }
}

function testHistoricalModelRecommendationsUseTerraForIntentRecognition() {
  const root = path.join(__dirname, '../..');
  for (const filename of ['docs/announcements/v1.10.26.md', 'docs/announcements/v1.10.34.md']) {
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    assert.ok(source.includes('gpt-5.6-terra'), `${filename} must recommend gpt-5.6-terra for intent recognition`);
    assert.doesNotMatch(source, /gpt-5\.6-luna/, `${filename} must not retain the old intent-model recommendation`);
  }
}

module.exports = [
  testAnnouncementKeepsRecommendedModelConfigOnlyInSidebar,
  testHistoricalModelRecommendationsUseTerraForIntentRecognition,
];
