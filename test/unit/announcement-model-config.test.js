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
  for (const model of ['deepseek-v4-flash', 'gpt-5.6-luna', 'gpt-image-2']) {
    assert.ok(index.includes(model));
  }
}

module.exports = [
  testAnnouncementKeepsRecommendedModelConfigOnlyInSidebar,
];
