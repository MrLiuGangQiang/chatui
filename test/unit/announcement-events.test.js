'use strict';

const assert = require('assert');
const { createCoreRoutes } = require('../../server/api/routes/core');
const {
  ANNOUNCEMENT_SSE_HEADERS,
  DEFAULT_ANNOUNCEMENT_HEARTBEAT_MS,
  announcementEventFrame,
  createAnnouncementEvents,
} = require('../../server/services/announcement-events.service');

function makeRequest() {
  const listeners = new Map();
  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return this;
    },
    once(event, listener) {
      const wrapped = (...args) => {
        this.removeListener(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    emit(event) {
      for (const listener of [...(listeners.get(event) || [])]) listener();
    },
  };
}

function makeResponse(writes) {
  const listeners = new Map();
  return {
    ended: false,
    headers: null,
    statusCode: null,
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; return this; },
    write(chunk) { writes.push(String(chunk)); return true; },
    flushHeaders() {},
    end() { this.ended = true; },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return this;
    },
    once(event, listener) {
      const wrapped = (...args) => {
        this.removeListener(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    emit(event) {
      for (const listener of [...(listeners.get(event) || [])]) listener();
    },
  };
}

function makeHarness(initialAnnouncements) {
  let announcements = initialAnnouncements;
  let watchListener = null;
  let watcherClosed = false;
  let nextTimerId = 1;
  const timers = new Map();
  const heartbeatCallbacks = new Set();
  const service = createAnnouncementEvents({
    runtimeDir: 'announcements',
    readAnnouncementsImpl: () => announcements,
    watchImpl: (_directory, _options, listener) => {
      watchListener = listener;
      return {
        on() {},
        close() { watcherClosed = true; },
      };
    },
    setTimeoutImpl: callback => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeoutImpl: id => timers.delete(id),
    setIntervalImpl: callback => {
      heartbeatCallbacks.add(callback);
      return callback;
    },
    clearIntervalImpl: callback => heartbeatCallbacks.delete(callback),
  });
  return {
    service,
    replace(next) { announcements = next; },
    trigger(filename = 'announcement.md') { watchListener?.('change', filename); },
    runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(callback => callback());
    },
    heartbeatCount: () => heartbeatCallbacks.size,
    wasWatcherClosed: () => watcherClosed,
  };
}

function parseFrame(frame) {
  const versionLine = frame.split('\n').find(line => line.startsWith('id: '));
  const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
  return {
    id: versionLine ? versionLine.slice(4) : '',
    event: frame.split('\n').find(line => line.startsWith('event: '))?.slice(7) || '',
    payload: JSON.parse(dataLine.slice(6)),
  };
}

function testAnnouncementEventsEndpointRoutesGetRequestsToTheStream() {
  let subscribed = 0;
  const { routeCoreApi } = createCoreRoutes({
    readAnnouncements: () => [],
    subscribeAnnouncements: () => { subscribed += 1; },
    sendJson: () => {},
    sendMethodNotAllowed: () => {},
  });
  const result = routeCoreApi(
    { method: 'GET', pathname: '/api/announcements/events', url: '/api/announcements/events' },
    {},
  );
  assert.notStrictEqual(result, false);
  assert.strictEqual(subscribed, 1);
}

function testAnnouncementEventStreamSendsCurrentSnapshotAndOnlyBroadcastsFingerprintChanges() {
  const first = { version: 'announcement-one', title: '一', body: '# 一' };
  const second = { version: 'announcement-two', title: '二', body: '# 二' };
  const harness = makeHarness([first]);
  const request = makeRequest();
  const writes = [];
  const response = makeResponse(writes);

  assert.strictEqual(harness.service.subscribe(request, response), true);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers['Content-Type'], ANNOUNCEMENT_SSE_HEADERS['Content-Type']);
  assert.match(response.headers['Cache-Control'], /no-store/);
  assert.deepStrictEqual(parseFrame(writes[0]), {
    id: 'announcement-one',
    event: 'announcement',
    payload: { announcements: [first] },
  });

  harness.replace([second]);
  harness.trigger();
  assert.strictEqual(writes.length, 1, 'the watcher must not publish before the debounce elapses');
  harness.runTimers();
  assert.strictEqual(writes.length, 2, 'a changed content fingerprint must be pushed');
  assert.strictEqual(parseFrame(writes[1]).id, 'announcement-two');

  harness.trigger();
  harness.runTimers();
  assert.strictEqual(writes.length, 2, 'an unchanged announcement snapshot must not be rebroadcast');

  harness.trigger('model-recommendation.json');
  assert.strictEqual(harness.runTimers(), undefined);
  assert.strictEqual(writes.length, 2, 'unrelated directory changes must not trigger announcement reads or pushes');

  request.emit('close');
  harness.service.close();
  assert.strictEqual(harness.wasWatcherClosed(), true);
}

function testAnnouncementEventStreamBroadcastsDeletionAsAnEmptySnapshot() {
  const harness = makeHarness([{ version: 'announcement-one', title: '一', body: '# 一' }]);
  const writes = [];
  const response = makeResponse(writes);
  harness.service.subscribe(makeRequest(), response);

  harness.replace([]);
  harness.trigger();
  harness.runTimers();

  const frame = parseFrame(writes.at(-1));
  assert.strictEqual(frame.id, '');
  assert.deepStrictEqual(frame.payload, { announcements: [] });
}

function testAnnouncementEventStreamUsesLowFrequencyHeartbeatByDefault() {
  const heartbeatDelays = [];
  const service = createAnnouncementEvents({
    runtimeDir: 'announcements',
    readAnnouncementsImpl: () => [],
    watchImpl: () => ({ on() {}, close() {} }),
    setIntervalImpl: (_callback, delayMs) => {
      heartbeatDelays.push(delayMs);
      return 1;
    },
    clearIntervalImpl: () => {},
  });
  service.subscribe(makeRequest(), makeResponse([]));
  assert.deepStrictEqual(heartbeatDelays, [DEFAULT_ANNOUNCEMENT_HEARTBEAT_MS]);
  assert.strictEqual(DEFAULT_ANNOUNCEMENT_HEARTBEAT_MS, 5 * 60 * 1000);
  service.close();
}

function testAnnouncementEventStreamCloseEndsEveryConnectionAndHeartbeat() {
  const harness = makeHarness([{ version: 'announcement-one', title: '一', body: '# 一' }]);
  const first = makeResponse([]);
  const second = makeResponse([]);
  harness.service.subscribe(makeRequest(), first);
  harness.service.subscribe(makeRequest(), second);
  assert.strictEqual(harness.heartbeatCount(), 2);

  assert.strictEqual(harness.service.close(), 2);
  assert.strictEqual(first.ended, true);
  assert.strictEqual(second.ended, true);
  assert.strictEqual(harness.heartbeatCount(), 0);
  assert.strictEqual(harness.service.close(), 0, 'close must be idempotent');
}

function testAnnouncementEventFrameOmitsIdForAnEmptySnapshot() {
  const frame = announcementEventFrame({ announcements: [], version: '' });
  assert.match(frame, /^retry: 5000\nevent: announcement\ndata: /);
  assert.ok(!frame.includes('\nid: '), 'an empty snapshot must not reuse a stale event id');
}

module.exports = [
  testAnnouncementEventsEndpointRoutesGetRequestsToTheStream,
  testAnnouncementEventStreamSendsCurrentSnapshotAndOnlyBroadcastsFingerprintChanges,
  testAnnouncementEventStreamBroadcastsDeletionAsAnEmptySnapshot,
  testAnnouncementEventStreamUsesLowFrequencyHeartbeatByDefault,
  testAnnouncementEventStreamCloseEndsEveryConnectionAndHeartbeat,
  testAnnouncementEventFrameOmitsIdForAnEmptySnapshot,
];