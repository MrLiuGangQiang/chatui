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
    <div id="imagePreview" aria-hidden="true">
      <button id="imagePreviewDownload" hidden></button>
      <button id="imagePreviewCopy" hidden></button>
      <button id="imagePreviewClose"></button>
      <img id="imagePreviewImg" />
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

function makeFakeEventSourceClass(instances = []) {
  return class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      this.listeners = new Map();
      instances.push(this);
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }

    close() {
      this.readyState = 2;
      this.closed = true;
    }

    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
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

function testAnnouncementFeedUsesOnlyTheFixedRuntimeFilename() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-announcements-'));
  const runtimeDir = path.join(root, 'runtime-announcements');
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, '2026-09-10-01.md'), '# 忽略\n\n不是固定文件名');
    fs.writeFileSync(path.join(runtimeDir, 'announcement.md'), '# 正式公告\n\n正文');
    const releases = readAnnouncements({ runtimeDir });
    assert.strictEqual(releases.length, 1);
    assert.match(releases[0].version, /^announcement-[a-f0-9]{16}$/);
    assert.strictEqual(releases[0].title, '正式公告');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

async function testAnnouncementImagesOpenInTheSharedPreviewSurface() {
  const dom = announcementDom();
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ announcements: [{ ...release('v1.0.0', '带图片的公告'), body: '# 带图片的公告\n\n![更新截图](/announcements/images/update.png)' }] }),
    }),
    renderMarkdown: () => '<p><img src="/announcements/images/update.png" alt="更新截图"></p>',
  });
  controller.bind();
  await controller.initialize();

  const image = dom.window.document.querySelector('.announcement-image-previewable');
  image.click();

  const preview = dom.window.document.getElementById('imagePreview');
  assert.strictEqual(preview.classList.contains('show'), true, 'announcement images should use the in-page preview surface');
  assert.strictEqual(dom.window.document.getElementById('imagePreviewImg').getAttribute('src'), 'https://chatui.test/announcements/images/update.png');
  assert.strictEqual(dom.window.document.getElementById('imagePreviewDownload').hidden, false);
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

async function testEmptyAnnouncementResponseDoesNotFlashAnnouncementDialog() {
  const dom = announcementDom();
  let finishRequest;
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => new Promise(resolve => { finishRequest = resolve; }),
  });
  controller.bind();
  const modal = dom.window.document.getElementById('announcementModal');
  const shell = dom.window.document.querySelector('[data-announcement-app]');
  modal.classList.remove('show', 'is-forced');
  modal.setAttribute('aria-hidden', 'true');

  const initializePromise = controller.initialize();
  const openedBeforeResponse = modal.classList.contains('show');
  finishRequest({ ok: true, json: async () => ({ announcements: [] }) });
  await initializePromise;

  assert.strictEqual(openedBeforeResponse, false, 'startup must not open the dialog before announcement data is known');
  assert.strictEqual(modal.classList.contains('show'), false, 'an empty announcement feed must leave the dialog closed');
  assert.strictEqual(modal.classList.contains('is-forced'), false, 'an empty announcement feed must not leave a forced gate behind');
  assert.strictEqual(shell.hasAttribute('inert'), false, 'the app must be released after an empty announcement response');
  assert.strictEqual(dom.window.document.body.classList.contains('announcement-pending'), false, 'the startup gate must be cleared for an empty announcement feed');
}

async function testBackgroundRefreshFailureDoesNotReopenAnEmptyAnnouncementDialog() {
  const dom = announcementDom();
  let shouldFail = false;
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => {
      if (shouldFail) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => ({ announcements: [] }) };
    },
  });
  controller.bind();
  await controller.initialize();

  const modal = dom.window.document.getElementById('announcementModal');
  shouldFail = true;
  await assert.rejects(controller.refresh(), /Failed to fetch/);

  assert.strictEqual(modal.classList.contains('show'), false,
    'a transient background refresh failure must not open an empty announcement dialog');
  assert.strictEqual(modal.classList.contains('is-forced'), false,
    'a transient background refresh failure must not lock the app');
  dom.window.close();
}

function extractCssMedia(css, header) {
  const start = css.indexOf(header);
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  return '';
}

function testAnnouncementIsWiredIntoStaticEntryAndDockerRuntime() {
  const root = path.join(__dirname, '../..');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  const clientSource = fs.readFileSync(path.join(root, 'client/ui/announcement-center.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'server/app.js'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(root, 'server/services/announcements.service.js'), 'utf8');
  const eventServiceSource = fs.readFileSync(path.join(root, 'server/services/announcement-events.service.js'), 'utf8');
  const coreRouteSource = fs.readFileSync(path.join(root, 'server/api/routes/core.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles/announcement.css'), 'utf8');
  assert.match(index, /id="announcementModal"[^>]*class="announcement-modal is-loading"[^>]*aria-hidden="true"/);
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
  assert.ok(!dockerfile.includes('COPY docs/announcements ./docs/announcements'));
  assert.ok(dockerfile.includes('COPY data ./data'));
  assert.ok(dockerignore.includes('data/announcements/*'));
  assert.ok(dockerignore.includes('!data/announcements/README.md'));
  assert.ok(dockerignore.includes('!data/announcements/_template.md'));
  assert.ok(dockerignore.includes('!data/announcements/model-recommendation.json'));
  assert.ok(fs.statSync(path.join(root, 'data/announcements/README.md')).isFile());
  assert.ok(fs.statSync(path.join(root, 'data/announcements/_template.md')).isFile());
  assert.ok(fs.statSync(path.join(root, 'data/announcements/model-recommendation.json')).isFile());
  assert.ok(appSource.includes('runtimeDir: ANNOUNCEMENTS_DIR'));
  assert.ok(appSource.includes('createAnnouncementEvents'));
  assert.ok(appSource.includes('subscribeAnnouncements: announcementEvents.subscribe'));
  assert.ok(serviceSource.includes('readRuntimeAnnouncements'));
  assert.ok(eventServiceSource.includes('event: announcement'));
  assert.ok(coreRouteSource.includes("path: '/api/announcements/events'"));
  assert.ok(clientSource.includes('new EventSourceImpl(announcementEventsPath)'));
  assert.ok(!clientSource.includes('setInterval'),
    'announcement updates must use SSE and activation refreshes, not a client polling timer');
  assert.ok(css.includes('z-index: 10000'));
  assert.ok(css.includes('.image-preview.show') && css.includes('z-index: 10001'), 'the shared image preview must sit above the announcement dialog');
  assert.ok(css.includes('body.announcement-locked'));
  assert.ok(index.includes('announcement-acknowledged-boot'));
  assert.ok(css.includes('html.announcement-acknowledged-boot .announcement-modal.is-loading'));
  assert.ok(!css.includes('body.announcement-pending .announcement-modal'),
    'the boot markup must not force the announcement dialog visible before acknowledgement is known');
  assert.ok(css.includes('.announcement-toolbar-button:hover .announcement-entry-body'));
  assert.ok(css.includes('.announcement-overlay-close'));
}

async function testAnnouncementEventSourcePushesNewUnreadAnnouncement() {
  const dom = announcementDom();
  dom.window.localStorage.setItem(READ_ANNOUNCEMENTS_KEY, JSON.stringify(['v1.0.0']));
  const instances = [];
  const FakeEventSource = makeFakeEventSourceClass(instances);
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    EventSource: FakeEventSource,
    fetchImpl: async () => ({ ok: true, json: async () => ({ announcements: [release('v1.0.0', '旧公告')] }) }),
    renderMarkdown: markdown => '<p>' + markdown + '</p>',
  });
  controller.bind();
  await controller.initialize();
  assert.strictEqual(controller.connectEvents(), true);
  assert.strictEqual(instances.length, 1);
  assert.strictEqual(instances[0].url, '/api/announcements/events');

  instances[0].emit('announcement', {
    data: JSON.stringify({ announcements: [release('v2.0.0', '服务端推送公告')] }),
  });

  const modal = dom.window.document.getElementById('announcementModal');
  assert.strictEqual(dom.window.document.getElementById('announcementTitle').textContent, '服务端推送公告');
  assert.strictEqual(modal.classList.contains('show'), true);
  assert.strictEqual(modal.classList.contains('is-forced'), true, 'a pushed unread announcement must immediately gate the app');
  controller.disconnectEvents();
  assert.strictEqual(instances[0].closed, true);
}

async function testAnnouncementEventSourceIgnoresMalformedPush() {
  const dom = announcementDom();
  const instances = [];
  const FakeEventSource = makeFakeEventSourceClass(instances);
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    EventSource: FakeEventSource,
    fetchImpl: async () => ({ ok: true, json: async () => ({ announcements: [release('v1.0.0', '保留公告')] }) }),
    renderMarkdown: markdown => '<p>' + markdown + '</p>',
  });
  controller.bind();
  await controller.initialize();
  controller.acknowledge();
  controller.connectEvents();

  instances[0].emit('announcement', { data: '{not-json' });
  assert.strictEqual(dom.window.document.getElementById('announcementTitle').textContent, '保留公告',
    'a malformed push must not erase the last valid announcement');
}

async function testAnnouncementHeaderShowsRuntimeVersionOverAnnouncementVersion() {
  const dom = announcementDom();
  dom.window.__CHATUI_RUNTIME_IDENTITY = { version: '2.0.7' };
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => ({ ok: true, json: async () => ({ announcements: [release('v1.10.85', '旧版公告')] }) }),
    renderMarkdown: markdown => '<p>' + markdown + '</p>',
  });
  controller.bind();
  await controller.initialize();
  const version = dom.window.document.getElementById('announcementVersion');
  assert.strictEqual(version.textContent, '2.0.7', 'the announcement header must mirror the runtime app version from settings');
}

async function testAnnouncementHeaderFallsBackToAnnouncementVersionWithoutRuntimeIdentity() {
  const dom = announcementDom();
  const controller = createAnnouncementCenterController({
    document: dom.window.document,
    storage: dom.window.localStorage,
    fetchImpl: async () => ({ ok: true, json: async () => ({ announcements: [release('v1.10.85', '旧版公告')] }) }),
    renderMarkdown: markdown => '<p>' + markdown + '</p>',
  });
  controller.bind();
  await controller.initialize();
  const version = dom.window.document.getElementById('announcementVersion');
  assert.strictEqual(version.textContent, 'v1.10.85', 'without a runtime identity the header falls back to the announcement version');
}

function testAnnouncementMobileLayoutUsesFullWidthSingleScrollSurface() {
  const root = path.join(__dirname, '../..');
  const css = fs.readFileSync(path.join(root, 'styles/announcement.css'), 'utf8');
  const narrowTablet = extractCssMedia(css, '@media (max-width: 860px)');
  const phone = extractCssMedia(css, '@media (max-width: 600px)');
  assert.ok(narrowTablet, 'announcement CSS must keep a narrow-tablet breakpoint');
  assert.ok(phone, 'announcement CSS must keep a phone breakpoint');
  assert.match(narrowTablet, /\.announcement-dialog\s*\{[^}]*height: 100dvh/, 'the mobile announcement dialog must use the dynamic viewport height');
  assert.match(narrowTablet, /\.announcement-surface\s*\{[^}]*overflow: hidden/, 'only the announcement body should scroll on mobile, not the whole surface');
  assert.match(narrowTablet, /\.announcement-head\s*\{[^}]*width: 100%/, 'the mobile announcement header must span the viewport');
  assert.match(narrowTablet, /\.announcement-scroll\s*\{[^}]*width: 100%[^}]*overflow-x: hidden/, 'the mobile announcement body must occupy full width without horizontal page overflow');
  assert.match(narrowTablet, /\.announcement-footer\s*\{[^}]*width: 100%/, 'the mobile announcement actions must span the viewport');
  assert.match(phone, /\.announcement-head\s*\{[^}]*env\(safe-area-inset-top\)/, 'phone announcement headers must respect the top safe area');
  assert.match(phone, /\.announcement-dialog\s*\{[^}]*grid-template-rows: minmax\(0, 1fr\)/, 'the phone announcement dialog must collapse to a single content row');
  assert.match(phone, /\.announcement-hero\s*\{[^}]*display: none/, 'the phone announcement view must show only the announcement body');
  assert.match(phone, /\.announcement-footer\s*\{[^}]*env\(safe-area-inset-bottom\)/, 'the phone announcement footer must respect the bottom safe area');
  assert.match(phone, /\.announcement-overlay-close:not\(\[hidden\]\) \+ \.announcement-dialog \.announcement-head/, 'an open close button must reserve space above the mobile announcement header');
  assert.match(phone, /\.announcement-history-btn,\s*\.announcement-acknowledge-btn\s*\{[^}]*min-height: 48px/, 'mobile announcement actions must expose touch-sized targets');
  assert.match(phone, /\.announcement-overlay-close\s*\{[^}]*width: 44px[^}]*min-height: 44px/, 'the mobile close button must be a 44px touch target');
}


module.exports = [
  testAnnouncementDocumentParsesVersionedMetadata,
  testAnnouncementFeedUsesOnlyTheFixedRuntimeFilename,
  testUnreadLatestAnnouncementLocksTheApplicationUntilAcknowledged,
  testNewAnnouncementVersionResetsTheForcedGate,
  testNewAnnouncementPublishedWhileOpenResetsGate,
  testAcknowledgedAnnouncementsOpenAsNormalHistoryModal,
  testAnnouncementImagesOpenInTheSharedPreviewSurface,
  testBackgroundRefreshKeepsRenderedAnnouncementVisibleWhileRequestIsPending,
  testAcknowledgedRefreshVerifiesLatestWithoutFlashingAnnouncementDialog,
  testEmptyAnnouncementResponseDoesNotFlashAnnouncementDialog,
  testBackgroundRefreshFailureDoesNotReopenAnEmptyAnnouncementDialog,
  testInitialAnnouncementRequestTimesOutIntoRetryState,
  testAnnouncementEventSourcePushesNewUnreadAnnouncement,
  testAnnouncementEventSourceIgnoresMalformedPush,
  testAnnouncementIsWiredIntoStaticEntryAndDockerRuntime,
  testAnnouncementMobileLayoutUsesFullWidthSingleScrollSurface,
  testAnnouncementHeaderShowsRuntimeVersionOverAnnouncementVersion,
  testAnnouncementHeaderFallsBackToAnnouncementVersionWithoutRuntimeIdentity,
];
