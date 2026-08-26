'use strict';

// Presence badge UI coverage: badges must stay hidden until the first count
// arrives (no "0" flash), render the snapshot, live-update from SSE events,
// reuse a stable clientId, stay in sync across every [data-presence-indicator]
// node, and never open a connection when no badge exists.

const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createPresenceController } = require('../../client/ui/presence');

function presenceDom() {
  return new JSDOM(`<!doctype html><body>
    <div class="presence-indicator topbar-presence-indicator" role="status" title="在线人数" aria-label="在线人数" hidden data-presence-indicator>
      <span class="presence-dot" aria-hidden="true"></span>
      <span class="presence-count" data-presence-count>0</span>
      <span class="presence-label">人在线</span>
    </div>
    <div class="presence-indicator" role="status" title="在线人数" aria-label="在线人数" hidden data-presence-indicator>
      <span class="presence-count" data-presence-count>0</span>
    </div>
  </body>`, { url: 'https://chatui.test' });
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

module.exports = [
  testPresenceBadgesStayHiddenUntilFirstCount,
  testPresenceBadgesLiveUpdateFromSseEventsInSync,
  testPresenceBadgeReusesStableClientId,
  testPresenceBadgeNoopsWithoutIndicatorNode,
];