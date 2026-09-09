'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseAnnouncementDocument, readAnnouncements } = require('../../server/services/announcements.service');

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
  assert.ok(index.includes('gpt-6-astra'), 'intent recognition must recommend gpt-6-astra');
  assert.doesNotMatch(index, /deepseek-v4-flash/, 'DeepSeek must not be recommended for intent recognition');

  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(app.includes('welcome-model-note'));
  assert.ok(app.includes('gpt-6-astra'), 'welcome page must recommend gpt-6-astra for intent recognition');
  assert.ok(app.includes('推荐模型：意图 gpt-6-astra / 聊天 gpt-6-astra / 生图 gpt-image-2 ｜ 处理文档、联网搜索请使用 GPT 系列。'), 'welcome recommendation must remain plain UTF-8 text');
  assert.doesNotMatch(app, /deepseek-v4-flash/, 'welcome page must not recommend DeepSeek for intent recognition');
  for (const model of ['gpt-6-astra', 'gpt-image-2']) {
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


function testLatestAnnouncementVersionTracksCanonicalVersion() {
  const root = path.join(__dirname, '../..');
  const canonicalVersion = require(path.join(root, 'version.json')).version;
  const announcements = readAnnouncements({ root });
  assert.ok(announcements.length > 0);
  assert.strictEqual(announcements[0].version, `v${canonicalVersion}`);
  assert.ok(announcements[0].body.includes('gpt-6-astra'));
  assert.ok(!announcements[0].body.includes('**重要模型更新：**'), 'the announcement title must not be repeated in the body');
  assert.ok(announcements[0].body.includes('<h2 style="color:#3152d4;">重要模型更新</h2>'), 'the model update body heading must be visible and highlighted');
  assert.strictEqual(announcements[0].summary, '', 'the latest announcement must not repeat the model update in a top summary');
  for (const developerTerm of ['REDIS_URL', '多副本', '实例', 'System Prompt', 'OCR', 'KaTeX', 'Mermaid', '发版']) {
    assert.ok(!announcements[0].body.includes(developerTerm), `latest announcement must not expose developer term ${developerTerm}`);
  }
  assert.ok(announcements[0].body.includes('无论你访问哪个服务节点，看到的在线人数都会保持一致并实时更新'));
  assert.ok(announcements[0].body.includes('版本更新'), 'the retained update section must keep its body heading');
  for (const section of ['历史能力与使用建议', '核心能力', '智能意图路由', '图片生成与编辑', '多模态与文件', '联网搜索', '会话与数据', '使用建议']) {
    assert.ok(announcements[0].body.includes(section), `latest announcement must retain ${section}`);
  }
  assert.doesNotMatch(announcements[0].body, /v\d+\.\d+\.\d+/, 'announcement content must not hardcode its version');
}

module.exports = [
  testAnnouncementKeepsRecommendedModelConfigOnlyInSidebar,
  testHistoricalModelRecommendationsUseTerraForIntentRecognition,
  testLatestAnnouncementVersionTracksCanonicalVersion,
];
