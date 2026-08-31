'use strict';

// Presence route coverage for the async (Redis-backed) service contract. The
// routes must await snapshot/join/touch/leave so a shared Redis service is
// usable without changing the browser-facing SSE/JSON protocol.

const assert = require('assert');
const { createPresenceRoutes } = require('../../server/api/routes/presence');
const { sendJson, sendMethodNotAllowed } = require('../../server/http/response');

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function response() {
  const writes = [];
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writes,
    ended: false,
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = headers; return this; },
    write(chunk) { writes.push(String(chunk)); return true; },
    end(body = '') { this.body += String(body || ''); this.ended = true; },
    flushHeaders() {},
    getCapturedStatus() { return this.statusCode; },
  };
}

function request({ method, url, body = '' }) {
  const handlers = {};
  const req = {
    method,
    url,
    headers: {},
    on(event, fn) {
      handlers[event] = fn;
      if (event === 'data' && body) process.nextTick(() => fn(body));
      if (event === 'end') process.nextTick(fn);
      return this;
    },
    emitClose() { handlers.close?.(); },
  };
  return req;
}

function asyncPresence() {
  let count = 0;
  return {
    normalizeClientId(value) { return CLIENT_ID_PATTERN.test(String(value || '')) ? String(value) : null; },
    async snapshot() { return { count, timestamp: Date.now() }; },
    async join() { count += 1; return { joined: true, count }; },
    async touch() { return true; },
    async leave() { count = Math.max(0, count - 1); return true; },
  };
}

function invokeRoute(path, { method = 'GET', body = '', presence = asyncPresence() } = {}) {
  const { routePresence } = createPresenceRoutes({ presence, sendJson, sendMethodNotAllowed });
  const req = request({ method, url: path, body });
  const res = response();
  return Promise.resolve(routePresence(req, res)).then(() => ({ req, res, presence }));
}

async function testAsyncSnapshotIsAwaited() {
  const presence = asyncPresence();
  await presence.join();
  const { res } = await invokeRoute('/api/presence', { presence });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).count, 1, 'snapshot must reflect an async join before responding');
}

async function testAsyncHeartbeatIsAwaited() {
  const presence = asyncPresence();
  const { res } = await invokeRoute('/api/presence/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ clientId: 'pres-client-aaa' }),
    presence,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
}

async function testAsyncStreamJoinsAndLeaves() {
  const presence = asyncPresence();
  const { req, res } = await invokeRoute('/api/presence/stream?clientId=pres-client-aaa', { presence });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.writes[0].startsWith('event: presence\n'), 'stream must open with an SSE presence event');
  assert.strictEqual((await presence.snapshot()).count, 1, 'the stream join must be awaited before the route returns');

  req.emitClose();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual((await presence.snapshot()).count, 0, 'closing the stream must await the async leave');
}

module.exports = [
  testAsyncSnapshotIsAwaited,
  testAsyncHeartbeatIsAwaited,
  testAsyncStreamJoinsAndLeaves,
];