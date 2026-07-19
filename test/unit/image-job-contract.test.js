const assert = require('assert');
const { Readable } = require('stream');

const { createImageJobHandlers, prepareImageJobRequest, createImageJobFromRequestBody, buildImageUpstreamRequest, createImageJobValidationError, formatImageJobError, imageUpstreamBaseHeaders, markImageJobDone, markImageJobFailed, parseImageUpstreamResponse, resolveImageJobMode, runImageJob } = require('../../server/jobs/image');
const { publicJob } = require('../../server/jobs/common');

const PNG_1PX = 'iVBORw0KGgo=';

function createMockResponse() {
  return {
    status: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = String(body || ''); },
  };
}

function createJsonRequest(body) {
  const req = Readable.from([JSON.stringify(body || {})]);
  req.method = 'POST';
  req.url = '/api/image-jobs';
  req.headers = {};
  return req;
}

async function invokeStart(body, options = {}) {
  const imageJobs = options.imageJobs || new Map();
  const notifications = [];
  const handlers = createImageJobHandlers({
    imageJobs,
    notifyJob(job) { notifications.push({ id: job.id, status: job.status, mode: job.mode, data: job.data, error: job.error }); },
    upstreamTimeoutMs: 1000,
  });
  const res = createMockResponse();
  const previousFetch = global.fetch;
  const previousAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  const fetchCalls = [];
  global.fetch = options.fetch || ((url, request) => {
    fetchCalls.push({ url, request });
    return Promise.resolve({ ok: true, text: () => Promise.resolve('{"data":[{"url":"https://img.example/out.png"}]}') });
  });
  try {
    await handlers.startImageJob(createJsonRequest(body), res);
    await Promise.resolve();
    if (options.waitForJob) await new Promise(resolve => setImmediate(resolve));
  } finally {
    global.fetch = previousFetch;
    if (previousAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = previousAllowPrivate;
  }
  return { res, json: res.body ? JSON.parse(res.body) : null, imageJobs, notifications, fetchCalls };
}

function imageFile(overrides = {}) {
  return { name: 'source.png', type: 'image/png', data: PNG_1PX, ...overrides };
}

async function testImageJobStartGenerationContract() {
  const result = await invokeStart({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    jobId: 'imgjob-generate1',
    payload: { model: 'gpt-image-1', prompt: '画一只猫', n: 1 },
  });

  assert.strictEqual(result.res.status, 202);
  assert.strictEqual(result.json.id, 'imgjob-generate1');
  assert.strictEqual(result.json.status, 'running');
  const job = result.imageJobs.get('imgjob-generate1');
  assert.strictEqual(job.mode, 'image');
  assert.strictEqual(job.targetUrl, 'https://api.example.com/v1/images/generations');
  assert.deepStrictEqual(job.files, []);
  assert.deepStrictEqual(job.masks, []);
}

async function testImageJobAsyncCompletionContract() {
  const result = await invokeStart({
    baseUrl: 'https://api.example.com/v1',
    jobId: 'imgjob-complete1',
    payload: { model: 'gpt-image-1', prompt: '画一只猫' },
  }, { waitForJob: true });

  assert.strictEqual(result.res.status, 202);
  const job = result.imageJobs.get('imgjob-complete1');
  assert.strictEqual(job.status, 'done');
  assert.deepStrictEqual(job.data, { data: [{ url: 'https://img.example/out.png' }] });
  assert.strictEqual(typeof job.durationMs, 'number');
  assert.ok(job.durationMs >= 0);
  assert.strictEqual(job.controller, undefined);
  assert.strictEqual(result.notifications.length, 1);
  assert.deepStrictEqual(result.notifications[0], {
    id: 'imgjob-complete1',
    status: 'done',
    mode: 'image',
    data: { data: [{ url: 'https://img.example/out.png' }] },
    error: '',
  });
  assert.strictEqual(result.fetchCalls.length, 1);
  assert.strictEqual(String(result.fetchCalls[0].url), 'https://api.example.com/v1/images/generations');
}

async function testImageJobAsyncErrorContract() {
  const result = await invokeStart({
    baseUrl: 'https://api.example.com/v1',
    jobId: 'imgjob-upstreamerr1',
    payload: { model: 'gpt-image-1', prompt: '画一只猫' },
  }, {
    waitForJob: true,
    fetch: () => Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve('{"error":{"message":"quota exceeded"}}') }),
  });

  assert.strictEqual(result.res.status, 202);
  const job = result.imageJobs.get('imgjob-upstreamerr1');
  assert.strictEqual(job.status, 'error');
  assert.strictEqual(job.error, '上游请求过于频繁或额度已用尽（HTTP 429），请稍后重试或检查账户额度');
  assert.strictEqual(job.controller, undefined);
  assert.strictEqual(result.notifications.length, 1);
  assert.deepStrictEqual(result.notifications[0], {
    id: 'imgjob-upstreamerr1',
    status: 'error',
    mode: 'image',
    data: null,
    error: '上游请求过于频繁或额度已用尽（HTTP 429），请稍后重试或检查账户额度',
  });
}

async function testRunImageJobAbortContract() {
  const previousFetch = global.fetch;
  const previousAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  const notifications = [];
  const fetchCalls = [];
  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  const job = {
    id: 'imgjob-abort-direct1',
    mode: 'image',
    status: 'running',
    targetUrl: 'https://ingress.lfans.cn/v1/images/generations',
    payload: { model: 'gpt-image-1', prompt: '画猫' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    data: null,
    error: '',
  };

  global.fetch = (url, request) => {
    fetchCalls.push({ url, request });
    return Promise.reject(abortErr);
  };
  try {
    await runImageJob(job, { notifyJob: notifiedJob => notifications.push({ id: notifiedJob.id, status: notifiedJob.status, error: notifiedJob.error }), upstreamTimeoutMs: 1000 });
  } finally {
    global.fetch = previousFetch;
    if (previousAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = previousAllowPrivate;
  }

  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(String(fetchCalls[0].url), 'https://ingress.lfans.cn/v1/images/generations');
  assert.ok(fetchCalls[0].request.signal);
  assert.strictEqual(job.status, 'error');
  assert.strictEqual(job.error, '上游请求超时');
  assert.strictEqual(job.controller, undefined);
  assert.deepStrictEqual(notifications, [{ id: 'imgjob-abort-direct1', status: 'error', error: '上游请求超时' }]);
}

async function testRunImageJobAllowsMissingNotifyContract() {
  const previousFetch = global.fetch;
  const previousAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  const job = {
    id: 'imgjob-no-notify1',
    mode: 'image',
    status: 'running',
    targetUrl: 'https://ingress.lfans.cn/v1/images/generations',
    payload: { model: 'gpt-image-1', prompt: '画猫' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    data: null,
    error: '',
  };

  global.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"data":[{"url":"https://img.example/no-notify.png"}]}') });
  try {
    await runImageJob(job, { upstreamTimeoutMs: 1000 });
  } finally {
    global.fetch = previousFetch;
    if (previousAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = previousAllowPrivate;
  }

  assert.strictEqual(job.status, 'done');
  assert.deepStrictEqual(job.data, { data: [{ url: 'https://img.example/no-notify.png' }] });
  assert.strictEqual(job.controller, undefined);
}

async function testImageJobStartEditAutoModeContract() {
  const result = await invokeStart({
    baseUrl: 'https://api.example.com/v1/',
    jobId: 'imgjob-editauto1',
    payload: { model: 'gpt-image-1', prompt: '改成蓝色', images: [imageFile()] },
  });

  assert.strictEqual(result.res.status, 202);
  const job = result.imageJobs.get('imgjob-editauto1');
  assert.strictEqual(job.mode, 'edit_image');
  assert.strictEqual(job.targetUrl, 'https://api.example.com/v1/images/edits');
  assert.strictEqual(job.files.length, 1);
  assert.strictEqual(job.masks.length, 0);
  assert.strictEqual(job.payload.prompt, '改成蓝色');
}

async function testImageJobStartEditValidationContracts() {
  let result = await invokeStart({
    baseUrl: 'https://api.example.com/v1',
    jobId: 'imgjob-nofile01',
    mode: 'edit_image',
    payload: { model: 'gpt-image-1', prompt: '改一下' },
  });
  assert.strictEqual(result.res.status, 400);
  assert.deepStrictEqual(result.json, { error: { message: '图片编辑任务缺少图片附件' } });
  assert.strictEqual(result.imageJobs.has('imgjob-nofile01'), false);

  result = await invokeStart({
    baseUrl: 'https://api.example.com/v1',
    jobId: 'imgjob-maskonly',
    mode: 'edit_image',
    payload: { model: 'gpt-image-1', prompt: '改一下' },
    files: [imageFile({ field: 'mask', name: 'mask.png' })],
  });
  assert.strictEqual(result.res.status, 400);
  assert.deepStrictEqual(result.json, { error: { message: '图片编辑任务缺少图片附件' } });
  assert.strictEqual(result.imageJobs.has('imgjob-maskonly'), false);

  result = await invokeStart({
    baseUrl: 'https://api.example.com/v1',
    jobId: 'imgjob-noprompt',
    payload: { model: 'gpt-image-1', images: [imageFile()] },
  });
  assert.strictEqual(result.res.status, 400);
  assert.deepStrictEqual(result.json, { error: { message: '图片编辑任务缺少 prompt，请输入要如何修改图片' } });
  assert.strictEqual(result.imageJobs.has('imgjob-noprompt'), false);
}

async function testImageJobStartDuplicateReturnsExistingJobContract() {
  const existingJob = { id: 'imgjob-existing', status: 'done', createdAt: 1, updatedAt: 2, data: { data: [] }, error: '', durationMs: 3 };
  const fetchCalls = [];
  const result = await invokeStart({
    baseUrl: 'https://api.example.com/v1',
    jobId: 'imgjob-existing',
    payload: { prompt: '不会被使用' },
  }, { imageJobs: new Map([['imgjob-existing', existingJob]]), fetch: (...args) => { fetchCalls.push(args); throw new Error('fetch should not be called'); } });

  assert.strictEqual(result.res.status, 200);
  assert.strictEqual(result.json.id, 'imgjob-existing');
  assert.strictEqual(result.json.status, 'done');
  assert.strictEqual(result.imageJobs.get('imgjob-existing'), existingJob);
  assert.strictEqual(fetchCalls.length, 0);
}

function testImageUpstreamBaseHeadersContract() {
  assert.deepStrictEqual(imageUpstreamBaseHeaders({}), {});
  assert.deepStrictEqual(imageUpstreamBaseHeaders({ extraHeaders: { 'X-Test': '1' } }), { 'X-Test': '1' });
  assert.deepStrictEqual(imageUpstreamBaseHeaders({ apiKey: 'sk-test' }), { Authorization: 'Bearer sk-test' });
  assert.deepStrictEqual(
    imageUpstreamBaseHeaders({ extraHeaders: { Authorization: 'Bearer old', 'X-Test': '1' }, apiKey: 'sk-new' }),
    { Authorization: 'Bearer sk-new', 'X-Test': '1' }
  );
}

function testImageJobStateMutationHelpersContract() {
  const doneJob = { id: 'imgjob-done-helper', status: 'running', createdAt: 100, serverStartAt: 140, data: null, durationMs: null };
  assert.strictEqual(markImageJobDone(doneJob, { data: [] }, 250), doneJob);
  assert.strictEqual(doneJob.status, 'done');
  assert.deepStrictEqual(doneJob.data, { data: [] });
  assert.strictEqual(doneJob.durationMs, 110);

  const fallbackDurationJob = { id: 'imgjob-done-fallback', status: 'running', createdAt: 100, data: null, durationMs: null };
  markImageJobDone(fallbackDurationJob, { raw: 'ok' }, 250);
  assert.strictEqual(fallbackDurationJob.durationMs, 150);

  const failedJob = { id: 'imgjob-failed-helper', status: 'running', error: '' };
  assert.strictEqual(markImageJobFailed(failedJob, new Error('network down')), failedJob);
  assert.strictEqual(failedJob.status, 'error');
  assert.strictEqual(failedJob.error, '连接上游接口失败：Endpoint 地址不可达或网络连接被拒绝，请检查 Endpoint Base URL、端口和代理服务是否可用');
}

function testImageJobErrorFormatterContract() {
  assert.strictEqual(formatImageJobError({ name: 'AbortError', message: 'aborted' }), '上游请求超时');
  assert.strictEqual(formatImageJobError(new Error('quota exceeded')), '上游请求过于频繁或额度已用尽（HTTP 429），请稍后重试或检查账户额度');
  assert.strictEqual(formatImageJobError('network down'), '连接上游接口失败：Endpoint 地址不可达或网络连接被拒绝，请检查 Endpoint Base URL、端口和代理服务是否可用');
  assert.strictEqual(formatImageJobError({ upstreamStatus: 401, message: 'Invalid API key' }), '上游拒绝了该请求（HTTP 401）：当前 API Key 未被该 Endpoint 接受，请确认 Key 的权限、所属渠道和有效期');
  assert.strictEqual(formatImageJobError({ upstreamStatus: 403, message: 'Forbidden' }), '上游拒绝了该请求（HTTP 403）：当前 API Key 或账号没有访问此模型/图片能力的权限');
}

function testImageUpstreamResponseParserContract() {
  assert.deepStrictEqual(parseImageUpstreamResponse({ ok: true, status: 200 }, '{"data":[{"url":"https://img.example/out.png"}]}'), { data: [{ url: 'https://img.example/out.png' }] });
  assert.deepStrictEqual(parseImageUpstreamResponse({ ok: true, status: 200 }, 'not-json'), { raw: 'not-json' });
  assert.throws(
    () => parseImageUpstreamResponse({ ok: false, status: 401 }, '{"error":{"message":"Invalid API key"}}'),
    err => err.message === 'Invalid API key' && err.upstreamStatus === 401
  );
  assert.throws(
    () => parseImageUpstreamResponse({ ok: false, status: 403 }, '{"error":{"message":"Forbidden"}}'),
    err => err.message === 'Forbidden' && err.upstreamStatus === 403
  );
  assert.throws(
    () => parseImageUpstreamResponse({ ok: false, status: 400 }, '{"error":{"message":"bad image"}}'),
    err => err.message === 'bad image'
  );
  assert.throws(
    () => parseImageUpstreamResponse({ ok: false, status: 502 }, '{"message":"upstream bad"}'),
    err => err.message === 'upstream bad'
  );
  assert.throws(
    () => parseImageUpstreamResponse({ ok: false, status: 503 }, 'plain error'),
    err => err.message === 'plain error'
  );
  assert.throws(
    () => parseImageUpstreamResponse({ ok: false, status: 504 }, ''),
    err => err.message === '上游返回 504'
  );
}

function testImageJobModeResolutionContract() {
  assert.strictEqual(resolveImageJobMode({}, []), 'image');
  assert.strictEqual(resolveImageJobMode({ mode: 'edit_image' }, []), 'edit_image');
  assert.strictEqual(resolveImageJobMode({}, [imageFile()]), 'edit_image');
  assert.strictEqual(resolveImageJobMode({ mode: 'image' }, [imageFile()]), 'edit_image');
  assert.strictEqual(resolveImageJobMode({ mode: 'edit_image' }, [imageFile()]), 'edit_image');
}

function testImageJobValidationErrorContract() {
  const err = createImageJobValidationError('图片编辑任务缺少图片附件');
  assert.strictEqual(err.message, '图片编辑任务缺少图片附件');
  assert.strictEqual(err.statusCode, 400);
  assert.ok(err instanceof Error);
}

function testImageUpstreamRequestGenerationContract() {
  const request = buildImageUpstreamRequest({
    mode: 'image',
    apiKey: 'sk-test',
    extraHeaders: { 'X-Upstream': '1' },
    payload: {
      model: 'gpt-image-1',
      prompt: '画猫',
      image: imageFile(),
      images: [imageFile()],
      mask: imageFile(),
      files: [imageFile()],
    },
  });

  assert.strictEqual(request.headers.Authorization, 'Bearer sk-test');
  assert.strictEqual(request.headers['X-Upstream'], '1');
  assert.strictEqual(request.headers['Content-Type'], 'application/json');
  const body = JSON.parse(request.body);
  assert.deepStrictEqual(body, { model: 'gpt-image-1', prompt: '画猫' });
}

function countOccurrences(text, needle) {
  return String(text || '').split(needle).length - 1;
}

function testImageUpstreamRequestEditMultipartContract() {
  const request = buildImageUpstreamRequest({
    mode: 'edit_image',
    apiKey: 'sk-edit',
    extraHeaders: { 'Content-Type': 'will-be-overridden' },
    payload: {
      model: 'gpt-image-1',
      prompt: '请处理 data:image/png;base64,iVBORw0KGgo=',
      size: '1024x1024',
      n: 2,
      unknown: 'skip-me',
      images: [imageFile()],
    },
    files: [imageFile({ name: 'one.png' }), imageFile({ name: 'two.png' })],
    masks: [imageFile({ name: 'mask-a.png' }), imageFile({ name: 'mask-b.png' })],
  });

  assert.strictEqual(request.headers.Authorization, 'Bearer sk-edit');
  assert.match(request.headers['Content-Type'], /^multipart\/form-data; boundary=chatui-/);
  assert.ok(!Object.prototype.hasOwnProperty.call(request.headers, 'Content-Length'), 'undici must infer Buffer multipart length; an explicit header is rejected before dispatch');
  assert.ok(Buffer.isBuffer(request.body));
  const multipart = request.body.toString('latin1');
  assert.ok(multipart.includes('name="model"'));
  assert.ok(multipart.includes('name="prompt"'));
  assert.ok(multipart.includes('[image-data-omitted]'));
  assert.ok(!multipart.includes('data:image/png;base64'));
  assert.ok(!multipart.includes('name="n"'));
  assert.ok(!multipart.includes('name="unknown"'));
  assert.ok(!multipart.includes('skip-me'));
  assert.strictEqual(countOccurrences(multipart, 'name="image[]"; filename='), 2);
  assert.strictEqual(countOccurrences(multipart, 'name="mask"; filename='), 1);
}

function testImageJobPrepareRequestHelperContracts() {
  const generation = prepareImageJobRequest({ payload: { model: 'gpt-image-1', prompt: '画猫' } });
  assert.strictEqual(generation.mode, 'image');
  assert.strictEqual(generation.payload.prompt, '画猫');
  assert.deepStrictEqual(generation.files, []);
  assert.deepStrictEqual(generation.masks, []);

  const edit = prepareImageJobRequest({
    payload: { model: 'gpt-image-1', images: [imageFile()], editInstruction: '改色' },
  });
  assert.strictEqual(edit.mode, 'edit_image');
  assert.strictEqual(edit.payload.prompt, '改色');
  assert.strictEqual(edit.files.length, 1);
  assert.strictEqual(edit.masks.length, 0);

  assert.throws(
    () => prepareImageJobRequest({ mode: 'edit_image', payload: { prompt: '改一下' } }),
    err => err.statusCode === 400 && err.message === '图片编辑任务缺少图片附件'
  );
  assert.throws(
    () => prepareImageJobRequest({ payload: { images: [imageFile()] } }),
    err => err.statusCode === 400 && err.message === '图片编辑任务缺少 prompt，请输入要如何修改图片'
  );
}

function testImageJobFactoryHelperContract() {
  const job = createImageJobFromRequestBody('imgjob-helper01', {
    payload: { model: 'gpt-image-1', prompt: '改成蓝色', images: [imageFile()] },
  }, { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-test', extraHeaders: { 'X-Test': '1' } });

  assert.strictEqual(job.id, 'imgjob-helper01');
  assert.strictEqual(job.status, 'running');
  assert.strictEqual(job.mode, 'edit_image');
  assert.strictEqual(job.targetUrl, 'https://api.example.com/v1/images/edits');
  assert.strictEqual(job.apiKey, 'sk-test');
  assert.deepStrictEqual(job.extraHeaders, { 'X-Test': '1' });
  assert.strictEqual(job.files.length, 1);
  assert.deepStrictEqual(job.masks, []);
  assert.strictEqual(job.data, null);
  assert.strictEqual(job.error, '');
  assert.strictEqual(job.durationMs, null);
}

async function testImageJobInvalidBase64Contract() {
  const result = await invokeStart({
    baseUrl: 'https://api.example.com/v1',
    jobId: 'imgjob-invalid1',
    payload: { model: 'gpt-image-1', prompt: '改一下', images: [imageFile({ data: 'abcde' })] },
  });

  assert.strictEqual(result.res.status, 400);
  assert.deepStrictEqual(result.json, { error: { message: '图片附件数据无效，请重新上传图片' } });
  assert.strictEqual(result.imageJobs.has('imgjob-invalid1'), false);
}

function testImageJobPublicSnapshotContract() {
  const snapshot = publicJob({
    id: 'imgjob-public1',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    targetUrl: 'https://ingress.lfans.cn/v1/images/generations',
    apiKey: 'sk-secret',
    extraHeaders: { Authorization: 'x' },
    payload: { prompt: 'secret' },
    files: [imageFile()],
    masks: [imageFile()],
    controller: { abort() {} },
    data: { data: [] },
    error: '',
    firstTokenMs: 10,
    durationMs: 20,
  });

  assert.deepStrictEqual(snapshot, {
    id: 'imgjob-public1',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    data: { data: [] },
    metrics: { firstTokenMs: 10, durationMs: 20 },
    error: null,
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot, 'payload'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot, 'apiKey'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot, 'targetUrl'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot, 'files'), false);
  assert.deepStrictEqual(publicJob({ id: 'imgjob-error1', status: 'error', createdAt: 1, updatedAt: 2, error: '失败' }).error, { message: '失败' });
}

module.exports = [
  testImageUpstreamBaseHeadersContract,
  testImageJobStateMutationHelpersContract,
  testImageJobErrorFormatterContract,
  testImageUpstreamResponseParserContract,
  testImageJobModeResolutionContract,
  testImageJobValidationErrorContract,
  testImageUpstreamRequestGenerationContract,
  testImageUpstreamRequestEditMultipartContract,
  testImageJobPrepareRequestHelperContracts,
  testImageJobFactoryHelperContract,
  testImageJobStartGenerationContract,
  testImageJobAsyncCompletionContract,
  testImageJobAsyncErrorContract,
  testRunImageJobAbortContract,
  testRunImageJobAllowsMissingNotifyContract,
  testImageJobStartEditAutoModeContract,
  testImageJobStartEditValidationContracts,
  testImageJobStartDuplicateReturnsExistingJobContract,
  testImageJobInvalidBase64Contract,
  testImageJobPublicSnapshotContract,
];
