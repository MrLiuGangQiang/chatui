'use strict';

// Presence HTTP route coverage: snapshot shape/CORS, stream join/broadcast/
// close lifecycle, heartbeat validation, and method handling. These pin the
// wire contract the browser service depends on.

const assert = require('assert');
const { createPresenceRoutes } = require('../../server/api/routes/presence');
const { createPresenceService } = require('../../server/services/presence.service');
const { createRequestPrincipalService } = require('../../server/security/request-principal');
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

function invokeRoute(path, { method = 'GET', body = '', presence = createPresenceService(), req: providedReq } = {}) {
  const { routePresence } = createPresenceRoutes({ presence, sendJson, sendMethodNotAllowed });
  const req = providedReq || request({ method, url: path, body });
  const res = response();
  return Promise.resolve(routePresence(req, res)).then(() => ({ req, res, presence }));
}

// Principal helper: issue a real principal cookie through the request-principal
// service and reuse the same cookie on later requests to simulate the same
// browser opening multiple tabs.
function makePrincipalService() {
  return createRequestPrincipalService({ secret: 's'.repeat(32), now: () => 2000000000000 });
}

function issuePrincipalCookie(service, res = response()) {
  const req = request({ method: 'GET', url: '/', body: '' });
  const principal = service.attach(req, res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const setCookie = res.headers['Set-Cookie'];
  return { principal, cookie: Array.isArray(setCookie) ? setCookie[0] : setCookie };
}

function requestWithPrincipalCookie(service, cookie, url, { method = 'GET', body = '' } = {}) {
  const req = request({ method, url, body });
  if (cookie) req.headers.cookie = cookie;
  service.attach(req, response());
  return req;
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

async function testPresenceStreamCountsByRequestPrincipalNotClientId() {
  const presence = createPresenceService();
  const principalService = makePrincipalService();
  const { cookie } = issuePrincipalCookie(principalService);

  const first = await invokeRoute('/api/presence/stream?clientId=pres-client-tab-a', {
    presence,
    req: requestWithPrincipalCookie(principalService, cookie, '/api/presence/stream?clientId=pres-client-tab-a'),
  });
  assert.strictEqual(presence.count(), 1);

  const second = await invokeRoute('/api/presence/stream?clientId=pres-client-tab-b', {
    presence,
    req: requestWithPrincipalCookie(principalService, cookie, '/api/presence/stream?clientId=pres-client-tab-b'),
  });
  assert.strictEqual(presence.count(), 1, 'a second tab of the same browser must not add an online device');

  first.req.emitClose();
  assert.strictEqual(presence.count(), 1, 'closing one tab must keep the device online');
  second.req.emitClose();
  assert.strictEqual(presence.count(), 0);
}

async function testPresenceStreamWithDistinctPrincipalsCountsEachDevice() {
  const presence = createPresenceService();
  const firstService = makePrincipalService();
  const secondService = makePrincipalService();
  const firstCookie = issuePrincipalCookie(firstService).cookie;
  const secondCookie = issuePrincipalCookie(secondService).cookie;

  const first = await invokeRoute('/api/presence/stream?clientId=pres-client-tab-a', {
    presence,
    req: requestWithPrincipalCookie(firstService, firstCookie, '/api/presence/stream?clientId=pres-client-tab-a'),
  });
  const second = await invokeRoute('/api/presence/stream?clientId=pres-client-tab-b', {
    presence,
    req: requestWithPrincipalCookie(secondService, secondCookie, '/api/presence/stream?clientId=pres-client-tab-b'),
  });
  assert.strictEqual(presence.count(), 2, 'different browsers must each count once');
  first.req.emitClose();
  second.req.emitClose();
}

async function testPresenceHeartbeatWithPrincipalCookieStillTouches() {
  const presence = createPresenceService();
  const principalService = makePrincipalService();
  const { cookie } = issuePrincipalCookie(principalService);

  const joined = await invokeRoute('/api/presence/stream?clientId=pres-client-tab-a', {
    presence,
    req: requestWithPrincipalCookie(principalService, cookie, '/api/presence/stream?clientId=pres-client-tab-a'),
  });
  assert.strictEqual(presence.count(), 1);

  const body = JSON.stringify({ clientId: 'pres-client-tab-a' });
  const hb = await invokeRoute('/api/presence/heartbeat', {
    method: 'POST',
    body,
    presence,
    req: requestWithPrincipalCookie(principalService, cookie, '/api/presence/heartbeat', { method: 'POST', body }),
  });
  assert.strictEqual(hb.res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(hb.res.body), { ok: true });
  assert.strictEqual(presence.count(), 1, 'a heartbeat must not change the count');
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
  testPresenceStreamCountsByRequestPrincipalNotClientId,
  testPresenceStreamWithDistinctPrincipalsCountsEachDevice,
  testPresenceHeartbeatWithPrincipalCookieStillTouches,
  testPresenceUnknownPathReturns404,
];