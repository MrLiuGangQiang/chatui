'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { readReleaseNotes } = require('../../server/services/release-notes.service');
const { createVersionChangelogController } = require('../../client/ui/version-changelog');

function testReleaseNotesAreVersionSortedAndBounded() {
  const releases = readReleaseNotes({ root: path.join(__dirname, '../..') });
  assert.ok(releases.length > 0);
  assert.ok(releases.some(item => item.version === 'v1.9.6'));
  for (let index = 1; index < releases.length; index += 1) {
    const previous = releases[index - 1].version.replace(/^v/, '').split('.').slice(0, 3).map(Number);
    const current = releases[index].version.replace(/^v/, '').split('.').slice(0, 3).map(Number);
    assert.ok(previous[0] > current[0] || (previous[0] === current[0] && (previous[1] > current[1] || (previous[1] === current[1] && previous[2] >= current[2]))));
  }
}

function testVersionChangelogIsWiredToTheVersionBadges() {
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(index.includes('data-version-changelog'));
  assert.ok(index.includes('id="changelogModal"'));
  assert.ok(index.includes('./client/ui/version-changelog.js'));
}

async function testVersionChangelogRendersMarkdownThroughTheSharedRenderer() {
  const dom = new JSDOM('<button id="version" data-version-changelog></button><div id="changelogModal"><button id="closeChangelogBtn"></button><div id="changelogContent"></div></div>');
  let renderCalls = 0;
  const controller = createVersionChangelogController({
    document: dom.window.document,
    renderMarkdown(markdown) {
      renderCalls += 1;
      return `<h2>${markdown.includes('## 新增') ? '新增' : '内容'}</h2><ul><li>安全内容</li></ul>`;
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ releases: [{ version: 'v1.9.6', title: 'ChatUI v1.9.6', body: '# ChatUI v1.9.6\n\n## 新增\n\n- 支持 Markdown' }] }) }),
  });
  controller.bind();
  controller.open(dom.window.document.getElementById('version'));
  await new Promise(resolve => setImmediate(resolve));
  const content = dom.window.document.getElementById('changelogContent');
  assert.strictEqual(renderCalls, 1);
  assert.ok(content.querySelector('h2'));
  assert.strictEqual(content.textContent.includes('## 新增'), false);
}

module.exports = [testReleaseNotesAreVersionSortedAndBounded, testVersionChangelogIsWiredToTheVersionBadges, testVersionChangelogRendersMarkdownThroughTheSharedRenderer];
