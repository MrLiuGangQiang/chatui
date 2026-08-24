'use strict';

const assert = require('assert');
const { ConcurrencyLimiter, limiter, withLimiter } = require('../../server/concurrency');
const { createImageJobHandlers, runImageJob } = require('../../server/jobs/image');
const { createJobEvents } = require('../../server/jobs/events');
const { createIdempotencyTable } = require('../../server/validators/idempotency.validator');
const { bindJobOwner } = require('../../server/security/job-ownership');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');
const { attachTestPrincipal, makeTestPrincipal } = require('../helpers/request-principal-fixture');

function createJsonRequest(body, principal = makeTestPrincipal()) {
  const raw = JSON.stringify(body);
  const req = {
    url: '/api/image-jobs',
    method: 'POST',
    headers: { 'content-length': String(Buffer.byteLength(raw)) },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) {
      if (event === 'data') process.nextTick(() => listener(Buffer.from(raw)));
      else if (event === 'end') process.nextTick(listener);
      return this;
    },
  };
  return attachTestPrincipal(req, principal);
}

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
    },
    end(body = '') { this.body = String(body || ''); },
  };
}

function imageRequest(jobId, prompt, plan = makeDispatchContract({ operation: 'text_to_image', prompt }), submissionId = '') {
  return {
    baseUrl: 'http://127.0.0.1:65534/v1',
    apiKey: 'test-key',
    jobId,
    ...(submissionId ? { submissionId } : {}),
    requestPurpose: 'final_execution',
    dispatchContract: plan,
    bindingEvidence: [],
    payload: { model: 'gpt-image-1', prompt },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function withPrivateFetch(fetchImpl, run) {
  const previousFetch = global.fetch;
  const previousAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  global.fetch = fetchImpl;
  try { return await run(); }
  finally {
    global.fetch = previousFetch;
    if (previousAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = previousAllowPrivate;
  }
}

async function testQueuedLimiterAcquisitionCanBeCancelledBeforeExecution() {
  const limiter = new ConcurrencyLimiter(1, { maxQueue: 2 });
  await limiter.acquire();
  const controller = new AbortController();
  let executed = false;
  const queued = withLimiter(limiter, async () => { executed = true; }, { signal: controller.signal });

  assert.strictEqual(limiter.pending, 1);
  controller.abort();
  limiter.release();

  await assert.rejects(queued, error => error?.name === 'AbortError');
  assert.strictEqual(executed, false, 'a cancelled queue entry must never enter the upstream runner');
  assert.strictEqual(limiter.pending, 0);
  assert.strictEqual(limiter.active, 0);
}

async function testQueuedImageJobStopNeverDispatchesUpstream() {
  const principal = makeTestPrincipal();
  const imageJobs = new Map();
  const events = createJobEvents({ jobSubscribers: new Map() });
  const handlers = createImageJobHandlers({
    imageJobs,
    notifyJob: () => {},
    upstreamTimeoutMs: 1000,
    requestTrace: null,
    errorLog: null,
    idempotencyTable: null,
  });
  const previousRunning = limiter.running;
  const previousQueue = [...limiter.queue];
  let upstreamCalls = 0;
  try {
    assert.strictEqual(limiter.pending, 0, 'the shared limiter must be idle before this regression test');
    limiter.running = limiter.max;
    await withPrivateFetch(async () => {
      upstreamCalls += 1;
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"data":[]}' };
    }, async () => {
      const response = createMockResponse();
      const request = imageRequest('imgjob-queued-stop1', '排队后立即停止');
      await handlers.startImageJob(createJsonRequest(request, principal), response);
      assert.strictEqual(response.statusCode, 202);
      assert.strictEqual(limiter.pending, 1);
      events.abortJob(imageJobs, request.jobId, principal);
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(limiter.pending, 0, 'stopping a queued job must remove its limiter waiter immediately');
      assert.strictEqual(imageJobs.get(request.jobId)?.error, '任务已停止');
      assert.strictEqual(upstreamCalls, 0);
    });
  } finally {
    limiter.queue.splice(0, limiter.queue.length, ...previousQueue);
    limiter.running = previousRunning;
  }
}

async function testLateSuccessfulImageResponseCannotReverseUserStop() {
  const principal = makeTestPrincipal();
  const imageJobs = new Map();
  const events = createJobEvents({ jobSubscribers: new Map() });
  const job = {
    id: 'imgjob-late-success1',
    mode: 'image',
    status: 'running',
    targetUrl: 'http://127.0.0.1:65534/v1/images/generations',
    payload: { model: 'gpt-image-1', prompt: '迟到图片' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    data: null,
    error: '',
  };
  bindJobOwner(job, principal);
  imageJobs.set(job.id, job);
  let resolveFetch;
  await withPrivateFetch(() => new Promise(resolve => { resolveFetch = resolve; }), async () => {
    const running = runImageJob(job, { notifyJob: () => {}, upstreamTimeoutMs: 1000 });
    await waitFor(() => typeof resolveFetch === 'function' && !!job.controller);
    events.abortJob(imageJobs, job.id, principal);
    resolveFetch({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ data: [{ url: 'https://img.example/late.png' }] }),
    });
    await running;
  });
  assert.strictEqual(job.status, 'error');
  assert.strictEqual(job.error, '任务已停止');
  assert.strictEqual(job.data, null, 'a late successful provider result must not be committed after stop');
}

async function testRunningImageAbortPreservesUserStopTerminalState() {
  const principal = makeTestPrincipal();
  const imageJobs = new Map();
  const jobSubscribers = new Map();
  const events = createJobEvents({ jobSubscribers });
  const job = {
    id: 'imgjob-running-stop1',
    mode: 'image',
    status: 'running',
    targetUrl: 'http://127.0.0.1:65534/v1/images/generations',
    payload: { model: 'gpt-image-1', prompt: '画猫' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    data: null,
    error: '',
  };
  bindJobOwner(job, principal);
  imageJobs.set(job.id, job);

  let upstreamStarted = false;
  await withPrivateFetch((_url, request = {}) => new Promise((resolve, reject) => {
    upstreamStarted = true;
    request.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  }), async () => {
    const running = runImageJob(job, { notifyJob: () => {}, upstreamTimeoutMs: 1000 });
    await waitFor(() => upstreamStarted && !!job.controller);
    events.abortJob(imageJobs, job.id, principal);
    await running;
  });

  assert.strictEqual(job.status, 'error');
  assert.strictEqual(job.error, '任务已停止', 'a late AbortError must not rewrite a user stop as an upstream timeout');
  assert.strictEqual(job.data, null);
}

async function testFailedImageExecutionCanBeRetriedWithTheSamePlan() {
  const imageJobs = new Map();
  const idempotencyTable = createIdempotencyTable();
  const principal = makeTestPrincipal();
  const handlers = createImageJobHandlers({
    imageJobs,
    notifyJob: () => {},
    upstreamTimeoutMs: 1000,
    requestTrace: null,
    errorLog: null,
    idempotencyTable,
  });
  const prompt = '失败后重试同一张图';
  const plan = makeDispatchContract({ operation: 'text_to_image', prompt });
  let calls = 0;

  await withPrivateFetch(async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('temporary outage');
      error.code = 'ECONNRESET';
      throw error;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ data: [{ url: 'https://img.example/retry.png' }] }),
    };
  }, async () => {
    const first = createMockResponse();
    await handlers.startImageJob(createJsonRequest(imageRequest('imgjob-retry-fail1', prompt, plan, 'submit-retry-same'), principal), first);
    assert.strictEqual(first.statusCode, 202);
    await waitFor(() => imageJobs.get('imgjob-retry-fail1')?.status === 'error');

    const retry = createMockResponse();
    await handlers.startImageJob(createJsonRequest(imageRequest('imgjob-retry-pass2', prompt, plan, 'submit-retry-same'), principal), retry);
    assert.strictEqual(retry.statusCode, 202, 'a failed execution must release its idempotency reservation');
    await waitFor(() => imageJobs.get('imgjob-retry-pass2')?.status === 'done');
  });

  assert.strictEqual(calls, 2);
}

async function testIdempotencyScopesPlansByPrincipalAndRejectsKeyCollisions() {
  const idempotency = require('../../server/validators/idempotency.validator');
  const dispatchContract = require('../../shared/dispatch-contract');
  const table = idempotency.createIdempotencyTable({ ttlMs: 60_000, maxEntries: 10 });
  table.consume({ key: 'ep1-same', fingerprint: 'fp-a', scope: 'principal-a', result: 'job-a' });

  assert.strictEqual(table.check({ key: 'ep1-same', fingerprint: 'fp-a', scope: 'principal-a' }).status, 'consumed');
  assert.strictEqual(table.check({ key: 'ep1-same', fingerprint: 'fp-a', scope: 'principal-b' }).status, 'new', 'different principals must not consume each other');
  assert.strictEqual(table.check({ key: 'ep1-same', fingerprint: 'fp-b', scope: 'principal-a' }).status, 'conflict', 'a reused key with different content must be a conflict');

  const plan = prompt => ({
    schema_version: 'dispatch_contract.v1',
    operation: 'text_to_image',
    api: 'image_generation',
    relation: 'new',
    arguments: { prompt },
    bindings: [],
    constraints: [],
    context_policy: 'independent',
    idempotency_key: '',
  });
  const collisionA = plan('7f65e5a8fdae697351baae6e');
  const collisionB = plan('080d524d0116b52f2a526c8e');
  const collisionKey = dispatchContract.idempotencyKeyFor(collisionA);
  assert.strictEqual(collisionKey, dispatchContract.idempotencyKeyFor(collisionB), 'the fixture must retain the known 32-bit collision');
  const collisionTable = idempotency.createIdempotencyTable();
  collisionTable.consume({ key: collisionKey, fingerprint: idempotency.contentFingerprint(collisionA), scope: 'same-submission', result: 'job-a' });
  assert.strictEqual(
    collisionTable.check({ key: collisionKey, fingerprint: idempotency.contentFingerprint(collisionB), scope: 'same-submission' }).status,
    'conflict',
    'the server fingerprint must distinguish colliding client keys',
  );
}

module.exports = [
  testQueuedLimiterAcquisitionCanBeCancelledBeforeExecution,
  testQueuedImageJobStopNeverDispatchesUpstream,
  testLateSuccessfulImageResponseCannotReverseUserStop,
  testRunningImageAbortPreservesUserStopTerminalState,
  testFailedImageExecutionCanBeRetriedWithTheSamePlan,
  testIdempotencyScopesPlansByPrincipalAndRejectsKeyCollisions,
];

