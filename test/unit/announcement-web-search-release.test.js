'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseAnnouncementDocument } = require('../../server/services/announcements.service');
const { createMarkdownEngine } = require('../../client/app/markdown/markdown-engine');

function bodyOf(document = '') {
  return parseAnnouncementDocument(document).body;
}

function testWebSearchAnnouncementCarriesPreviousContentAndVisibleHighlight() {
  const root = path.join(__dirname, '../..');
  const previous = fs.readFileSync(path.join(root, 'docs/announcements/v1.10.26.md'), 'utf8');
  const latest = fs.readFileSync(path.join(root, 'docs/announcements/v1.10.34.md'), 'utf8');
  const latestBody = bodyOf(latest);
  const previousBody = bodyOf(previous);

  assert.ok(latestBody.includes(previousBody), 'the new announcement must retain the complete previous announcement body');
  assert.match(latestBody, /支持联网搜索/);
  assert.match(latestBody, /style="[^"]*color:\s*#[0-9a-f]{6}/i);

  const rendered = createMarkdownEngine().render(latestBody);
  assert.match(rendered, /style="color: #f97316; font-weight: 700"/);
  assert.match(rendered, /style="color: #ef4444; font-weight: 700"/);
}

module.exports = [
  testWebSearchAnnouncementCarriesPreviousContentAndVisibleHighlight,
];
