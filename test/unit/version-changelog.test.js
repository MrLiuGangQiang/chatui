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
  assert.ok(releases.some(item => item.version === 'v1.10.4'));
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
  assert.ok(index.includes('id="markAllChangelogReadBtn"'));
  assert.ok(index.includes('./client/ui/version-changelog.js'));
}

async function testVersionChangelogMarksAllReleasesRead() {
  const dom = new JSDOM('<button id="version" data-version-changelog></button><div id="changelogModal"><button id="markAllChangelogReadBtn"></button><button id="closeChangelogBtn"></button><div id="changelogContent"></div></div>', { url: 'https://chatui.test' });
  const releases = [{ version: 'v1.9.7', body: '# v1.9.7' }, { version: 'v1.9.6', body: '# v1.9.6' }];
  const controller = createVersionChangelogController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => ({ ok: true, json: async () => ({ releases }) }),
  });
  controller.bind();
  await controller.load();

  const content = dom.window.document.getElementById('changelogContent');
  const markAll = dom.window.document.getElementById('markAllChangelogReadBtn');
  assert.strictEqual(content.querySelectorAll('.changelog-entry.is-unread').length, 2);
  assert.strictEqual(markAll.disabled, false);
  markAll.click();
  assert.strictEqual(content.querySelectorAll('.changelog-entry.is-unread').length, 0);
  assert.strictEqual(content.querySelectorAll('.changelog-unread-badge').length, 0);
  assert.strictEqual(markAll.disabled, true);
  assert.deepStrictEqual(JSON.parse(dom.window.localStorage.getItem('chatui-changelog-read-v1')).sort(), ['v1.9.6', 'v1.9.7']);
  assert.strictEqual(dom.window.document.getElementById('version').classList.contains('has-unread-changelog'), false);
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
  assert.strictEqual(content.querySelector('.changelog-entry-version').textContent, 'v1.9.6');
  assert.strictEqual(content.textContent.includes('v1.9.6 ChatUI v1.9.6'), false, 'the version title must not be duplicated');
  assert.strictEqual(content.querySelector('.changelog-entry').open, true, 'the newest release is expanded');
}

async function testVersionChangelogLazilyRendersCollapsedReleaseCards() {
  const dom = new JSDOM('<div id="changelogModal"><button id="closeChangelogBtn"></button><div id="changelogContent"></div></div>');
  let renderCalls = 0;
  const releases = Array.from({ length: 14 }, (_, index) => ({
    version: `v1.0.${14 - index}`,
    title: `ChatUI v1.0.${14 - index}`,
    body: `# ChatUI v1.0.${14 - index}\n\n## 更新\n\n| 类型 | 内容 |\n| --- | --- |\n| 修复 | 第 ${index + 1} 项 |`,
  }));
  const controller = createVersionChangelogController({
    document: dom.window.document,
    renderMarkdown() {
      renderCalls += 1;
      return '<h2>更新</h2><table><tbody><tr><td>修复</td></tr></tbody></table>';
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ releases }) }),
  });

  await controller.load();
  const content = dom.window.document.getElementById('changelogContent');
  assert.strictEqual(content.querySelectorAll('.changelog-entry').length, 12, 'only the first release batch is mounted');
  assert.strictEqual(renderCalls, 1, 'only the open latest release is rendered');
  const entries = content.querySelectorAll('.changelog-entry');
  assert.strictEqual(entries[0].open, true);
  assert.strictEqual(entries[1].open, false);
  assert.ok(entries[0].querySelector('.changelog-table-wrap'), 'release tables receive a bounded scroll wrapper');
  const more = content.querySelector('.changelog-more');
  assert.match(more.textContent, /剩余 2 个/);
  more.click();
  assert.strictEqual(content.querySelectorAll('.changelog-entry').length, 14);
  assert.strictEqual(content.querySelector('.changelog-more'), null);
  entries[1].open = true;
  entries[1].dispatchEvent(new dom.window.Event('toggle'));
  assert.strictEqual(renderCalls, 2, 'an older release renders when expanded');
}

function testVersionChangelogHasDedicatedResponsiveReadingStyles() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8').replace(/\r\n?/g, '\n').replace(/\r\n?/g, '\n');
  assert.ok(css.includes('.changelog-entry[open] .changelog-entry-chevron'));
  assert.ok(css.includes('.changelog-table-wrap'));
  assert.ok(css.includes('.changelog-more'));
  assert.ok(css.includes('@media (max-width: 640px)'));
  const changelogLayer = Number(css.match(/\.changelog-modal\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  const routeButtonLayer = Number(css.match(/\.route-diagram-fab\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  const routeModalLayer = Number(css.match(/\.route-diagram-modal\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  assert.ok(changelogLayer > routeButtonLayer, 'the changelog must cover persistent floating controls');
  assert.ok(changelogLayer < routeModalLayer, 'the route diagram remains the top-level modal');
}

function testMobileRouteMapAndModelSelectScrolling() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles.css'), 'utf8');
  const customSelect = fs.readFileSync(path.join(__dirname, '../../client/app/custom-select-workflow.js'), 'utf8');
  assert.ok(css.includes('@media (max-width:640px){#routeDiagramFab,#supportedFilesFab{display:none!important}'));
  assert.ok(css.includes('touch-action:pan-y'), 'model menus must preserve vertical touch scrolling');
  assert.ok(customSelect.includes("item.addEventListener('pointerdown', event => event.stopPropagation())"));
  assert.ok(!customSelect.includes("item.addEventListener('pointerdown', event => { event.preventDefault()"), 'option pointerdown must not cancel mobile scrolling');
}

module.exports = [
  testReleaseNotesAreVersionSortedAndBounded,
  testVersionChangelogIsWiredToTheVersionBadges,
  testVersionChangelogRendersMarkdownThroughTheSharedRenderer,
  testVersionChangelogMarksAllReleasesRead,
  testVersionChangelogLazilyRendersCollapsedReleaseCards,
  testVersionChangelogHasDedicatedResponsiveReadingStyles,
  testMobileRouteMapAndModelSelectScrolling,
];
