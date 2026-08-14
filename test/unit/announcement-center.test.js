'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { JSDOM } = require('jsdom');
const {
  READ_ANNOUNCEMENTS_KEY,
  createAnnouncementCenterController,
} = require('../../client/ui/announcement-center');
const {
  parseAnnouncementDocument,
  readAnnouncements,
} = require('../../server/services/announcements.service');

function announcementDom() {
  return new JSDOM(`<!doctype html><body class="announcement-pending">
    <div class="app shell-app" data-announcement-app inert aria-hidden="true">
      <button id="outsideAction" data-announcement-open type="button">公告</button>
    </div>
    <div id="announcementModal" class="announcement-modal show is-forced" aria-hidden="false">
      <div class="announcement-backdrop" data-close-announcement></div>
      <section class="announcement-dialog" role="dialog" tabindex="-1">
        <button id="closeAnnouncementBtn" type="button" hidden>关闭</button>
        <span id="announcementBadge"></span>
        <span id="announcementVersion"></span>
        <time id="announcementPublishedAt"></time>
        <h1 id="announcementTitle"></h1>
        <p id="announcementSummary"></p>
        <article id="announcementLatest"><div id="announcementBody"></div></article>
        <div id="announcementStatus"></div>
        <button id="announcementHistoryBtn" type="button" hidden aria-expanded="false"></button>
        <section id="announcementHistoryPanel" hidden><div id="announcementHistoryList"></div></section>
        <button id="acknowledgeAnnouncementBtn" type="button" disabled>我已阅读</button>
      </section>
    </div>
  </body>`, { url: 'https://chatui.test' });
}

function release(version, title = version) {
  return {
    version,
    title,
    summary: `${title} 摘要`,
    publishedAt: '2026-08-05',
    badge: '重要公告',
    body: `# ${title}\n\n## 变更\n\n- ${title} 内容`,
  };
}

function testAnnouncementDocumentParsesVersionedMetadata() {
  const parsed = parseAnnouncementDocument(`---\npublished_at: 2026-08-05\nbadge: 重要公告\nsummary: 一条重要通知\n---\n# 新公告\n\n正文`);
  assert.deepStrictEqual(parsed, {
    title: '新公告',
    summary: '一条重要通知',
    publishedAt: '2026-08-05',
    badge: '重要公告',
    body: '# 新公告\n\n正文',
  });
}

function testAnnouncementFilesAreCumulativeAndSortedByVersion() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-announcements-'));
  try {
    fs.mkdirSync(path.join(root, 'docs', 'announcements'), { recursive: true });
    for (const [version, title] of [['v1.0.0', '第一条'], ['v1.0.2', '第三条'], ['v1.0.1', '第二条']]) {
      fs.writeFileSync(path.join(root, 'docs', 'announcements', `${version}.md`), `# ${title}\n\n正文`);
    }
    fs.writeFileSync(path.join(root, 'docs', 'announcements', 'README.md'), '# ignored');
    const releases = readAnnouncements({ root });
    assert.deepStrictEqual(releases.map(item => item.version), ['v1.0.2', 'v1.0.1', 'v1.0.0']);
    assert.deepStrictEqual(releases.map(item => item.title), ['第三条', '第二条', '第一条']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const shipped = readAnnouncements({ root: path.join(__dirname, '../..') });
  assert.ok(shipped.length >= 1);
  assert.strictEqual(shipped[0].version, 'v1.10.34');
  assert.strictEqual(shipped[0].title, 'ChatUI 联网搜索能力上线');
  assert.ok(shipped.some(item => item.version === 'v1.0.1' && item.title === 'ChatUI 意图识别协议与问题反馈功能升级'));
  assert.ok(shipped.some(item => item.version === 'v1.0.0' && item.title === '全新公告中心上线'));
  assert.ok(shipped.every(item => item.body && item.version));
}

async function testUnreadLatestAnnouncementLocksTheApplicationUntilAcknowledged() {
  const dom = announcementDom();
  const releases = [release('v1.1.0', '最新公告'), release('v1.0.0', '旧公告')];
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => ({ ok: true, json: async () => ({ announcements: releases }) }),
    renderMarkdown: markdown => `<p>${markdown.replace(/^## /, '')}</p>`,
  });
  controller.bind();
  await controller.initialize();

  const modal = dom.window.document.getElementById('announcementModal');
  const shell = dom.window.document.querySelector('[data-announcement-app]');
  const acknowledge = dom.window.document.getElementById('acknowledgeAnnouncementBtn');
  const close = dom.window.document.getElementById('closeAnnouncementBtn');
  assert.strictEqual(modal.classList.contains('show'), true);
  assert.strictEqual(modal.classList.contains('is-forced'), true);
  assert.strictEqual(shell.hasAttribute('inert'), true);
  assert.strictEqual(dom.window.document.body.classList.contains('announcement-locked'), true);
  assert.strictEqual(acknowledge.disabled, false);
  assert.strictEqual(dom.window.document.getElementById('announcementTitle').textContent, '最新公告');

  dom.window.document.querySelector('[data-close-announcement]').click();
  assert.strictEqual(modal.classList.contains('show'), true, 'forced announcement cannot close through the backdrop');
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.strictEqual(modal.classList.contains('show'), true, 'forced announcement cannot close with Escape');

  acknowledge.click();
  assert.strictEqual(modal.classList.contains('show'), false);
  assert.strictEqual(shell.hasAttribute('inert'), false);
  assert.strictEqual(dom.window.document.body.classList.contains('announcement-locked'), false);
  assert.deepStrictEqual(JSON.parse(dom.window.localStorage.getItem(READ_ANNOUNCEMENTS_KEY)).sort(), ['v1.0.0', 'v1.1.0']);
  assert.strictEqual(dom.window.document.querySelector('[data-announcement-open]').getAttribute('data-unread-announcement'), '0');
}

async function testNewAnnouncementVersionResetsTheForcedGate() {
  const dom = announcementDom();
  dom.window.document.documentElement.classList.add('announcement-acknowledged-boot');
  dom.window.localStorage.setItem(READ_ANNOUNCEMENTS_KEY, JSON.stringify(['v1.0.0']));
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => ({ ok: true, json: async () => ({ announcements: [release('v1.1.0'), release('v1.0.0')] }) }),
  });
  controller.bind();
  await controller.initialize();
  assert.strictEqual(dom.window.document.getElementById('announcementModal').classList.contains('is-forced'), true);
  assert.strictEqual(dom.window.document.querySelector('[data-announcement-open]').getAttribute('data-unread-announcement'), '1');
}

async function testNewAnnouncementPublishedWhileOpenResetsGate() {
  const dom = announcementDom();
  let current = [release('v1.0.0', '初始公告')];
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => ({ ok: true, json: async () => ({ announcements: current }) }),
  });
  controller.bind();
  await controller.initialize();
  dom.window.document.getElementById('acknowledgeAnnouncementBtn').click();
  assert.strictEqual(dom.window.document.getElementById('announcementModal').classList.contains('show'), false);

  current = [release('v1.1.0', '运行中的新公告'), release('v1.0.0', '初始公告')];
  await controller.refresh();
  assert.strictEqual(dom.window.document.getElementById('announcementModal').classList.contains('show'), true);
  assert.strictEqual(dom.window.document.getElementById('announcementModal').classList.contains('is-forced'), true);
  assert.strictEqual(dom.window.document.getElementById('announcementTitle').textContent, '运行中的新公告');
}

async function testAcknowledgedAnnouncementsOpenAsNormalHistoryModal() {
  const dom = announcementDom();
  dom.window.localStorage.setItem(READ_ANNOUNCEMENTS_KEY, JSON.stringify(['v1.0.0', 'v1.1.0']));
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => ({ ok: true, json: async () => ({ announcements: [release('v1.1.0', '最新公告'), release('v1.0.0', '旧公告')] }) }),
    renderMarkdown: markdown => `<p>${markdown}</p>`,
  });
  controller.bind();
  await controller.initialize();
  const modal = dom.window.document.getElementById('announcementModal');
  assert.strictEqual(modal.classList.contains('show'), false);

  dom.window.document.getElementById('outsideAction').click();
  assert.strictEqual(modal.classList.contains('show'), true);
  assert.strictEqual(modal.classList.contains('is-forced'), false);
  assert.strictEqual(dom.window.document.getElementById('closeAnnouncementBtn').hidden, false);
  const historyButton = dom.window.document.getElementById('announcementHistoryBtn');
  assert.strictEqual(historyButton.hidden, false);
  historyButton.click();
  assert.strictEqual(dom.window.document.getElementById('announcementHistoryPanel').hidden, false);
  assert.strictEqual(dom.window.document.querySelectorAll('.announcement-history-entry').length, 1);
  dom.window.document.getElementById('closeAnnouncementBtn').click();
  assert.strictEqual(modal.classList.contains('show'), false);
}

async function testBackgroundRefreshKeepsRenderedAnnouncementVisibleWhileRequestIsPending() {
  const dom = announcementDom();
  let callCount = 0;
  let finishRefresh;
  const first = [release('v1.0.0', '已加载公告')];
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) return { ok: true, json: async () => ({ announcements: first }) };
      return new Promise(resolve => { finishRefresh = resolve; });
    },
  });
  controller.bind();
  await controller.initialize();
  controller.acknowledge();

  const refreshPromise = controller.refresh();
  const modal = dom.window.document.getElementById('announcementModal');
  const status = dom.window.document.getElementById('announcementStatus');
  const latest = dom.window.document.getElementById('announcementLatest');
  const acknowledge = dom.window.document.getElementById('acknowledgeAnnouncementBtn');
  assert.strictEqual(modal.classList.contains('show'), false);
  assert.strictEqual(modal.classList.contains('is-loading'), false);
  assert.strictEqual(status.hidden, true);
  assert.strictEqual(latest.hidden, false);
  assert.strictEqual(acknowledge.disabled, false);
  assert.strictEqual(dom.window.document.getElementById('announcementTitle').textContent, '已加载公告');

  finishRefresh({ ok: true, json: async () => ({ announcements: first }) });
  await refreshPromise;
}

async function testAcknowledgedRefreshVerifiesLatestWithoutFlashingAnnouncementDialog() {
  const dom = announcementDom();
  dom.window.document.documentElement.classList.add('announcement-acknowledged-boot');
  dom.window.localStorage.setItem(READ_ANNOUNCEMENTS_KEY, JSON.stringify(['v1.0.0']));
  let finishRequest;
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => new Promise(resolve => { finishRequest = resolve; }),
  });
  controller.bind();

  const initializePromise = controller.initialize();
  const modal = dom.window.document.getElementById('announcementModal');
  const shell = dom.window.document.querySelector('[data-announcement-app]');
  assert.strictEqual(modal.classList.contains('show'), false);
  assert.strictEqual(modal.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(shell.hasAttribute('inert'), true);
  assert.strictEqual(dom.window.document.body.classList.contains('announcement-pending'), true);

  finishRequest({ ok: true, json: async () => ({ announcements: [release('v1.0.0', '已读公告')] }) });
  await initializePromise;
  assert.strictEqual(dom.window.document.documentElement.classList.contains('announcement-acknowledged-boot'), false);
  assert.strictEqual(modal.classList.contains('show'), false);
  assert.strictEqual(shell.hasAttribute('inert'), false);
  assert.strictEqual(dom.window.document.body.classList.contains('announcement-pending'), false);
}

async function testInitialAnnouncementRequestTimesOutIntoRetryState() {
  const dom = announcementDom();
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    requestTimeoutMs: 10,
    fetchImpl: async () => new Promise(() => {}),
  });
  controller.bind();
  await assert.rejects(controller.initialize(), /公告请求超时/);

  const modal = dom.window.document.getElementById('announcementModal');
  const status = dom.window.document.getElementById('announcementStatus');
  assert.strictEqual(modal.classList.contains('show'), true);
  assert.strictEqual(modal.classList.contains('is-forced'), true);
  assert.strictEqual(modal.classList.contains('is-loading'), false);
  assert.strictEqual(status.classList.contains('is-error'), true);
  assert.match(status.textContent, /公告加载失败/);
  assert.ok(status.querySelector('.announcement-retry-btn'));
}

function testAnnouncementIsWiredIntoStaticEntryAndDockerRuntime() {
  const root = path.join(__dirname, '../..');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles/announcement.css'), 'utf8');
  assert.ok(index.includes('id="announcementModal"'));
  assert.ok(index.includes('id="acknowledgeAnnouncementBtn"'));
  assert.ok(index.includes('id="topbarUtilityActions"'));
  assert.ok(index.includes('id="announcementToolbarBtn"'));
  assert.ok(index.includes('id="closeAnnouncementBtn"') && index.includes('class="announcement-overlay-close"'));
  assert.ok(!index.includes('class="announcement-close"'));
  assert.ok(index.includes('class="topbar-utility-button announcement-toolbar-button announcement-launcher"'));
  assert.ok(index.includes('data-announcement-open'));
  assert.ok(!index.includes('id="railAnnouncementBtn"'));
  assert.ok(!index.includes('id="sidebarAnnouncementBtn"'));
  assert.ok(index.includes('./client/ui/announcement-center.js'));
  assert.ok(index.includes('./styles/announcement.css'));
  assert.ok(dockerfile.includes('COPY docs/announcements ./docs/announcements'));
  assert.ok(css.includes('z-index: 10000'));
  assert.ok(css.includes('body.announcement-locked'));
  assert.ok(index.includes('announcement-acknowledged-boot'));
  assert.ok(css.includes('html.announcement-acknowledged-boot .announcement-modal.is-loading'));
  assert.ok(css.includes('.announcement-toolbar-button:hover .announcement-entry-body'));
  assert.ok(css.includes('.announcement-overlay-close'));
}

module.exports = [
  testAnnouncementDocumentParsesVersionedMetadata,
  testAnnouncementFilesAreCumulativeAndSortedByVersion,
  testUnreadLatestAnnouncementLocksTheApplicationUntilAcknowledged,
  testNewAnnouncementVersionResetsTheForcedGate,
  testNewAnnouncementPublishedWhileOpenResetsGate,
  testAcknowledgedAnnouncementsOpenAsNormalHistoryModal,
  testBackgroundRefreshKeepsRenderedAnnouncementVisibleWhileRequestIsPending,
  testAcknowledgedRefreshVerifiesLatestWithoutFlashingAnnouncementDialog,
  testInitialAnnouncementRequestTimesOutIntoRetryState,
  testAnnouncementIsWiredIntoStaticEntryAndDockerRuntime,
];
