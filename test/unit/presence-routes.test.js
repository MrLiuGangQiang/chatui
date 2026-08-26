'use strict';

// Presence HTTP route coverage: snapshot shape/CORS, stream join/broadcast/
// close lifecycle, heartbeat validation, and method handling. These pin the
// wire contract the browser service depends on.

const assert = require('assert');
const { createPresenceRoutes } = require('../../server/api/routes/presence');
const { createPresenceService } = require('../../server/services/presence.service');
const { sendJson, sendMethodNotAllowed } = require('../../server/http/response');

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
    authPrincipal: {},
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

function invokeRoute(path, { method = 'GET', body = '', presence = createPresenceService() } = {}) {
  const { routePresence } = createPresenceRoutes({ presence, sendJson, sendMethodNotAllowed });
  const req = request({ method, url: path, body });
  const res = response();
  return Promise.resolve(routePresence(req, res)).then(() => ({ req, res, presence }));
}

async function testPresenceSnapshotReturnsCountWithCors() {
  const presence = createPresenceService();
  presence.join('pres-client-aaa', response());
  const { res } = await invokeRoute('/api/presence', { presence });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['Access-Control-Allow-Origin'], '*');
  assert.match(res.headers['Content-Type'] || '', /application\/json/);
  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.count, 1);
  assert.strictEqual(typeof payload.timestamp, 'number', 'snapshot must carry a numeric timestamp');
}

async function testPresenceSnapshotRejectsNonGet() {
  const { res } = await invokeRoute('/api/presence', { method: 'POST' });
  assert.strictEqual(res.statusCode, 405);
}

async function testPresenceStreamRequiresValidClientId() {
  const missing = await invokeRoute('/api/presence/stream');
  assert.strictEqual(missing.res.statusCode, 400);

  const tooShort = await invokeRoute('/api/presence/stream?clientId=bad');
  assert.strictEqual(tooShort.res.statusCode, 400);
  assert.strictEqual(tooShort.presence.count(), 0, 'an invalid clientId must not join');
}

async function testPresenceStreamJoinsBroadcastsAndLeavesOnClose() {
  const { req: firstReq, res: firstRes, presence } = await invokeRoute('/api/presence/stream?clientId=pres-client-aaa');
  assert.strictEqual(firstRes.statusCode, 200);
  assert.match(firstRes.headers['Content-Type'] || '', /text\/event-stream/);
  assert.match(firstRes.headers['Cache-Control'] || '', /no-store/);
  assert.ok(firstRes.writes[0].startsWith('event: presence\n'), 'stream must open with a presence event');
  assert.strictEqual(presence.count(), 1);

  const second = await invokeRoute('/api/presence/stream?clientId=pres-client-bbb', { presence });
  assert.strictEqual(presence.count(), 2);
  assert.ok(firstRes.writes.at(-1).includes('"count":2'), 'first subscriber must see the second join broadcast');

  firstReq.emitClose();
  assert.strictEqual(presence.count(), 1, 'closing the stream must decrement the count');
  second.req.emitClose();
  assert.strictEqual(presence.count(), 0);
}

async function testPresenceHeartbeatValidatesAndTouches() {
  const presence = createPresenceService();
  const joined = await invokeRoute('/api/presence/stream?clientId=pres-client-aaa', { presence });
  assert.strictEqual(presence.count(), 1);

  const ok = await invokeRoute('/api/presence/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ clientId: 'pres-client-aaa' }),
    presence,
  });
  assert.strictEqual(ok.res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(ok.res.body), { ok: true });
  assert.strictEqual(presence.count(), 1, 'a heartbeat must not change the count');

  const missing = await invokeRoute('/api/presence/heartbeat', { method: 'POST', body: '{}', presence });
  assert.strictEqual(missing.res.statusCode, 400);

  const badMethod = await invokeRoute('/api/presence/heartbeat', { method: 'GET', presence });
  assert.strictEqual(badMethod.res.statusCode, 405);

  joined.req.emitClose();
}

async function testPresenceUnknownPathReturns404() {
  const { res } = await invokeRoute('/api/presence/nope');
  assert.strictEqual(res.statusCode, 404);
}

module.exports = [
  testPresenceSnapshotReturnsCountWithCors,
  testPresenceSnapshotRejectsNonGet,
  testPresenceStreamRequiresValidClientId,
  testPresenceStreamJoinsBroadcastsAndLeavesOnClose,
  testPresenceHeartbeatValidatesAndTouches,
  testPresenceUnknownPathReturns404,
];