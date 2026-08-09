'use strict';

const assert = require('assert');
const http = require('http');

const { createApp } = require('../../server/app');
const { createJobEvents, publicJob } = require('../../server/jobs/common');
const {
  bindJobOwner,
  findOwnedJob,
  jobOwnedBy,
} = require('../../server/security/job-ownership');
const {
  PRINCIPAL_COOKIE_NAME,
  createRequestPrincipalService,
} = require('../../server/security/request-principal');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

const TEST_SECRET = 'test-only-principal-secret-that-is-longer-than-32-bytes';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function request(port, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonBody(value) {
  const body = JSON.stringify(value);
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
}

function parseJson(response) {
  return response.body ? JSON.parse(response.body) : null;
}

function responseCookie(response) {
  return String(response.headers['set-cookie']?.[0] || '').split(';')[0];
}

function cookiePair(serializedCookie) {
  return String(serializedCookie || '').split(';')[0];
}

async function issueClient(port) {
  const response = await request(port, '/api/version');
  const cookie = responseCookie(response);
  assert.strictEqual(response.status, 200);
  assert.match(cookie, new RegExp(`^${PRINCIPAL_COOKIE_NAME}=`));
  return { cookie, response };
}

async function waitForJobSettled(job) {
  for (let attempt = 0; attempt < 20 && job?.status === 'running'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function chatJobBody(jobId, prompt = 'owner isolation') {
  return {
    baseUrl: 'http://127.0.0.1:65534/v1',
    apiKey: 'test-only',
    jobId,
    requestPurpose: 'final_execution',
    dispatchContract: makeDispatchContract({ prompt }),
    bindingEvidence: [],
    payload: { model: 'test-model', messages: [{ role: 'user', content: prompt }] },
  };
}

function imageJobBody(jobId, prompt = 'draw an owner-only image') {
  return {
    baseUrl: 'http://127.0.0.1:65534/v1',
    apiKey: 'test-only',
    jobId,
    requestPurpose: 'final_execution',
    dispatchContract: makeDispatchContract({ operation: 'text_to_image', prompt }),
    bindingEvidence: [],
    payload: { model: 'test-image-model', prompt, n: 1 },
  };
}

function mockUpstream(fetchCalls) {
  return async url => {
    fetchCalls.push(String(url));
    const image = String(url).includes('/images/');
    return {
      status: 200,
      ok: true,
      headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? 'application/json' : null; } },
      async text() {
        return image
          ? JSON.stringify({ data: [{ url: 'https://images.example/owner-only.png' }] })
          : JSON.stringify({ choices: [{ message: { content: 'owner-only-result' } }] });
      },
    };
  };
}

async function withPrivateUpstreamMock(run) {
  const originalFetch = global.fetch;
  const originalAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  const fetchCalls = [];
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  global.fetch = mockUpstream(fetchCalls);
  try { await run(fetchCalls); }
  finally {
    global.fetch = originalFetch;
    if (originalAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = originalAllowPrivate;
  }
}

async function testChatJobOwnerGuardsReadSseAbortDeleteAndReuse() {
  await withPrivateUpstreamMock(async fetchCalls => {
    const { server, stores } = createApp();
    const port = await listen(server);
    try {
      const owner = await issueClient(port);
      const foreign = await issueClient(port);
      const jobId = 'chatjob-owner0001';
      const createdPayload = jsonBody(chatJobBody(jobId));
      const created = await request(port, '/api/chat-jobs', {
        method: 'POST',
        headers: { ...createdPayload.headers, Cookie: owner.cookie },
        body: createdPayload.body,
      });
      assert.strictEqual(created.status, 202);
      const job = stores.chatJobs.get(jobId);
      assert.ok(job);
      await waitForJobSettled(job);
      job.status = 'running';
      job.error = '';
      job.data = { choices: [{ message: { content: 'chat-owner-secret' } }] };
      let abortCalls = 0;
      job.controller = { abort() { abortCalls += 1; } };
      const upstreamCallsAfterCreate = fetchCalls.length;

      const foreignRead = await request(port, `/api/chat-jobs/${jobId}`, { headers: { Cookie: foreign.cookie } });
      assert.strictEqual(foreignRead.status, 404);
      assert.strictEqual(foreignRead.body.includes('chat-owner-secret'), false);

      const foreignSse = await request(port, `/api/chat-jobs/${jobId}/events`, { headers: { Cookie: foreign.cookie } });
      assert.strictEqual(foreignSse.status, 200, 'missing and unauthorized SSE jobs keep the same compatibility status');
      assert.strictEqual(foreignSse.body.includes('chat-owner-secret'), false);
      assert.match(foreignSse.body, /任务不存在或服务已重启/);

      const foreignAbort = await request(port, `/api/chat-jobs/${jobId}/abort`, { method: 'POST', headers: { Cookie: foreign.cookie } });
      assert.strictEqual(foreignAbort.status, 404);
      assert.strictEqual(job.status, 'running');
      assert.strictEqual(abortCalls, 0);

      const foreignDelete = await request(port, `/api/chat-jobs/${jobId}`, { method: 'DELETE', headers: { Cookie: foreign.cookie } });
      assert.strictEqual(foreignDelete.status, 200);
      assert.deepStrictEqual(parseJson(foreignDelete), { disposed: true, existed: false });
      assert.strictEqual(stores.chatJobs.get(jobId), job, 'foreign delete must not remove or terminate the real job');

      const invalidReuse = jsonBody({ jobId });
      const foreignReuse = await request(port, '/api/chat-jobs', {
        method: 'POST',
        headers: { ...invalidReuse.headers, Cookie: foreign.cookie },
        body: invalidReuse.body,
      });
      assert.strictEqual(foreignReuse.status, 409, 'ownership must be checked before execution-contract reuse validation');
      assert.strictEqual(parseJson(foreignReuse)?.error?.code, 'JOB_ID_CONFLICT');
      assert.strictEqual(fetchCalls.length, upstreamCallsAfterCreate, 'foreign reuse must not dispatch another upstream request');

      const ownerRead = await request(port, `/api/chat-jobs/${jobId}`, { headers: { Cookie: owner.cookie } });
      assert.strictEqual(ownerRead.status, 200);
      assert.ok(ownerRead.body.includes('chat-owner-secret'));
      assert.match(ownerRead.headers['cache-control'] || '', /no-store/i);

      job.status = 'done';
      const ownerSse = await request(port, `/api/chat-jobs/${jobId}/events`, { headers: { Cookie: owner.cookie } });
      assert.strictEqual(ownerSse.status, 200);
      assert.ok(ownerSse.body.includes('chat-owner-secret'));
      assert.match(ownerSse.headers['cache-control'] || '', /no-store/i);

      job.status = 'running';
      job.error = '';
      const ownerAbort = await request(port, `/api/chat-jobs/${jobId}/abort`, { method: 'POST', headers: { Cookie: owner.cookie } });
      assert.strictEqual(ownerAbort.status, 200);
      assert.strictEqual(abortCalls, 1);
      assert.strictEqual(job.status, 'error');

      const ownerDelete = await request(port, `/api/chat-jobs/${jobId}`, { method: 'DELETE', headers: { Cookie: owner.cookie } });
      assert.strictEqual(ownerDelete.status, 200);
      assert.deepStrictEqual(parseJson(ownerDelete), { disposed: true, existed: true });
      assert.strictEqual(stores.chatJobs.has(jobId), false);
    } finally {
      await close(server);
    }
  });
}

async function testImageJobOwnerGuardsReadSseAbortDeleteAndReuse() {
  await withPrivateUpstreamMock(async fetchCalls => {
    const { server, stores } = createApp();
    const port = await listen(server);
    try {
      const owner = await issueClient(port);
      const foreign = await issueClient(port);
      const jobId = 'imgjob-owner00001';
      const createdPayload = jsonBody(imageJobBody(jobId));
      const created = await request(port, '/api/image-jobs', {
        method: 'POST',
        headers: { ...createdPayload.headers, Cookie: owner.cookie },
        body: createdPayload.body,
      });
      assert.strictEqual(created.status, 202);
      const job = stores.imageJobs.get(jobId);
      assert.ok(job);
      await waitForJobSettled(job);
      job.status = 'running';
      job.error = '';
      job.data = { data: [{ url: 'image-owner-secret' }] };
      let abortCalls = 0;
      job.controller = { abort() { abortCalls += 1; } };
      const upstreamCallsAfterCreate = fetchCalls.length;

      const foreignRead = await request(port, `/api/image-jobs/${jobId}`, { headers: { Cookie: foreign.cookie } });
      assert.strictEqual(foreignRead.status, 404);
      assert.strictEqual(foreignRead.body.includes('image-owner-secret'), false);

      const foreignSse = await request(port, `/api/image-jobs/${jobId}/events`, { headers: { Cookie: foreign.cookie } });
      assert.strictEqual(foreignSse.status, 200);
      assert.strictEqual(foreignSse.body.includes('image-owner-secret'), false);
      assert.match(foreignSse.body, /任务不存在或服务已重启/);

      const foreignAbort = await request(port, `/api/image-jobs/${jobId}/abort`, { method: 'POST', headers: { Cookie: foreign.cookie } });
      assert.strictEqual(foreignAbort.status, 404);
      assert.strictEqual(job.status, 'running');
      assert.strictEqual(abortCalls, 0);

      const foreignDelete = await request(port, `/api/image-jobs/${jobId}`, { method: 'DELETE', headers: { Cookie: foreign.cookie } });
      assert.deepStrictEqual(parseJson(foreignDelete), { disposed: true, existed: false });
      assert.strictEqual(stores.imageJobs.get(jobId), job);

      const invalidReuse = jsonBody({ jobId });
      const foreignReuse = await request(port, '/api/image-jobs', {
        method: 'POST',
        headers: { ...invalidReuse.headers, Cookie: foreign.cookie },
        body: invalidReuse.body,
      });
      assert.strictEqual(foreignReuse.status, 409);
      assert.strictEqual(parseJson(foreignReuse)?.error?.code, 'JOB_ID_CONFLICT');
      assert.strictEqual(fetchCalls.length, upstreamCallsAfterCreate);

      const ownerRead = await request(port, `/api/image-jobs/${jobId}`, { headers: { Cookie: owner.cookie } });
      assert.strictEqual(ownerRead.status, 200);
      assert.ok(ownerRead.body.includes('image-owner-secret'));

      job.status = 'done';
      const ownerSse = await request(port, `/api/image-jobs/${jobId}/events`, { headers: { Cookie: owner.cookie } });
      assert.strictEqual(ownerSse.status, 200);
      assert.ok(ownerSse.body.includes('image-owner-secret'));

      job.status = 'running';
      job.error = '';
      const ownerAbort = await request(port, `/api/image-jobs/${jobId}/abort`, { method: 'POST', headers: { Cookie: owner.cookie } });
      assert.strictEqual(ownerAbort.status, 200);
      assert.strictEqual(abortCalls, 1);

      const ownerDelete = await request(port, `/api/image-jobs/${jobId}`, { method: 'DELETE', headers: { Cookie: owner.cookie } });
      assert.deepStrictEqual(parseJson(ownerDelete), { disposed: true, existed: true });
      assert.strictEqual(stores.imageJobs.has(jobId), false);
    } finally {
      await close(server);
    }
  });
}

async function testChatStreamRegistrationAndProxyReuseAreOwnerBound() {
  const originalFetch = global.fetch;
  const originalAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  let fetchCalls = 0;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('foreign reuse must not reach upstream');
  };
  const { server, stores } = createApp();
  const port = await listen(server);
  try {
    const owner = await issueClient(port);
    const foreign = await issueClient(port);
    const jobId = 'chatjob-streamown1';
    const streamPayload = jsonBody({ ...chatJobBody(jobId, 'stream owner'), start: false });
    const created = await request(port, '/api/chat-stream-jobs', {
      method: 'POST',
      headers: { ...streamPayload.headers, Cookie: owner.cookie },
      body: streamPayload.body,
    });
    assert.strictEqual(created.status, 202);
    const job = stores.chatJobs.get(jobId);
    assert.ok(job);

    const resumed = await request(port, '/api/chat-stream-jobs', {
      method: 'POST',
      headers: { ...streamPayload.headers, Cookie: owner.cookie },
      body: streamPayload.body,
    });
    assert.strictEqual(resumed.status, 202, 'the same principal may resume the same immutable stream contract');

    job.streamStarted = true;
    const duplicateProxyPayload = jsonBody({
      baseUrl: 'http://127.0.0.1:65534/v1',
      method: 'POST',
      jobId,
      requestPurpose: 'intent_recognition',
      payload: { model: 'test-model', stream: true, messages: [] },
    });
    const ownerDuplicateProxy = await request(port, '/api/chat/completions', {
      method: 'POST',
      headers: { ...duplicateProxyPayload.headers, Cookie: owner.cookie },
      body: duplicateProxyPayload.body,
    });
    assert.strictEqual(ownerDuplicateProxy.status, 409);
    assert.strictEqual(parseJson(ownerDuplicateProxy)?.error?.code, 'CHAT_JOB_ALREADY_STREAMING');
    assert.strictEqual(fetchCalls, 0, 'an already-streaming owned job must be rejected before a duplicate upstream dispatch');
    job.streamStarted = false;

    const invalidReuse = jsonBody({ jobId });
    const foreignRegister = await request(port, '/api/chat-stream-jobs', {
      method: 'POST',
      headers: { ...invalidReuse.headers, Cookie: foreign.cookie },
      body: invalidReuse.body,
    });
    assert.strictEqual(foreignRegister.status, 409);
    assert.strictEqual(parseJson(foreignRegister)?.error?.code, 'JOB_ID_CONFLICT');

    const proxyPayload = jsonBody({
      baseUrl: 'http://127.0.0.1:65534/v1',
      method: 'POST',
      jobId,
      requestPurpose: 'intent_recognition',
      payload: { model: 'test-model', stream: true, messages: [] },
    });
    const foreignProxy = await request(port, '/api/chat/completions', {
      method: 'POST',
      headers: { ...proxyPayload.headers, Cookie: foreign.cookie },
      body: proxyPayload.body,
    });
    assert.strictEqual(foreignProxy.status, 409);
    assert.strictEqual(parseJson(foreignProxy)?.error?.code, 'JOB_ID_CONFLICT');
    assert.strictEqual(fetchCalls, 0);
    assert.strictEqual(stores.chatJobs.get(jobId), job);

    const foreignRead = await request(port, `/api/chat-jobs/${jobId}`, { headers: { Cookie: foreign.cookie } });
    assert.strictEqual(foreignRead.status, 404);
    const ownerRead = await request(port, `/api/chat-jobs/${jobId}`, { headers: { Cookie: owner.cookie } });
    assert.strictEqual(ownerRead.status, 200);

    const deleted = await request(port, `/api/chat-jobs/${jobId}`, { method: 'DELETE', headers: { Cookie: owner.cookie } });
    assert.deepStrictEqual(parseJson(deleted), { disposed: true, existed: true });
  } finally {
    await close(server);
    global.fetch = originalFetch;
    if (originalAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = originalAllowPrivate;
  }
}

function testPrincipalCookiesAreSignedTenantBoundTamperResistantAndPrivate() {
  let randomValue = 1;
  let nowMs = Date.UTC(2026, 7, 9, 0, 0, 0);
  const randomBytes = size => Buffer.alloc(size, randomValue++);
  const service = createRequestPrincipalService({
    secret: TEST_SECRET,
    tenantId: 'tenant-a',
    cookieSecure: 'never',
    randomBytes,
    now: () => nowMs,
  });
  const first = service.resolveRequest({ headers: {} });
  const firstPair = cookiePair(first.cookie);
  assert.strictEqual(first.issued, true);
  assert.match(first.cookie, /; HttpOnly(?:;|$)/i);
  assert.match(first.cookie, /; SameSite=Strict(?:;|$)/i);
  assert.match(first.cookie, /; Max-Age=86400(?:;|$)/i);
  assert.doesNotMatch(first.cookie, /; Secure(?:;|$)/i);

  const roundTrip = service.resolveRequest({ headers: { cookie: firstPair } });
  assert.strictEqual(roundTrip.issued, false);
  const job = { id: 'chatjob-hidden01', status: 'done', createdAt: 1, updatedAt: 2, data: { ok: true } };
  bindJobOwner(job, first.principal);
  assert.strictEqual(jobOwnedBy(job, roundTrip.principal), true);
  assert.deepStrictEqual(Object.keys(first.principal), []);
  assert.strictEqual(JSON.stringify(first.principal), '{}');
  assert.strictEqual(JSON.stringify(job).includes('tenant-a'), false);
  assert.strictEqual(JSON.stringify(job).includes(firstPair), false);
  assert.deepStrictEqual(publicJob(job), {
    id: 'chatjob-hidden01',
    status: 'done',
    createdAt: 1,
    updatedAt: 2,
    data: { ok: true },
    metrics: { firstTokenMs: null, durationMs: null },
    error: null,
  });

  const duplicateWithInvalid = service.resolveRequest({ headers: { cookie: `${PRINCIPAL_COOKIE_NAME}=invalid; ${firstPair}` } });
  assert.strictEqual(duplicateWithInvalid.issued, false, 'an invalid shadow cookie must not cause owner rotation when exactly one signed cookie is valid');
  assert.strictEqual(jobOwnedBy(job, duplicateWithInvalid.principal), true);

  nowMs += 19 * 60 * 60 * 1000;
  const refreshed = service.resolveRequest({ headers: { cookie: firstPair } });
  assert.strictEqual(refreshed.issued, true, 'an active principal nearing expiry should refresh without changing owner');
  assert.strictEqual(jobOwnedBy(job, refreshed.principal), true);
  assert.notStrictEqual(cookiePair(refreshed.cookie), firstPair);
  nowMs -= 19 * 60 * 60 * 1000;

  const token = firstPair.slice(firstPair.indexOf('=') + 1);
  const tamperedToken = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  const tampered = service.resolveRequest({ headers: { cookie: `${PRINCIPAL_COOKIE_NAME}=${tamperedToken}` } });
  assert.strictEqual(tampered.issued, true);
  assert.strictEqual(jobOwnedBy(job, tampered.principal), false);

  nowMs += (24 * 60 * 60 + 1) * 1000;
  const expired = service.resolveRequest({ headers: { cookie: firstPair } });
  assert.strictEqual(expired.issued, true, 'a copied token must stop authenticating after its signed expiry');
  assert.strictEqual(jobOwnedBy(job, expired.principal), false);

  nowMs -= (24 * 60 * 60 + 1) * 1000;
  const otherTenant = createRequestPrincipalService({
    secret: TEST_SECRET,
    tenantId: 'tenant-b',
    cookieSecure: 'never',
    randomBytes,
    now: () => nowMs,
  }).resolveRequest({ headers: { cookie: firstPair } });
  assert.strictEqual(otherTenant.issued, true, 'a cookie signed for another deployment tenant must not authenticate');
  assert.strictEqual(jobOwnedBy(job, otherTenant.principal), false);

  const second = service.resolveRequest({ headers: {} });
  const ambiguous = service.resolveRequest({ headers: { cookie: `${firstPair}; ${cookiePair(second.cookie)}` } });
  assert.strictEqual(ambiguous.issued, true, 'multiple distinct valid principals must fail closed and rotate');
  assert.strictEqual(jobOwnedBy(job, ambiguous.principal), false);
  assert.throws(() => bindJobOwner(job, second.principal), error => error?.code === 'JOB_OWNER_IMMUTABLE');
  assert.strictEqual(findOwnedJob(new Map([[job.id, job]]), job.id, second.principal), null);

  const unowned = { id: 'chatjob-unowned1' };
  assert.strictEqual(findOwnedJob(new Map([[unowned.id, unowned]]), unowned.id, first.principal), null, 'legacy or malformed unowned jobs must fail closed');
  assert.throws(
    () => createRequestPrincipalService({ secret: 'too-short' }),
    error => error?.code === 'PRINCIPAL_SECRET_TOO_SHORT',
  );
}

function testPrincipalCookieSecurePolicyAndResponseCacheIsolation() {
  const secureService = createRequestPrincipalService({
    secret: TEST_SECRET,
    tenantId: 'tenant-secure',
    cookieSecure: 'always',
    randomBytes: size => Buffer.alloc(size, 7),
  });
  const secure = secureService.resolveRequest({ headers: {}, socket: {} });
  assert.match(secure.cookie, /; Secure(?:;|$)/i);

  const proxiedService = createRequestPrincipalService({
    secret: TEST_SECRET,
    tenantId: 'tenant-proxy',
    cookieSecure: 'auto',
    trustProxy: true,
    randomBytes: size => Buffer.alloc(size, 8),
  });
  assert.match(proxiedService.resolveRequest({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }).cookie, /; Secure(?:;|$)/i);

  const untrustedProxyService = createRequestPrincipalService({
    secret: TEST_SECRET,
    tenantId: 'tenant-untrusted-proxy',
    cookieSecure: 'auto',
    trustProxy: false,
    randomBytes: size => Buffer.alloc(size, 9),
  });
  assert.doesNotMatch(untrustedProxyService.resolveRequest({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }).cookie, /; Secure(?:;|$)/i);

  const req = { headers: {}, socket: {} };
  const res = {
    status: 0,
    headers: {},
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; },
  };
  untrustedProxyService.attach(req, res);
  res.writeHead(200, { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'text/plain' });
  assert.strictEqual(res.status, 200);
  assert.match(String(res.headers['Set-Cookie']?.[0] || ''), new RegExp(`^${PRINCIPAL_COOKIE_NAME}=`));
  assert.strictEqual(res.headers['Cache-Control'], 'private, no-store');

  const validPair = String(res.headers['Set-Cookie'][0]).split(';')[0];
  const validReq = { headers: { cookie: validPair }, socket: {} };
  const validRes = {
    headers: {},
    writeHead(_status, headers = {}) { this.headers = headers; },
  };
  untrustedProxyService.attach(validReq, validRes);
  validRes.writeHead(200, { 'Cache-Control': 'public, max-age=3600' });
  assert.strictEqual(validRes.headers['Set-Cookie'], undefined, 'a valid principal must not be needlessly rotated on every response');
}


function testReusedJobIdCannotLeakThroughStaleSubscriberState() {
  const service = createRequestPrincipalService({
    secret: TEST_SECRET,
    tenantId: 'subscriber-tenant',
    cookieSecure: 'never',
  });
  const ownerA = service.resolveRequest({ headers: {} }).principal;
  const ownerB = service.resolveRequest({ headers: {} }).principal;
  const jobId = 'chatjob-reused001';
  const oldJob = { id: jobId, status: 'running', createdAt: 1, updatedAt: 2, compactStream: true };
  bindJobOwner(oldJob, ownerA);
  const store = new Map([[jobId, oldJob]]);
  const subscribers = new Map();
  const { subscribeJob, notifyJob } = createJobEvents({ jobSubscribers: subscribers });
  const makeRequest = principal => ({
    url: `/api/chat-jobs/${jobId}/events`,
    authPrincipal: principal,
    on() { return this; },
  });
  const makeResponse = () => ({
    body: '',
    ended: false,
    writeHead() {},
    write(chunk) { this.body += String(chunk); },
    flushHeaders() {},
    end() { this.ended = true; },
  });
  const oldResponse = makeResponse();
  subscribeJob(makeRequest(ownerA), oldResponse, store);
  assert.strictEqual(subscribers.has(jobId), true);

  store.delete(jobId); // Simulate TTL/max-size eviction without the HTTP dispose path.
  const replacement = {
    id: jobId,
    status: 'running',
    createdAt: 3,
    updatedAt: 4,
    compactStream: true,
    streamDelta: { content: 'replacement-owner-secret' },
  };
  bindJobOwner(replacement, ownerB);
  store.set(jobId, replacement);
  const replacementResponse = makeResponse();
  subscribeJob(makeRequest(ownerB), replacementResponse, store);
  const oldBodyBeforeReplacementUpdate = oldResponse.body;
  const replacementBodyBeforeUpdate = replacementResponse.body;
  notifyJob(replacement);

  assert.strictEqual(oldResponse.body, oldBodyBeforeReplacementUpdate, 'a stale subscriber must never receive a replacement owner\'s data');
  assert.ok(replacementResponse.body.slice(replacementBodyBeforeUpdate.length).includes('replacement-owner-secret'));
  assert.strictEqual(replacementResponse.ended, false);

  oldJob.status = 'error';
  oldJob.error = 'old-owner-terminal';
  oldJob.streamDelta = { content: 'old-owner-only' };
  const replacementBodyBeforeLateOldUpdate = replacementResponse.body;
  notifyJob(oldJob);
  assert.ok(oldResponse.body.includes('old-owner-terminal'), 'the old job may settle only its own original subscriber');
  assert.strictEqual(oldResponse.ended, true);
  assert.strictEqual(replacementResponse.body, replacementBodyBeforeLateOldUpdate, 'a late old-job notification must not reach or close the replacement subscriber');
  assert.strictEqual(replacementResponse.ended, false);

  replacement.status = 'done';
  replacement.streamDelta = { content: 'replacement-terminal' };
  notifyJob(replacement);
  assert.strictEqual(replacementResponse.ended, true);
  assert.strictEqual(subscribers.has(jobId), false);
}

async function testServerIssuesDistinctSignedPrincipalCookies() {
  const { server } = createApp();
  const port = await listen(server);
  try {
    const [first, second] = await Promise.all([
      request(port, '/api/version'),
      request(port, '/api/version'),
    ]);
    const firstCookie = first.headers['set-cookie']?.[0] || '';
    const secondCookie = second.headers['set-cookie']?.[0] || '';

    assert.match(firstCookie, new RegExp(`^${PRINCIPAL_COOKIE_NAME}=`), 'a request without a principal must receive a server-issued principal cookie');
    assert.match(firstCookie, /; HttpOnly(?:;|$)/i);
    assert.match(firstCookie, /; SameSite=Strict(?:;|$)/i);
    assert.match(firstCookie, /; Path=\/(?:;|$)/i);
    assert.notStrictEqual(firstCookie.split(';')[0], secondCookie.split(';')[0], 'concurrent anonymous clients must not share a principal');
    assert.match(first.headers['cache-control'] || '', /no-store/i, 'responses that issue a principal must not be shared-cacheable');
  } finally {
    await close(server);
  }
}

module.exports = [
  testChatJobOwnerGuardsReadSseAbortDeleteAndReuse,
  testImageJobOwnerGuardsReadSseAbortDeleteAndReuse,
  testChatStreamRegistrationAndProxyReuseAreOwnerBound,
  testPrincipalCookiesAreSignedTenantBoundTamperResistantAndPrivate,
  testPrincipalCookieSecurePolicyAndResponseCacheIsolation,
  testReusedJobIdCannotLeakThroughStaleSubscriberState,
  testServerIssuesDistinctSignedPrincipalCookies,
];
