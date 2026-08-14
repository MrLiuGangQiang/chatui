'use strict';

const assert = require('assert');
const { createJobStores, DEFAULT_RUNNING_TTL_MS } = require('../../server/jobs/store');
const { createImageBatchJobHandlers } = require('../../server/jobs/image-batch');
const imageBatchExecution = require('../../shared/image-batch-execution');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');
const { attachTestPrincipal, makeTestPrincipal } = require('../helpers/request-principal-fixture');

function generationTask({ jobId, prompt }) {
  return {
    jobId,
    requestPurpose: 'final_execution',
    mode: 'image',
    payload: { model: 'gpt-image-1', prompt },
    dispatchContract: makeDispatchContract({ operation: 'text_to_image', prompt }),
    bindingEvidence: [],
    files: [],
    masks: [],
  };
}

function makeBatchBody({ batchId = 'imgbatch-test12345', submissionId = 'submit-test', tasks = null } = {}) {
  return {
    schema_version: 'image_batch_execution.v1',
    batchId,
    submissionId,
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    tasks: tasks || [generationTask({ jobId: 'imgjob-test0001', prompt: 'a cat' }), generationTask({ jobId: 'imgjob-test0002', prompt: 'a dog' })],
  };
}

function makeRequest(body, principal = makeTestPrincipal()) {
  const req = {
    url: '/api/image-batches',
    method: 'POST',
    headers: { 'content-length': String(Buffer.byteLength(JSON.stringify(body))) },
    socket: { remoteAddress: '127.0.0.1' },
  };
  req.on = function on(event, fn) {
    if (event === 'data') process.nextTick(() => fn(Buffer.from(JSON.stringify(body))));
    else if (event === 'end') process.nextTick(fn);
    return this;
  };
  attachTestPrincipal(req, principal);
  return req;
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    chunks: [],
    writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(body = '') { this.body = String(body || ''); },
    write(data) { this.chunks.push(String(data)); },
    flushHeaders() {},
  };
}

function fakeRunner(job, { notifyJob }) {
  job.status = 'done';
  job.data = { data: [{ url: `https://img.example/${job.id}.png` }] };
  job.durationMs = 1;
  job.updatedAt = Date.now();
  notifyJob(job);
}

function makeHandlers({ stores, runner = fakeRunner } = {}) {
  const { imageJobs, imageBatchJobs } = stores;
  return createImageBatchJobHandlers({
    imageJobs,
    imageBatchJobs,
    jobSubscribers: new Map(),
    upstreamTimeoutMs: 60000,
    requestTrace: null,
    errorLog: null,
    idempotencyTable: null,
    providerCapabilities: null,
    notifyJob: () => {},
    runImageJobImpl: runner,
  });
}

async function until(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function testSharedContractValidation() {
  const batch = makeBatchBody({ tasks: [generationTask({ jobId: 'imgjob-test0001', prompt: 'one' })] });
  const contract = {
    schema_version: batch.schema_version,
    batchId: batch.batchId,
    submissionId: batch.submissionId,
    tasks: batch.tasks,
  };
  assert.strictEqual(imageBatchExecution.hasExactImageBatchExecution(contract), true);
  const tooMany = {
    ...contract,
    tasks: Array.from({ length: 6 }, (_, index) => generationTask({ jobId: `imgjob-test000${index + 1}`, prompt: `image ${index + 1}` })),
  };
  assert.throws(() => imageBatchExecution.assertImageBatchExecution(tooMany), error => error.code === 'IMAGE_BATCH_TOO_MANY_TASKS');
  assert.throws(() => imageBatchExecution.assertImageBatchExecution({ ...contract, tasks: [{ ...contract.tasks[0], mode: 'chat' }] }), error => error.code === 'IMAGE_BATCH_EXECUTION_INVALID');
}

async function testImageBatchEndpointCreatesParentAndChildJobs() {
  const stores = createJobStores();
  const handlers = makeHandlers({ stores });
  const body = makeBatchBody();
  const res = makeResponse();
  await handlers.startImageBatchJob(makeRequest(body), res);
  assert.strictEqual(res.statusCode, 202);
  const created = JSON.parse(res.body);
  assert.strictEqual(created.id, body.batchId);
  assert.strictEqual(created.status, 'running');
  assert.deepStrictEqual(created.data.tasks.map(task => task.id), ['imgjob-test0001', 'imgjob-test0002']);

  await until(() => stores.imageBatchJobs.get(body.batchId)?.status === 'done');
  const parent = stores.imageBatchJobs.get(body.batchId);
  assert.strictEqual(parent.status, 'done');
  assert.strictEqual(parent.error, '');
  assert.deepStrictEqual(parent.tasks.map(task => task.status), ['done', 'done']);
  assert.deepStrictEqual(stores.imageJobs.get('imgjob-test0001').status, 'done');
  assert.deepStrictEqual(stores.imageJobs.get('imgjob-test0002').status, 'done');
}

async function testImageBatchEndpointReusesTheSameBatch() {
  const stores = createJobStores();
  const handlers = makeHandlers({ stores });
  const principal = makeTestPrincipal();
  const body = makeBatchBody();
  const first = makeResponse();
  await handlers.startImageBatchJob(makeRequest(body, principal), first);
  assert.strictEqual(first.statusCode, 202);

  const second = makeResponse();
  await handlers.startImageBatchJob(makeRequest(body, principal), second);
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(JSON.parse(second.body).id, body.batchId);
}

async function testImageBatchEndpointRejectsMismatchedReplayAndInvalidContract() {
  const stores = createJobStores();
  const handlers = makeHandlers({ stores });
  const principal = makeTestPrincipal();
  const body = makeBatchBody();
  const first = makeResponse();
  await handlers.startImageBatchJob(makeRequest(body, principal), first);
  assert.strictEqual(first.statusCode, 202);

  const changed = makeBatchBody({ tasks: [generationTask({ jobId: 'imgjob-test0001', prompt: 'a cat' }), generationTask({ jobId: 'imgjob-test0002', prompt: 'a changed prompt' })] });
  const replay = makeResponse();
  await handlers.startImageBatchJob(makeRequest(changed, principal), replay);
  assert.strictEqual(replay.statusCode, 409);
  assert.strictEqual(JSON.parse(replay.body).error.code, 'IMAGE_BATCH_CONTRACT_MISMATCH');

  const invalid = makeResponse();
  await handlers.startImageBatchJob(makeRequest({ ...body, schema_version: 'bad' }), invalid);
  assert.strictEqual(invalid.statusCode, 400);
  assert.strictEqual(JSON.parse(invalid.body).error.code, 'IMAGE_BATCH_EXECUTION_INVALID');
}

async function testImageBatchAbortCascadesToChildren() {
  const stores = createJobStores();
  let childJob = null;
  const runner = job => {
    childJob = job;
    return new Promise(() => {});
  };
  const handlers = makeHandlers({ stores, runner });
  const principal = makeTestPrincipal();
  const body = makeBatchBody();
  const res = makeResponse();
  await handlers.startImageBatchJob(makeRequest(body, principal), res);
  assert.strictEqual(res.statusCode, 202);
  await until(() => !!childJob);

  const abortReq = { url: `/api/image-batches/${body.batchId}/abort`, method: 'POST' };
  attachTestPrincipal(abortReq, principal);
  const abortRes = makeResponse();
  await handlers.abortImageBatchJob(stores.imageBatchJobs, body.batchId, abortReq.authPrincipal);
  const parent = stores.imageBatchJobs.get(body.batchId);
  assert.strictEqual(parent.status, 'error');
  assert.strictEqual(parent.error, '任务已停止');
  assert.deepStrictEqual(parent.tasks.map(task => task.status), ['error', 'error']);
  assert.strictEqual(stores.imageJobs.get('imgjob-test0001').status, 'error');
  assert.strictEqual(stores.imageJobs.get('imgjob-test0002').status, 'error');
}

async function testImageBatchExpiryAbortsChildrenAndAggregatesError() {
  const stores = createJobStores();
  let childJob = null;
  const runner = job => {
    childJob = job;
    return new Promise(() => {});
  };
  const handlers = makeHandlers({ stores, runner });
  const principal = makeTestPrincipal();
  const body = makeBatchBody();
  const res = makeResponse();
  await handlers.startImageBatchJob(makeRequest(body, principal), res);
  assert.strictEqual(res.statusCode, 202);
  await until(() => !!childJob);

  stores.imageBatchJobs.sweep(Date.now() + DEFAULT_RUNNING_TTL_MS + 1000);
  const parent = stores.imageBatchJobs.get(body.batchId);
  assert.strictEqual(parent.status, 'error');
  assert.match(parent.error, /超时/);
  assert.deepStrictEqual(parent.tasks.map(task => task.status), ['error', 'error']);
  assert.strictEqual(stores.imageJobs.get('imgjob-test0001').status, 'error');
  assert.strictEqual(stores.imageJobs.get('imgjob-test0002').status, 'error');
}

module.exports = [
  testSharedContractValidation,
  testImageBatchEndpointCreatesParentAndChildJobs,
  testImageBatchEndpointReusesTheSameBatch,
  testImageBatchEndpointRejectsMismatchedReplayAndInvalidContract,
  testImageBatchAbortCascadesToChildren,
  testImageBatchExpiryAbortsChildrenAndAggregatesError,
];
