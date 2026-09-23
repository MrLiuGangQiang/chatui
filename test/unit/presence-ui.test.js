'use strict';

// Presence badge UI coverage: badges must stay hidden until the first count
// arrives (no "0" flash), render the snapshot, live-update from SSE events,
// reuse a stable clientId, stay in sync across every [data-presence-indicator]
// node, and never open a connection when no badge exists. Two lifecycle gates
// lock the failure modes that made the badge disagree with the real online
// count: a bfcache restore that never re-subscribed, and a slow first-load
// snapshot that overwrote a newer live SSE count.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createPresenceController } = require('../../client/ui/presence');

function presenceDom(options = {}) {
  return new JSDOM(`<!doctype html><body>
    <div class="presence-indicator topbar-presence-indicator" role="status" title="在线人数" aria-label="在线人数" hidden data-presence-indicator>
      <span class="presence-dot" aria-hidden="true"></span>
      <span class="presence-count" data-presence-count>0</span>
      <span class="presence-label">人在线</span>
    </div>
    <div class="presence-indicator" role="status" title="在线人数" aria-label="在线人数" hidden data-presence-indicator>
      <span class="presence-count" data-presence-count>0</span>
    </div>
  </body>`, { url: 'https://chatui.test', ...options });
}

function fakeService() {
  const state = {
    snapshotCalls: 0,
    connectCalls: 0,
    connectOptions: null,
    onCount: null,
  };
  return {
    state,
    loadClientId() { return 'pres-client-test'; },
    fetchSnapshot() {
      state.snapshotCalls += 1;
      return Promise.resolve(3);
    },
    connectPresence(options) {
      state.connectCalls += 1;
      state.connectOptions = options;
      state.onCount = options.onCount;
      return () => {};
    },
  };
}

function indicators(dom) {
  return dom.window.document.querySelectorAll('[data-presence-indicator]');
}

function badgeText(dom, index = 0) {
  return indicators(dom)[index].querySelector('[data-presence-count]').textContent;
}

// Snapshot resolution is held open so a test can decide the arrival order of
// the first-load snapshot and the live SSE counts.
function deferredService() {
  const state = { snapshotCalls: 0, connectCalls: 0, resolveSnapshot: [], onCount: [] };
  return {
    state,
    loadClientId() { return 'pres-client-test'; },
    fetchSnapshot() {
      state.snapshotCalls += 1;
      return new Promise(resolve => state.resolveSnapshot.push(resolve));
    },
    connectPresence(options) {
      state.connectCalls += 1;
      state.onCount.push(options.onCount);
      return () => {};
    },
  };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

async function waitForLoad(dom) {
  if (dom.window.document.readyState === 'complete') return;
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
}

async function testPresenceBadgesStayHiddenUntilFirstCount() {
  const dom = presenceDom();
  const service = fakeService();
  createPresenceController({ document: dom.window.document, service, storage: {}, root: dom.window }).start();
  const nodes = indicators(dom);
  assert.strictEqual(nodes.length, 2);
  for (const node of nodes) {
    assert.strictEqual(node.hidden, true, 'badges must not flash before the first count');
  }
  assert.strictEqual(service.state.snapshotCalls, 1, 'start must fetch the initial snapshot');
  assert.strictEqual(service.state.connectCalls, 1, 'start must open the presence stream');

  await new Promise(resolve => setImmediate(resolve));
  for (const node of nodes) {
    assert.strictEqual(node.querySelector('[data-presence-count]').textContent, '3', 'snapshot count must render');
    assert.strictEqual(node.hidden, false, 'badges must appear once a count is known');
    assert.strictEqual(node.title, '3 人在线');
  }
}

async function testPresenceBadgesLiveUpdateFromSseEventsInSync() {
  const dom = presenceDom();
  const service = fakeService();
  createPresenceController({ document: dom.window.document, service, storage: {}, root: dom.window }).start();
  await new Promise(resolve => setImmediate(resolve));

  service.state.onCount(5);
  const nodes = indicators(dom);
  assert.strictEqual(nodes[0].querySelector('[data-presence-count]').textContent, '5');
  assert.strictEqual(nodes[1].querySelector('[data-presence-count]').textContent, '5', 'every badge must update in sync');
  assert.strictEqual(nodes[0].title, '5 人在线');

  service.state.onCount(1);
  assert.strictEqual(nodes[0].querySelector('[data-presence-count]').textContent, '1');
  assert.strictEqual(nodes[0].title, '1 人在线');
}

function testPresenceBadgeReusesStableClientId() {
  const dom = presenceDom();
  const service = fakeService();
  createPresenceController({ document: dom.window.document, service, storage: {}, root: dom.window }).start();
  assert.strictEqual(service.state.connectOptions.clientId, 'pres-client-test', 'the stable clientId must be passed to the stream');
}

function testPresenceBadgeNoopsWithoutIndicatorNode() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://chatui.test' });
  const service = fakeService();
  const controller = createPresenceController({ document: dom.window.document, service, storage: {}, root: dom.window });
  assert.strictEqual(controller.start(), null, 'missing badge node must not start any connection');
  assert.strictEqual(service.state.snapshotCalls, 0);
  assert.strictEqual(service.state.connectCalls, 0);
}

// Drives the shipped bind() path: the module is evaluated inside a real window,
// so dispatching pagehide/pageshow exercises the same lifecycle wiring the
// browser uses. Without restoration wiring the restore never re-subscribes, and
// the restored tab stays out of the online count with a frozen badge.
async function testPresenceBadgeResubscribesAfterBfcacheRestore() {
  const dom = presenceDom({ runScripts: 'outside-only' });
  await waitForLoad(dom);
  const service = fakeService();
  dom.window[Symbol.for('chatui.module-registry.v1')] = new Map([['presenceService', service]]);
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../../client/ui/presence.js'), 'utf8'));
  await flush();

  assert.strictEqual(service.state.snapshotCalls, 1, 'the first load must fetch the initial snapshot');
  assert.strictEqual(service.state.connectCalls, 1, 'the first load must open the presence stream');

  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.dispatchEvent(new dom.window.Event('pageshow'));
  await flush();

  assert.strictEqual(service.state.snapshotCalls, 2, 'a bfcache restore must refresh the snapshot');
  assert.strictEqual(service.state.connectCalls, 2, 'a bfcache restore must re-open the presence stream');
  assert.strictEqual(badgeText(dom), '3', 'the restored page must render the refreshed count');
  assert.strictEqual(indicators(dom)[0].hidden, false, 'the restored badge must stay visible');
}

async function testPresenceStaleSnapshotMustNotOverwriteNewerLiveCount() {
  const dom = presenceDom();
  const service = deferredService();
  createPresenceController({ document: dom.window.document, service, storage: {}, root: dom.window }).start();

  service.state.onCount[0](5);
  assert.strictEqual(badgeText(dom), '5', 'the live SSE count must render immediately');

  service.state.resolveSnapshot[0](4);
  await flush();

  assert.strictEqual(badgeText(dom), '5', 'a first-load snapshot that resolves after a live count must not overwrite it');
  assert.strictEqual(indicators(dom)[0].title, '5 人在线');
}

async function testPresenceAbandonedSessionMustNotRenderAfterRestart() {
  const dom = presenceDom();
  const service = deferredService();
  const controller = createPresenceController({ document: dom.window.document, service, storage: {}, root: dom.window });
  controller.start();
  controller.stop();
  controller.start();

  assert.strictEqual(service.state.snapshotCalls, 2, 'every session must fetch its own snapshot');
  assert.strictEqual(service.state.connectCalls, 2, 'every session must open its own stream');

  service.state.onCount[1](7);
  service.state.resolveSnapshot[0](2);
  await flush();

  assert.strictEqual(badgeText(dom), '7', 'a snapshot belonging to a replaced session must never render');
}

module.exports = [
  testPresenceBadgesStayHiddenUntilFirstCount,
  testPresenceBadgesLiveUpdateFromSseEventsInSync,
  testPresenceBadgeReusesStableClientId,
  testPresenceBadgeNoopsWithoutIndicatorNode,
  testPresenceBadgeResubscribesAfterBfcacheRestore,
  testPresenceStaleSnapshotMustNotOverwriteNewerLiveCount,
  testPresenceAbandonedSessionMustNotRenderAfterRestart,
];
