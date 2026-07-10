const assert = require('assert');

const { JobStore } = require('../../server/jobs/store');
const jobEvents = require('../../server/jobs/events');
const jobUrl = require('../../server/jobs/job-url');
const { readBody } = require('../../server/http/body');
const staticHttp = require('../../server/http/static');
const urlPolicy = require('../../server/security/url-policy');
const { fetchWithValidatedRedirects, configuredUpstreamProxyUrl, readUpstreamErrorDetails, summarizeUpstreamRequest, normalizeUpstreamErrorMessage } = require('../../server/jobs/common');
const extractApi = require('../../server/extract');
const { ConcurrencyLimiter } = require('../../server/concurrency');
const safeLog = require('../../server/logging/safe-log');
const { sendError } = require('../../server/http/response');
const { AppError, normalizeError, toErrorPayload } = require('../../server/errors/http-error');

function createMockResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    ended: false,
    flushed: 0,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk = '') { this.body += String(chunk); },
    flushHeaders() { this.flushed += 1; },
    end(body = '') { this.body += String(body || ''); this.ended = true; },
  };
}

function createMockRequest(url) {
  return {
    url,
    listeners: {},
    on(name, fn) { this.listeners[name] = fn; return this; },
    close() { this.listeners.close?.(); },
  };
}

function parseSseJson(body) {
  const dataLine = String(body || '').split(/\r?\n/).find(line => line.startsWith('data: '));
  assert.ok(dataLine, `missing SSE data line in ${body}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

function parseLastSseJson(body) {
  const dataLines = String(body || '').split(/\r?\n/).filter(line => line.startsWith('data: '));
  assert.ok(dataLines.length, `missing SSE data line in ${body}`);
  return JSON.parse(dataLines.at(-1).slice('data: '.length));
}

function testJobUrlHelpersPreserveRouteParsingContract() {
  assert.deepStrictEqual(jobUrl.pathSegments('/api/chat-jobs/chatjob-abc12345/events?contentLength=1'), ['api', 'chat-jobs', 'chatjob-abc12345', 'events']);
  assert.strictEqual(jobUrl.isJobEventsUrl('/api/chat-jobs/chatjob-abc12345/events?contentLength=1'), true);
  assert.strictEqual(jobUrl.isAbortJobUrl('/api/image-jobs/imgjob-abc12345/abort?x=1'), true);
  assert.strictEqual(jobUrl.getJobIdFromUrl('/api/image-jobs/imgjob-abc12345/abort?x=1'), 'imgjob-abc12345');
  assert.strictEqual(jobUrl.getJobIdFromUrl({ url: '/api/chat-jobs/chatjob-a%2Fb/events' }), 'chatjob-a/b');
  assert.strictEqual(jobUrl.getJobIdFromUrl('/api/chat-jobs/chatjob-plain'), 'chatjob-plain');
}

function testJobEventsPreserveCompactPublicContract() {
  const job = {
    id: 'chatjob-abc12345',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    compactStream: true,
    streamDelta: { content: '增量', reasoning: '推理' },
    firstTokenMs: 12,
    durationMs: 34,
  };
  assert.deepStrictEqual(jobEvents.publicJob(job, { live: true }), { d: '增量', r: '推理', ft: 12, rt: 34 });
  job.status = 'done';
  job.data = { choices: [{ message: { content: 'abcdef', reasoning_content: 'uvwxyz' } }] };
  assert.deepStrictEqual(jobEvents.publicJob(job, { resumeUrl: '/api/chat-jobs/chatjob-abc12345/events?contentLength=2&reasoningLength=3' }), { d: 'cdef', r: 'xyz', rt: 34, done: 1 });
}

function testJobEventsSubscribeAndAbortContracts() {
  const subscribers = new Map();
  const { subscribeJob, abortJob, notifyJob } = jobEvents.createJobEvents({ jobSubscribers: subscribers });

  const missingReq = createMockRequest('/api/chat-jobs/missing-job/events');
  const missingRes = createMockResponse();
  subscribeJob(missingReq, missingRes, new Map());
  assert.strictEqual(missingRes.status, 200);
  assert.strictEqual(missingRes.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.strictEqual(missingRes.headers['Access-Control-Allow-Origin'], '*');
  assert.strictEqual(missingRes.ended, true);
  assert.deepStrictEqual(parseSseJson(missingRes.body), { status: 'error', error: { message: '任务不存在或服务已重启' } });

  const doneStore = new Map([['chatjob-done12345', {
    id: 'chatjob-done12345',
    status: 'done',
    createdAt: 1,
    updatedAt: 2,
    compactStream: true,
    data: { choices: [{ message: { content: 'hello world', reasoning_content: 'think' } }] },
  }]]);
  const doneReq = createMockRequest('/api/chat-jobs/chatjob-done12345/events?contentLength=6&reasoningLength=1');
  const doneRes = createMockResponse();
  subscribeJob(doneReq, doneRes, doneStore);
  assert.strictEqual(doneRes.status, 200);
  assert.strictEqual(doneRes.ended, true);
  assert.deepStrictEqual(parseSseJson(doneRes.body), { d: 'world', r: 'hink', done: 1 });
  assert.strictEqual(subscribers.has('chatjob-done12345'), false);

  let aborted = false;
  const runningJob = {
    id: 'chatjob-run12345',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    compactStream: true,
    controller: { abort: () => { aborted = true; } },
  };
  const runningStore = new Map([['chatjob-run12345', runningJob]]);
  const runningReq = createMockRequest('/api/chat-jobs/chatjob-run12345/events');
  const runningRes = createMockResponse();
  subscribeJob(runningReq, runningRes, runningStore);
  assert.strictEqual(subscribers.get('chatjob-run12345').has(runningRes), true);
  const abortedJob = abortJob(runningStore, 'chatjob-run12345');
  assert.strictEqual(aborted, true);
  assert.strictEqual(abortedJob.status, 'error');
  assert.strictEqual(runningRes.ended, true);
  assert.deepStrictEqual(parseLastSseJson(runningRes.body), { e: '任务已停止' });
  assert.strictEqual(subscribers.has('chatjob-run12345'), false);

  const firstTokenJob = { id: 'chatjob-ft12345', status: 'running', compactStream: true, firstTokenMs: 0, streamDelta: { content: 'a' } };
  const ftRes = createMockResponse();
  subscribers.set(firstTokenJob.id, new Set([ftRes]));
  notifyJob(firstTokenJob);
  assert.strictEqual(firstTokenJob.firstTokenNotified, true);
  assert.strictEqual(firstTokenJob.streamDelta, undefined);
  assert.deepStrictEqual(parseSseJson(ftRes.body), { d: 'a', ft: 0 });
}

async function testServerHardeningHelpers() {
  assert.strictEqual(staticHttp.isPublicStaticPath('/'), true);
  assert.strictEqual(staticHttp.isPublicStaticPath('/app.js'), true);
  assert.strictEqual(staticHttp.isPublicStaticPath('/client/app/browser.js'), true);
  assert.strictEqual(staticHttp.isPublicStaticPath('/package.json'), false);
  assert.strictEqual(staticHttp.isPublicStaticPath('/server/config/index.js'), false);
  assert.strictEqual(staticHttp.isPublicStaticPath('/.git/config'), false);
  assert.strictEqual(staticHttp.isPublicStaticPath('/Dockerfile'), false);
  assert.strictEqual(urlPolicy.isPrivateHostname('localhost'), true);
  assert.strictEqual(urlPolicy.isPrivateHostname('::ffff:127.0.0.1'), true);
  assert.strictEqual(urlPolicy.normalizeBaseUrl('http://127.0.0.1:8765'), '');
  assert.strictEqual(urlPolicy.normalizeBaseUrl('http://127.0.0.1:18765', { allowPrivate: true }), 'http://127.0.0.1:18765');
  assert.strictEqual(urlPolicy.assertAllowedUpstreamUrl('https://api.example.com/v1'), true);
  assert.strictEqual(await urlPolicy.assertPublicHostname('public.example', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }), true);
  assert.strictEqual(await urlPolicy.assertPublicHostname('rebind.example', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), false);
  assert.ok(safeLog.redactString('Authorization: Bearer sk-secret1234567890').includes('[redacted]'));
  assert.ok(!safeLog.redactString('data:image/png;base64,' + 'A'.repeat(5000)).includes('data:image'));

  const store = new JobStore('test', { ttlMs: 1000000, runningTtlMs: 10, maxJobs: 1 });
  let aborted = false;
  const now = Date.now();
  store.set('running-old', { status: 'running', createdAt: now - 1000, updatedAt: now - 1000, controller: { abort: () => { aborted = true; } } });
  store.sweep(now);
  const expired = store.get('running-old');
  assert.strictEqual(aborted, true);
  assert.strictEqual(expired.status, 'error');

  assert.strictEqual(extractApi.fileKind('a.txt', 'text/plain'), 'text');
  assert.strictEqual(extractApi.fileKind('a.pdf', ''), 'pdf');
  assert.strictEqual(extractApi.estimateDataUrlBytes('data:text/plain;base64,QUJDRA=='), 6);
  assert.throws(() => extractApi.assertExtractSizeAllowed('text', 999999999), /文件过大/);

  const limiter = new ConcurrencyLimiter(1, { maxQueue: 0 });
  return limiter.acquire()
    .then(() => limiter.acquire().then(() => assert.fail('should reject queue overflow')).catch(err => assert.strictEqual(err.statusCode, 429)))
    .finally(() => limiter.release());
}

async function testReadBodyHonorsPerRouteLimitAndDrainsOversizeRequests() {
  const listeners = {};
  const req = {
    headers: {},
    setEncoding() {},
    on(name, fn) { listeners[name] = fn; return this; },
  };
  const promise = readBody(req, { maxBytes: 8 });
  listeners.data('12345');
  listeners.data('67890');
  await assert.rejects(promise, err => err.statusCode === 413 && err.code === 'PAYLOAD_TOO_LARGE');
  assert.doesNotThrow(() => listeners.data('remaining bytes are drained'));
  assert.doesNotThrow(() => listeners.end());

  let resumed = false;
  const declaredTooLarge = {
    headers: { 'content-length': '9' },
    resume() { resumed = true; },
    setEncoding() {},
    on() { return this; },
  };
  await assert.rejects(readBody(declaredTooLarge, { maxBytes: 8 }), err => err.statusCode === 413 && err.code === 'PAYLOAD_TOO_LARGE');
  assert.strictEqual(resumed, true, 'known oversize bodies should be drained immediately');
}

async function testConnectionLookupRejectsMixedOrReboundPrivateAddresses() {
  const invokeLookup = (addresses, options = {}) => new Promise((resolve, reject) => {
    const lookup = urlPolicy.createPublicLookup({
      lookup(hostname, lookupOptions, callback) { callback(null, addresses); },
    });
    lookup('rebind.example', options, (err, address, family) => err ? reject(err) : resolve({ address, family }));
  });

  await assert.rejects(
    invokeLookup([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]),
    err => err.code === 'INVALID_UPSTREAM_ADDRESS'
  );
  assert.deepStrictEqual(await invokeLookup([{ address: '93.184.216.34', family: 4 }]), { address: '93.184.216.34', family: 4 });

  let dispatcherAttached = false;
  const response = await fetchWithValidatedRedirects('https://93.184.216.34/v1', {}, {
    fetchImpl: async (url, options) => {
      dispatcherAttached = !!options.dispatcher;
      return { status: 200, headers: { get: () => null } };
    },
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(dispatcherAttached, true, 'public upstream fetches should use the guarded socket dispatcher');
}

function testUpstreamErrorDiagnosticsAreSafeAndActionable() {
  const original = { CHATUI_UPSTREAM_PROXY: process.env.CHATUI_UPSTREAM_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY };
  process.env.CHATUI_UPSTREAM_PROXY = 'http://explicit-proxy.example:8080';
  assert.strictEqual(configuredUpstreamProxyUrl(), 'http://explicit-proxy.example:8080');
  delete process.env.CHATUI_UPSTREAM_PROXY;
  process.env.HTTPS_PROXY = 'http://https-proxy.example:8080';
  assert.strictEqual(configuredUpstreamProxyUrl(), 'http://https-proxy.example:8080');
  for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value;

  const networkError = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  });
  assert.deepStrictEqual(readUpstreamErrorDetails(networkError).codes, ['ECONNRESET']);
  assert.match(normalizeUpstreamErrorMessage(networkError), /ECONNRESET/);
  assert.match(normalizeUpstreamErrorMessage(networkError), /Docker/);

  const body = JSON.stringify({ image: 'data:image/png;base64,very-secret' });
  const summary = summarizeUpstreamRequest('https://api.example.com/v1/chat/completions?api_key=do-not-log', {
    method: 'POST',
    body,
    job: { payload: { messages: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,very-secret' } }] }] } },
  });
  assert.deepStrictEqual(summary, {
    target: 'https://api.example.com/v1/chat/completions',
    method: 'POST',
    outboundBytes: Buffer.byteLength(body, 'utf8'),
    imageParts: 1,
  });
}

function testSendErrorKeepsLegacyContract() {
  const res = createMockResponse();
  sendError(res, 418, '旧错误文案', 'LEGACY_CODE', { field: 'name' }, { 'X-Test': 'ok' });
  assert.strictEqual(res.status, 418);
  assert.strictEqual(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.strictEqual(res.headers['X-Test'], 'ok');
  assert.deepStrictEqual(JSON.parse(res.body), { error: { code: 'LEGACY_CODE', message: '旧错误文案', detail: { field: 'name' } } });
}

function testAppErrorHelpersAreSendErrorCompatible() {
  const err = new AppError('兼容错误文案', {
    statusCode: 409,
    code: 'APP_CONFLICT',
    detail: { jobId: 'job-1' },
    headers: { 'X-App-Error': 'yes' },
  });

  assert.deepStrictEqual(normalizeError(err), {
    statusCode: 409,
    message: '兼容错误文案',
    code: 'APP_CONFLICT',
    detail: { jobId: 'job-1' },
    headers: { 'X-App-Error': 'yes' },
    original: err,
  });
  assert.deepStrictEqual(toErrorPayload(err), { error: { code: 'APP_CONFLICT', message: '兼容错误文案', detail: { jobId: 'job-1' } } });

  const res = createMockResponse();
  sendError(res, err);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.headers['X-App-Error'], 'yes');
  assert.deepStrictEqual(JSON.parse(res.body), { error: { code: 'APP_CONFLICT', message: '兼容错误文案', detail: { jobId: 'job-1' } } });
}

module.exports = [
  testJobUrlHelpersPreserveRouteParsingContract,
  testJobEventsPreserveCompactPublicContract,
  testJobEventsSubscribeAndAbortContracts,
  testServerHardeningHelpers,
  testReadBodyHonorsPerRouteLimitAndDrainsOversizeRequests,
  testConnectionLookupRejectsMixedOrReboundPrivateAddresses,
  testUpstreamErrorDiagnosticsAreSafeAndActionable,
  testSendErrorKeepsLegacyContract,
  testAppErrorHelpersAreSendErrorCompatible,
];
