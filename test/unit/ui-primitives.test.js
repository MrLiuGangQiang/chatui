'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

function loadFacade(relativeFile, { browser = {}, globals = {} } = {}) {
  const filePath = path.join(PROJECT_ROOT, relativeFile);
  const moduleRecord = { exports: {} };
  const sandbox = {
    module: moduleRecord,
    exports: moduleRecord.exports,
    console,
    setTimeout,
    clearTimeout,
    ...globals,
    window: browser,
  };
  if (!Object.prototype.hasOwnProperty.call(sandbox, 'document') && browser.document) {
    sandbox.document = browser.document;
  }
  vm.runInNewContext(fs.readFileSync(filePath, 'utf8'), sandbox, { filename: filePath });
  return moduleRecord.exports;
}

function createTimerHarness() {
  let nextHandle = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, delay = 0) {
      const handle = nextHandle++;
      timers.set(handle, { callback, delay: Number(delay) || 0 });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    runAll() {
      let safety = 100;
      while (timers.size && safety-- > 0) {
        const pending = [...timers.entries()]
          .sort((left, right) => left[1].delay - right[1].delay || left[0] - right[0]);
        timers.clear();
        pending.forEach(([, timer]) => timer.callback());
      }
      if (timers.size) throw new Error('Timer harness did not settle.');
    },
  };
}

function createIdleHarness() {
  let nextHandle = 1;
  const callbacks = new Map();
  return {
    callbacks,
    requestIdleCallback(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelIdleCallback(handle) {
      callbacks.delete(handle);
    },
    runNext(deadline = { didTimeout: false, timeRemaining: () => 100 }) {
      const next = callbacks.entries().next();
      if (next.done) throw new Error('No idle callback is pending.');
      const [handle, callback] = next.value;
      callbacks.delete(handle);
      callback(deadline);
    },
  };
}

function createVirtualNode(id, { user = false, media = false, rawText = `message ${id}` } = {}) {
  const content = { innerHTML: '', style: {} };
  return {
    id,
    content,
    isConnected: true,
    offsetHeight: 200,
    dataset: { displayItemId: id, rawText },
    style: {},
    classList: { contains: className => user && className === 'user' },
    getBoundingClientRect: () => ({ top: -600, bottom: -400, height: 200 }),
    querySelector(selector) {
      if (selector === '.content') return content;
      if (selector.includes('generated-image-grid')) return media ? {} : null;
      return null;
    },
  };
}

function testUiRenderSchedulerFallbackCancellationClearsTimerAndCallback() {
  const timers = createTimerHarness();
  const schedulerApi = loadFacade('client/ui/render-scheduler.js', {
    browser: { performance: { now: () => 0 } },
    globals: {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  });
  let calls = 0;

  const handle = schedulerApi.scheduleIdle(() => { calls += 1; }, 100);
  assert.strictEqual(timers.timers.size, 2);
  handle.cancel();
  assert.strictEqual(timers.timers.size, 0);
  timers.runAll();
  assert.strictEqual(calls, 0);
}

function testUiRenderSchedulerDeduplicatesCancelsAndReleasesQueue() {
  const timers = createTimerHarness();
  const idle = createIdleHarness();
  const schedulerApi = loadFacade('client/ui/render-scheduler.js', {
    browser: {
      performance: { now: () => 0 },
      requestIdleCallback: idle.requestIdleCallback,
      cancelIdleCallback: idle.cancelIdleCallback,
    },
    globals: {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  });
  const scheduler = schedulerApi.createRenderScheduler({ batchSize: 10, budgetMs: 100 });
  const runs = [];

  scheduler.enqueue('first', () => runs.push('first'));
  scheduler.enqueue('first', () => runs.push('duplicate'));
  const cancelled = scheduler.enqueue('cancelled', () => runs.push('cancelled'));
  scheduler.enqueue('last', () => runs.push('last'));
  cancelled.cancel();
  assert.deepStrictEqual({ ...scheduler.stats() }, { queued: 3, deduped: 2, generation: 0 });

  idle.runNext();
  assert.deepStrictEqual(runs, ['first', 'last']);
  assert.deepStrictEqual({ ...scheduler.stats() }, { queued: 0, deduped: 0, generation: 0 });
  assert.strictEqual(timers.timers.size, 0);

  scheduler.enqueue('discard-one', () => runs.push('discard-one'));
  scheduler.enqueue('discard-two', () => runs.push('discard-two'));
  scheduler.cancelAll();
  assert.deepStrictEqual({ ...scheduler.stats() }, { queued: 0, deduped: 0, generation: 1 });
  assert.strictEqual(idle.callbacks.size, 0);
  assert.strictEqual(timers.timers.size, 0);

  scheduler.enqueue('fresh', () => runs.push('fresh'));
  idle.runNext();
  assert.deepStrictEqual(runs, ['first', 'last', 'fresh']);
}

function testUiMessageVirtualizerUsesInclusiveViewportMargins() {
  const document = { documentElement: { clientHeight: 600 } };
  const virtualizerApi = loadFacade('client/ui/message-virtualizer.js', {
    browser: { document, innerHeight: 600 },
    globals: { document },
  });
  const node = rect => ({ getBoundingClientRect: () => rect });
  const root = { getBoundingClientRect: () => ({ top: 100, bottom: 500 }) };

  assert.strictEqual(virtualizerApi.nearViewport(node({ top: -100, bottom: -50 }), 50), true);
  assert.strictEqual(virtualizerApi.nearViewport(node({ top: -100, bottom: -51 }), 50), false);
  assert.strictEqual(virtualizerApi.nearViewport(node({ top: 650, bottom: 700 }), 50), true);
  assert.strictEqual(virtualizerApi.nearViewport(node({ top: 651, bottom: 700 }), 50), false);
  assert.strictEqual(virtualizerApi.nearViewport(node({ top: 0, bottom: 50 }), 50, root), true);
  assert.strictEqual(virtualizerApi.nearViewport(node({ top: 0, bottom: 49 }), 50, root), false);
  assert.strictEqual(virtualizerApi.nearViewport(node({ top: 550, bottom: 600 }), 50, root), true);
  assert.strictEqual(virtualizerApi.nearViewport(node({ top: 551, bottom: 600 }), 50, root), false);
}

function testUiMessageVirtualizerProtectsSpecialAndNewestMessagesInOrder() {
  const document = { documentElement: { clientHeight: 600 } };
  const observed = [];
  let disconnects = 0;
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
    }
    observe(node) {
      observed.push(node.id);
    }
    disconnect() {
      disconnects += 1;
    }
  }
  const browser = { document, innerHeight: 600, IntersectionObserver: FakeIntersectionObserver };
  const virtualizerApi = loadFacade('client/ui/message-virtualizer.js', {
    browser,
    globals: { document, IntersectionObserver: FakeIntersectionObserver },
  });
  const nodes = [
    createVirtualNode('user-old', { user: true }),
    createVirtualNode('media-old', { media: true }),
    createVirtualNode('assistant-old', { rawText: '<old & unsafe>' }),
    ...Array.from({ length: 8 }, (_, index) => createVirtualNode(`recent-${index + 1}`)),
  ];
  const container = {
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    querySelectorAll(selector) {
      if (selector === '.message') return nodes;
      if (selector === '.message[data-virtual-observed="1"]') {
        return nodes.filter(node => node.dataset.virtualObserved === '1');
      }
      return [];
    },
  };
  const rendered = [];
  const cancelled = [];
  const virtualizer = virtualizerApi.createMessageVirtualizer({ minMessages: 3, unloadMarginPx: 100, root: container });

  assert.deepStrictEqual({ ...virtualizer.attach(container, {
    render: node => rendered.push(node.id),
    cancel: node => cancelled.push(node.id),
  }) }, { enabled: true });
  assert.deepStrictEqual(observed, nodes.map(node => node.id));
  assert.deepStrictEqual(rendered, nodes.slice(-8).map(node => node.id));
  assert.deepStrictEqual(cancelled, ['assistant-old']);
  assert.strictEqual(nodes[0].dataset.virtualized, undefined);
  assert.strictEqual(nodes[1].dataset.virtualized, undefined);
  assert.strictEqual(nodes[2].dataset.virtualized, '1');
  assert.match(nodes[2].content.innerHTML, /&lt;old &amp; unsafe&gt;/);
  assert.strictEqual(virtualizer.stats().virtualized, 1);
  assert.strictEqual(virtualizer.stats().heights, 1);

  virtualizer.disconnect();
  assert.strictEqual(disconnects, 1);
  assert.ok(nodes.every(node => node.dataset.virtualObserved === undefined));
  assert.strictEqual(virtualizer.stats().generation, 2);
}

function testUiScrollAutoFollowLocksOnUserDepartureAndRecoversAtBottom() {
  let clock = 1000;
  const scrollApi = loadFacade('client/ui/scroll-controller.js');
  const scroller = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
  const follow = scrollApi.createAutoFollowState({ threshold: 100, suppressMs: 50, now: () => clock });

  assert.strictEqual(scrollApi.distanceToBottom(scroller), 0);
  assert.strictEqual(follow.begin(scroller).isAutoFollowing, true);
  follow.markEvent({ type: 'wheel', deltaY: -20 }, scroller);
  assert.strictEqual(follow.canFollow(scroller), false);
  assert.strictEqual(follow.state.userScrolledAway, true);
  assert.strictEqual(follow.state.lastUserScrollAt, 1000);

  follow.markEvent({ type: 'wheel', deltaY: 20 }, scroller);
  assert.strictEqual(follow.canFollow(scroller), true);
  follow.suppress();
  scroller.scrollTop = 500;
  clock = 1020;
  follow.markEvent({ type: 'scroll' }, scroller);
  assert.strictEqual(follow.canFollow(scroller), true);

  scroller.scrollTop = 400;
  clock = 1060;
  follow.markEvent({ type: 'scroll' }, scroller);
  assert.strictEqual(follow.canFollow(scroller), false);
  assert.strictEqual(follow.state.lastUserScrollAt, 1060);

  scroller.scrollTop = 800;
  follow.markEvent({ type: 'scroll' }, scroller);
  assert.strictEqual(follow.canFollow(scroller), true);
  assert.strictEqual(follow.isNearBottom(scroller), true);
  assert.strictEqual(scrollApi.isNearBottom({ scrollHeight: 1000, clientHeight: 200, scrollTop: 749 }, 50), false);
  assert.strictEqual(scrollApi.isNearBottom({ scrollHeight: 1000, clientHeight: 200, scrollTop: 750 }, 50), true);
  assert.strictEqual(scrollApi.isNodeAwayFromOutputFocus({
    nodeRect: { top: 36, bottom: 636 },
    messagesRect: { top: 0, bottom: 500 },
    composerTop: 500,
    viewportHeight: 600,
    margin: 72,
    anchorMode: 'top',
  }), false, 'a historical output is focused when its top is aligned even if its growing bottom extends below the composer');
  assert.strictEqual(scrollApi.isNodeAwayFromOutputFocus({
    nodeRect: { top: 160, bottom: 760 },
    messagesRect: { top: 0, bottom: 500 },
    composerTop: 500,
    viewportHeight: 600,
    margin: 72,
    anchorMode: 'top',
  }), true, 'a historical output whose top leaves the focus band must show the continue-output affordance');
}

module.exports = [
  testUiRenderSchedulerFallbackCancellationClearsTimerAndCallback,
  testUiRenderSchedulerDeduplicatesCancelsAndReleasesQueue,
  testUiMessageVirtualizerUsesInclusiveViewportMargins,
  testUiMessageVirtualizerProtectsSpecialAndNewestMessagesInOrder,
  testUiScrollAutoFollowLocksOnUserDepartureAndRecoversAtBottom,
];
