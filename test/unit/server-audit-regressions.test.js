const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const { createApp } = require('../../server/app');
const { DEFAULT_UPSTREAM_BASE_URL } = require('../../server/config');
const numbers = require('../../server/config/numbers');
const { parsePostgresSsl } = require('../../server/db/postgres');
const { createUsageController } = require('../../server/api/controllers/usage.controller');
const { createUsageAccessValidator } = require('../../server/services/usage-access.service');
const usageValidator = require('../../server/validators/usage.validator');
const usageRanges = require('../../server/usage/ranges');
const { JobStore } = require('../../server/jobs/store');
const { runImageJob } = require('../../server/jobs/image');
const { createJobEvents, writeWithBackpressure, MAX_SUBSCRIBER_BUFFER_BYTES } = require('../../server/jobs/events');
const { createOpenAiProxy } = require('../../server/proxy/openai');
const { ConcurrencyLimiter } = require('../../server/concurrency');
const { SECURITY_HEADERS } = require('../../server/http/response');
const staticHttp = require('../../server/http/static');
const staticBundle = require('../../server/services/static-bundle.service');
const usageService = require('../../server/services/usage.service');
const xlsx = require('../../server/usage/export-xlsx');
const extractUtils = require('../../server/extract/utils');

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, { redirect: 'manual', ...options });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { response, text, json };
}

function mockSendJson(res, status, data, headers = {}) {
  res.status = status;
  res.json = data;
  res.headers = headers;
  res.ended = true;
}

function usageRequest(body, remoteAddress) {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.url = '/api/usage/rankings';
  req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) };
  req.socket = { remoteAddress };
  return req;
}

async function invokeUsageRankings({ body, usageStats, usageAccessValidator, remoteAddress }) {
  const controller = createUsageController({
    sendJson: mockSendJson,
    sendMethodNotAllowed(res) { mockSendJson(res, 405, {}); },
    usageStats,
    usageAccessValidator,
  });
  const res = {};
  await controller.routeRankings(usageRequest(body, remoteAddress), res);
  return res;
}

function childModuleValue(source, overrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return childProcess.execFileSync(process.execPath, ['-e', source], {
    cwd: path.join(__dirname, '../..'),
    env,
    encoding: 'utf8',
  }).trim();
}

function testServerAuditNumericAndPostgresConfigurationFailsClosed() {
  assert.strictEqual(numbers.positiveInteger('-1', 25), 25);
  assert.strictEqual(numbers.positiveInteger('0', 25), 25);
  assert.strictEqual(numbers.timeoutMilliseconds('Infinity', 1000), 1000);
  assert.strictEqual(numbers.portNumber('70000', 8765), 8765);
  assert.deepStrictEqual(parsePostgresSsl('require'), { rejectUnauthorized: false });
  assert.deepStrictEqual(parsePostgresSsl('verify-full'), { rejectUnauthorized: true });
  assert.deepStrictEqual(parsePostgresSsl('verify-ca'), { rejectUnauthorized: true });
  assert.strictEqual(parsePostgresSsl('disable'), false);
  assert.throws(() => parsePostgresSsl('prefer'), /Unsupported PostgreSQL SSL mode/);

  const maxConnections = childModuleValue("process.stdout.write(String(require('./server/config').MAX_CONNECTIONS))", { MAX_CONNECTIONS: '0' });
  assert.strictEqual(maxConnections, '10000', 'invalid/zero MAX_CONNECTIONS must retain the finite default');
  const explicitRunningTtl = childModuleValue("process.stdout.write(String(require('./server/jobs/store').DEFAULT_RUNNING_TTL_MS))", { RUNNING_JOB_TTL_MS: '660000', UPSTREAM_TIMEOUT_MS: '600000' });
  assert.strictEqual(explicitRunningTtl, '660000', 'explicit RUNNING_JOB_TTL_MS must be the final TTL');
  assert.strictEqual(usageRanges.USAGE_TIME_ZONE, 'Asia/Shanghai');
  assert.match(usageRanges.RANGE_FILTERS.today, /AT TIME ZONE 'Asia\/Shanghai'/);
  assert.ok(!usageRanges.RANGE_FILTERS.today.includes('CURRENT_DATE'));
  assert.strictEqual(usageRanges.normalizeUsageTimeZone('America/New_York'), 'America/New_York');
  assert.strictEqual(usageRanges.normalizeUsageTimeZone("UTC'; DROP TABLE usage_logs; --"), 'Asia/Shanghai');
  assert.strictEqual(xlsx.formatDateTime(new Date(0), 'UTC'), '1970-01-01 00:00:00');
  assert.ok(!SECURITY_HEADERS['Content-Security-Policy'].includes('cdn.jsdelivr.net'));
  assert.ok(!SECURITY_HEADERS['Content-Security-Policy'].includes('registry.npmmirror.com'));
  assert.match(SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'self'/);
}

async function testServerAuditCorsAndMalformedRoutesOverRealHttp() {
  const previousAllowed = process.env.CHATUI_ALLOWED_ORIGINS;
  const previousAny = process.env.CHATUI_ALLOW_ANY_ORIGIN;
  delete process.env.CHATUI_ALLOWED_ORIGINS;
  delete process.env.CHATUI_ALLOW_ANY_ORIGIN;
  const app = createApp();
  const baseUrl = await listen(app.server);
  try {
    const noOrigin = await request(baseUrl, '/api/version');
    assert.strictEqual(noOrigin.response.status, 200);
    assert.strictEqual(noOrigin.response.headers.get('access-control-allow-origin'), null);

    const sameOrigin = await request(baseUrl, '/api/version', { headers: { Origin: baseUrl } });
    assert.strictEqual(sameOrigin.response.status, 200);
    assert.strictEqual(sameOrigin.response.headers.get('access-control-allow-origin'), baseUrl);
    assert.match(sameOrigin.response.headers.get('vary') || '', /Origin/i);

    const wrongScheme = await request(baseUrl, '/api/version', { headers: { Origin: baseUrl.replace('http:', 'https:') } });
    assert.strictEqual(wrongScheme.response.status, 403);
    const forbidden = await request(baseUrl, '/api/version', { headers: { Origin: 'https://attacker.example' } });
    assert.strictEqual(forbidden.response.status, 403);

    const options = await request(baseUrl, '/api/version', { method: 'OPTIONS', headers: { Origin: baseUrl } });
    assert.strictEqual(options.response.status, 204);
    assert.strictEqual(options.response.headers.get('access-control-allow-origin'), baseUrl);

    process.env.CHATUI_ALLOWED_ORIGINS = 'https://allowed.example';
    const allowlisted = await request(baseUrl, '/api/version', { headers: { Origin: 'https://allowed.example' } });
    assert.strictEqual(allowlisted.response.status, 200);
    assert.strictEqual(allowlisted.response.headers.get('access-control-allow-origin'), 'https://allowed.example');

    const malformedJob = await request(baseUrl, '/api/chat-jobs/%/events');
    assert.strictEqual(malformedJob.response.status, 400);
    assert.strictEqual(malformedJob.json?.error?.code, 'INVALID_JOB_URL');

    const invalidImageUrl = await request(baseUrl, '/api/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: DEFAULT_UPSTREAM_BASE_URL, url: '%' }),
    });
    assert.strictEqual(invalidImageUrl.response.status, 400);
    assert.strictEqual(invalidImageUrl.json?.error?.code, 'INVALID_IMAGE_URL');
  } finally {
    restoreEnv('CHATUI_ALLOWED_ORIGINS', previousAllowed);
    restoreEnv('CHATUI_ALLOW_ANY_ORIGIN', previousAny);
    await close(app.server);
    await app.closeResources();
  }
}

async function testServerAuditUsageAuthorizationNeverLeaksUntrustedKeys() {
  usageValidator.resetUsageRefreshBuckets();
  const validBody = { api_key: 'sk-member', model: 'model-a', base_url: DEFAULT_UPSTREAM_BASE_URL, range: 'today' };
  let upstreamValidations = 0;
  const accessValidator = { async validate() { upstreamValidations += 1; return { ok: true }; } };

  const unavailable = await invokeUsageRankings({ body: validBody, usageStats: null, usageAccessValidator: accessValidator, remoteAddress: 'audit-1' });
  assert.strictEqual(unavailable.status, 503);
  assert.strictEqual(upstreamValidations, 0);

  const queryFailure = await invokeUsageRankings({
    body: validBody,
    usageStats: { async getUserByApiKey() { throw new Error('db down'); } },
    usageAccessValidator: accessValidator,
    remoteAddress: 'audit-2',
  });
  assert.strictEqual(queryFailure.status, 503);
  assert.strictEqual(upstreamValidations, 0);

  const unknownKey = await invokeUsageRankings({
    body: validBody,
    usageStats: { async getUserByApiKey() { return null; } },
    usageAccessValidator: accessValidator,
    remoteAddress: 'audit-3',
  });
  assert.strictEqual(unknownKey.status, 403);
  assert.strictEqual(upstreamValidations, 0);

  const mismatch = await invokeUsageRankings({
    body: { ...validBody, base_url: 'https://example.com/v1' },
    usageStats: { async getUserByApiKey() { return { username: 'member' }; } },
    usageAccessValidator: accessValidator,
    remoteAddress: 'audit-4',
  });
  assert.strictEqual(mismatch.status, 403);
  assert.strictEqual(mismatch.json?.error?.code, 'UPSTREAM_BASE_URL_MISMATCH');
  assert.strictEqual(upstreamValidations, 0);

  let validatorArgs;
  const success = await invokeUsageRankings({
    body: validBody,
    usageStats: {
      async getUserByApiKey() { return { username: 'member' }; },
      async getRanking() { return []; },
    },
    usageAccessValidator: { async validate(...args) { validatorArgs = args; return { ok: true }; } },
    remoteAddress: 'audit-5',
  });
  assert.strictEqual(success.status, 200);
  assert.strictEqual(validatorArgs[2].baseUrl, DEFAULT_UPSTREAM_BASE_URL);

  const calls = [];
  const trustedBaseUrl = 'https://93.184.216.34/v1';
  const validator = createUsageAccessValidator({
    trustedBaseUrl,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.strictEqual((await validator.validate('sk-secret', 'model-a')).ok, false);
  assert.strictEqual((await validator.validate('sk-secret', 'model-a', { baseUrl: 'https://example.com/v1' })).ok, false);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual((await validator.validate('sk-secret', 'model-a', { baseUrl: trustedBaseUrl })).ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, `${trustedBaseUrl}/models`);
  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer sk-secret');
}

async function testServerAuditJobCapacityAbortAndSseBackpressure() {
  const now = Date.now();
  const transitions = [];
  const capacityStore = new JobStore('capacity-audit', { maxJobs: 1, runningTtlMs: 100000, ttlMs: 100000 });
  capacityStore.set('running', { id: 'running', status: 'running', createdAt: now, updatedAt: now });
  assert.throws(() => capacityStore.set('second', { id: 'second', status: 'running', createdAt: now, updatedAt: now }), err => err.code === 'JOB_STORE_FULL');
  const timeoutStore = new JobStore('timeout-audit', { maxJobs: 1, runningTtlMs: 10, ttlMs: 10, onTransition: (job, reason) => transitions.push([job.id, reason]) });
  timeoutStore.set('running', { id: 'running', status: 'running', createdAt: now - 100, updatedAt: now - 100 });
  timeoutStore.sweep(now);
  assert.strictEqual(timeoutStore.jobs.get('running')?.status, 'error', 'new timeout result must remain observable for a terminal TTL');
  assert.deepStrictEqual(transitions, [['running', 'running-timeout']]);

  const originalFetch = global.fetch;
  let fetches = 0;
  global.fetch = async () => { fetches += 1; throw new Error('must not fetch'); };
  try {
    await runImageJob({ status: 'error' });
    assert.strictEqual(fetches, 0, 'an aborted queued job must be skipped before upstream creation');
  } finally {
    global.fetch = originalFetch;
  }

  class BackpressureResponse extends EventEmitter {
    constructor() { super(); this.chunks = []; this.blocked = true; this.destroyed = false; this.writableEnded = false; }
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; }
    write(chunk) {
      this.chunks.push(String(chunk));
      if (!this.blocked) return true;
      this.blocked = false;
      setImmediate(() => this.emit('drain'));
      return false;
    }
    end(chunk = '') { if (chunk) this.chunks.push(String(chunk)); this.writableEnded = true; }
    flushHeaders() {}
  }
  const backpressure = new BackpressureResponse();
  assert.strictEqual(await writeWithBackpressure(backpressure, 'x'.repeat(150000)), true);
  assert.ok(backpressure.chunks.length >= 3);
  assert.ok(backpressure.chunks.every(chunk => chunk.length <= 64 * 1024));

  const oversized = new BackpressureResponse();
  oversized.blocked = false;
  const subscribers = new Map([['job-large', new Set([oversized])]]);
  const { notifyJob } = createJobEvents({ jobSubscribers: subscribers });
  notifyJob({ id: 'job-large', status: 'running', data: { blob: 'z'.repeat(MAX_SUBSCRIBER_BUFFER_BYTES + 1) } });
  assert.strictEqual(oversized.writableEnded, true);
  assert.match(oversized.chunks.join(''), /任务事件过大/);
  assert.strictEqual(subscribers.has('job-large'), false);

  const globalSubscribers = new Map();
  const boundedEvents = createJobEvents({ jobSubscribers: globalSubscribers, maxTotalSubscribers: 1 });
  const store = new Map([
    ['job-a', { id: 'job-a', status: 'running', createdAt: now, updatedAt: now }],
    ['job-b', { id: 'job-b', status: 'running', createdAt: now, updatedAt: now }],
  ]);
  const firstReq = Object.assign(new EventEmitter(), { jobId: 'job-a', url: '/api/chat-jobs/job-a/events' });
  const firstRes = new BackpressureResponse();
  firstRes.blocked = false;
  boundedEvents.subscribeJob(firstReq, firstRes, store);
  assert.strictEqual(globalSubscribers.get('job-a')?.size, 1);

  const secondReq = Object.assign(new EventEmitter(), { jobId: 'job-b', url: '/api/chat-jobs/job-b/events' });
  const secondRes = new BackpressureResponse();
  secondRes.blocked = false;
  boundedEvents.subscribeJob(secondReq, secondRes, store);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(secondRes.writableEnded, true, 'global SSE capacity must reject excess subscriptions');
  assert.match(secondRes.chunks.join(''), /subscriber capacity reached/);
  assert.strictEqual(globalSubscribers.has('job-b'), false, 'rejected subscriptions must not leave empty map entries');
  firstReq.emit('close');
  assert.strictEqual(globalSubscribers.size, 0);
}

function queuedProxyRequest(url, body) {
  const raw = JSON.stringify(body);
  let emitted = false;
  const req = new Readable({
    autoDestroy: false,
    read() {
      if (emitted) return;
      emitted = true;
      this.push(raw);
      this.push(null);
    },
  });
  req.url = url;
  req.method = 'POST';
  req.complete = true;
  req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) };
  req.socket = { remoteAddress: 'proxy-audit' };
  return req;
}

class QueuedProxyResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.headersSent = false;
  }
  writeHead() { this.headersSent = true; }
  write() { return true; }
  end() { this.writableEnded = true; }
}

async function waitForQueue(limiter) {
  for (let attempt = 0; attempt < 20 && limiter.pending === 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.strictEqual(limiter.pending, 1, 'proxy request should be waiting for the saturated limiter');
}

async function testServerAuditQueuedDirectProxyDisconnectSkipsUpstream() {
  const originalFetch = global.fetch;
  let fetches = 0;
  global.fetch = async () => { fetches += 1; throw new Error('disconnected requests must not fetch'); };
  try {
    for (const mode of ['proxy', 'image']) {
      const requestLimiter = new ConcurrencyLimiter(1, { maxQueue: 2 });
      await requestLimiter.acquire();
      const handlers = createOpenAiProxy({
        chatJobs: new Map(),
        makeChatJob() { throw new Error('not used'); },
        notifyJob() {},
        updateChatJobFromStreamChunk() {},
        upstreamTimeoutMs: 1000,
        allowedProxyMethods: new Set(['GET', 'POST']),
        allowedProxyPaths: [/^\/models\/?$/],
        requestLimiter,
      });
      const baseUrl = 'https://93.184.216.34/v1';
      const req = mode === 'proxy'
        ? queuedProxyRequest('/api/models', { baseUrl, apiKey: 'sk-secret', method: 'GET' })
        : queuedProxyRequest('/api/image', { baseUrl, apiKey: 'sk-secret', url: `${baseUrl}/image.png` });
      const res = new QueuedProxyResponse();
      const pending = mode === 'proxy' ? handlers.proxy(req, res) : handlers.proxyImage(req, res);
      await waitForQueue(requestLimiter);
      res.emit('close');
      requestLimiter.release();
      await pending;
      assert.strictEqual(requestLimiter.active, 0);
      assert.strictEqual(requestLimiter.pending, 0);
    }
    assert.strictEqual(fetches, 0);
  } finally {
    global.fetch = originalFetch;
  }
}

function invokeStatic(root, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = { url: route, method: 'GET', headers };
    const res = {
      status: 0,
      headers: {},
      writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders || {}; },
      end(body = '') { resolve({ status: this.status, headers: this.headers, body: Buffer.from(body || '').toString('utf8') }); },
    };
    try { staticHttp.serveStatic(req, res, { root, rootWithSep: `${root}${path.sep}` }); }
    catch (err) { reject(err); }
  });
}

async function testServerAuditStaticXlsxAndArchiveBounds() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-static-audit-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-static-outside-'));
  const rootWithSep = `${root}${path.sep}`;
  const indexPath = path.join(root, 'index.html');
  const assetPath = path.join(root, 'asset.js');
  fs.writeFileSync(indexPath, '<template id="chatuiAssetManifest"><script src="./asset.js"></script></template>');
  fs.writeFileSync(assetPath, 'aaa');
  staticBundle.clearBundleMetadataCaches();
  const originalRead = fs.readFileSync;
  let assetReads = 0;
  fs.readFileSync = function auditedRead(filePath, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(assetPath)) assetReads += 1;
    return originalRead.call(this, filePath, ...args);
  };
  try {
    const first = staticBundle.bundleRevision(root, rootWithSep, 'js');
    assert.strictEqual(staticBundle.bundleRevision(root, rootWithSep, 'js'), first);
    assert.strictEqual(assetReads, 1, 'stable assets should be stat-checked without repeated content reads');
    fs.writeFileSync(assetPath, 'bbb');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(assetPath, future, future);
    const changed = staticBundle.bundleRevision(root, rootWithSep, 'js');
    assert.notStrictEqual(changed, first);
    assert.strictEqual(assetReads, 2);

    fs.mkdirSync(path.join(root, 'client'), { recursive: true });
    const compressedSource = path.join(root, 'client/cache.js');
    const compressedVariant = `${compressedSource}.br`;
    fs.writeFileSync(compressedSource, 'source');
    fs.writeFileSync(compressedVariant, 'br-one');
    fs.utimesSync(compressedVariant, future, future);
    const firstCompressed = await invokeStatic(root, '/client/cache.js', { 'accept-encoding': 'br' });
    assert.strictEqual(firstCompressed.status, 200);
    assert.strictEqual(firstCompressed.headers['Content-Encoding'], 'br');
    const firstCompressedEtag = firstCompressed.headers.ETag;
    fs.writeFileSync(compressedVariant, 'br-two-longer');
    const later = new Date(Date.now() + 8000);
    fs.utimesSync(compressedVariant, later, later);
    const changedCompressed = await invokeStatic(root, '/client/cache.js', {
      'accept-encoding': 'br',
      'if-none-match': firstCompressedEtag,
    });
    assert.strictEqual(changedCompressed.status, 200, 'changed precompressed content must not reuse the source-file ETag');
    assert.notStrictEqual(changedCompressed.headers.ETag, firstCompressedEtag);

    fs.writeFileSync(path.join(root, 'client/safe.js'), 'window.safe=true;');
    fs.writeFileSync(path.join(outsideRoot, 'secret.js'), 'window.secret=true;');
    const outsideFuture = new Date(Date.now() + 4000);
    fs.utimesSync(outsideRoot, outsideFuture, outsideFuture);
    let symlinkAvailable = true;
    try {
      fs.symlinkSync(outsideRoot, path.join(root, 'client/escape'), process.platform === 'win32' ? 'junction' : 'dir');
      fs.symlinkSync(outsideRoot, path.join(root, 'client/safe.js.br'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(err?.code)) throw err;
      symlinkAvailable = false;
    }
    if (symlinkAvailable) {
      const escaped = await invokeStatic(root, '/client/escape/secret.js');
      assert.strictEqual(escaped.status, 403, 'ordinary static symlinks must not escape the canonical root');

      const compressed = await invokeStatic(root, '/client/safe.js', { 'accept-encoding': 'br' });
      assert.strictEqual(compressed.status, 200);
      assert.strictEqual(compressed.body, 'window.safe=true;');
      assert.strictEqual(compressed.headers['Content-Encoding'], undefined, 'unsafe compressed variants must fall back to the safe source');

      fs.writeFileSync(indexPath, '<template id="chatuiAssetManifest"><script src="./client/escape/secret.js"></script></template>');
      staticBundle.clearBundleMetadataCaches();
      assert.throws(
        () => staticBundle.bundleMetadata(root, rootWithSep, 'js'),
        err => err.code === 'STATIC_PATH_OUTSIDE_ROOT',
        'bundle manifest assets must not follow symlinks outside the canonical root'
      );
    }
  } finally {
    fs.readFileSync = originalRead;
    staticBundle.clearBundleMetadataCaches();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }

  assert.strictEqual(xlsx.safeXml(`a\u0001b`), 'ab');
  const users = Object.create(null);
  users.__proto__ = [{ username: `${'u'.repeat(33000)}\u0001`, total_tokens: 1 }];
  users.toString = [{ username: 'safe', total_tokens: 2 }];
  const workbook = await xlsx.buildDepartmentExportWorkbook('今日', [
    { department_id: '__proto__', department_name: 'Team', total_tokens: 1 },
    { department_id: 'toString', department_name: 'team', total_tokens: 2 },
  ], users, {});
  const archive = await JSZip.loadAsync(workbook);
  const workbookXml = await archive.file('xl/workbook.xml').async('string');
  const names = [...workbookXml.matchAll(/<sheet name="([^"]+)"/g)].map(match => match[1].toLowerCase());
  assert.strictEqual(new Set(names).size, names.length, 'sheet names must be unique case-insensitively');
  const userSheet = await archive.file('xl/worksheets/sheet2.xml').async('string');
  assert.ok(!userSheet.includes('\u0001'));
  assert.ok(!userSheet.includes('u'.repeat(32768)), 'XLSX cells must respect Excel text limits');
  assert.strictEqual(Object.getPrototypeOf(usageService.groupUsersByDepartment([{ department_id: '__proto__', username: 'safe' }])), null);

  const oversizedOffice = new JSZip();
  for (let index = 0; index <= extractUtils.MAX_OFFICE_ARCHIVE_ENTRIES; index += 1) oversizedOffice.file(`f${index}.txt`, '');
  const officeBuffer = await oversizedOffice.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await assert.rejects(extractUtils.assertOfficeArchiveSafe(officeBuffer, 'bomb.docx'), err => err.code === 'OFFICE_ARCHIVE_TOO_LARGE');
  assert.throws(() => extractUtils.dataUrlToBuffer('data:application/octet-stream;base64,%%%'), err => err.code === 'INVALID_ATTACHMENT_ENCODING');
  assert.strictEqual(await extractUtils.commandExists('node; exit 0'), false, 'executable lookup must reject shell syntax');
}

module.exports = [
  testServerAuditNumericAndPostgresConfigurationFailsClosed,
  testServerAuditCorsAndMalformedRoutesOverRealHttp,
  testServerAuditUsageAuthorizationNeverLeaksUntrustedKeys,
  testServerAuditJobCapacityAbortAndSseBackpressure,
  testServerAuditQueuedDirectProxyDisconnectSkipsUpstream,
  testServerAuditStaticXlsxAndArchiveBounds,
];
