const assert = require('assert');

const { createApp } = require('../../server/app');
const { createUsageRoutes } = require('../../server/api/routes/usage');
const { sendJson, sendMethodNotAllowed } = require('../../server/http/response');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

async function request(baseUrl, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...options });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { res, text, json };
}

async function withServer(run) {
  const { server } = createApp();
  const baseUrl = await listen(server);
  try {
    await run(baseUrl);
  } finally {
    await close(server);
  }
}

function assertCorsJson(response) {
  assert.strictEqual(response.res.headers.get('access-control-allow-origin'), '*');
  assert.match(response.res.headers.get('content-type') || '', /application\/json/);
}

function assertJson(response) {
  assert.match(response.res.headers.get('content-type') || '', /application\/json/);
}

function createMockResponse() {
  return {
    status: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = String(body || ''); },
  };
}

async function invokeUsageRoute(path, { method = 'GET', body = '', usageStats = {}, usageAccessValidator = { async validate() { return { ok: true }; } } } = {}) {
  const { routeUsage } = createUsageRoutes({ sendJson, sendMethodNotAllowed, usageStats, usageAccessValidator });
  const req = {
    url: path,
    method,
    headers: {},
    socket: { remoteAddress: 'contract-test' },
    setEncoding() {},
    on(event, fn) {
      if (event === 'data' && body) process.nextTick(() => fn(body));
      if (event === 'end') process.nextTick(fn);
      return this;
    },
  };
  const res = createMockResponse();
  await routeUsage(req, res);
  return { status: res.status, headers: res.headers, json: JSON.parse(res.body || 'null') };
}

async function testApiContractCoreEndpointsKeepShape() {
  await withServer(async baseUrl => {
    const version = await request(baseUrl, '/api/version');
    assert.strictEqual(version.res.status, 200);
    assertCorsJson(version);
    assert.deepStrictEqual(Object.keys(version.json).sort(), ['version']);
    assert.strictEqual(typeof version.json.version, 'string');

    const publicConfig = await request(baseUrl, '/api/config/public');
    assert.strictEqual(publicConfig.res.status, 200);
    assertCorsJson(publicConfig);
    assert.strictEqual(typeof publicConfig.json.version, 'string');
    assert.ok(publicConfig.json.config && typeof publicConfig.json.config === 'object');
    assert.ok(publicConfig.json.config.ui && typeof publicConfig.json.config.ui === 'object');
    assert.ok(publicConfig.json.config.features && typeof publicConfig.json.config.features === 'object');
    assert.ok(publicConfig.json.config.context && typeof publicConfig.json.config.context === 'object');
    assert.strictEqual(typeof publicConfig.json.config.context.windowTokens, 'number');
  });
}

async function testApiContractMethodAndCorsPreflight() {
  await withServer(async baseUrl => {
    const options = await request(baseUrl, '/api/version', { method: 'OPTIONS' });
    assert.strictEqual(options.res.status, 204);
    assert.strictEqual(options.res.headers.get('access-control-allow-origin'), '*');
    assert.match(options.res.headers.get('access-control-allow-methods') || '', /GET,POST,DELETE,OPTIONS/);
    assert.match(options.res.headers.get('access-control-allow-headers') || '', /Content-Type/);

    const wrongMethod = await request(baseUrl, '/api/version', { method: 'POST', body: '{}' });
    assert.strictEqual(wrongMethod.res.status, 405);
    assertJson(wrongMethod);
    assert.deepStrictEqual(wrongMethod.json, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });

    const disposedMissingJob = await request(baseUrl, '/api/chat-jobs/not-found', { method: 'DELETE' });
    assert.strictEqual(disposedMissingJob.res.status, 200);
    assertCorsJson(disposedMissingJob);
    assert.deepStrictEqual(disposedMissingJob.json, { disposed: true, existed: false });
  });
}

async function testApiContractUsageUnavailableAndValidationShapes() {
  await withServer(async baseUrl => {
    const rankings = await request(baseUrl, '/api/usage/rankings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range: 'today' }) });
    assert.strictEqual(rankings.res.status, 400);
    assertCorsJson(rankings);
    assert.deepStrictEqual(rankings.json, { error: { message: '请先配置有效的 API Key', code: 'INVALID_API_KEY' } });

    const invalidRangeWithoutDatabase = await request(baseUrl, '/api/usage/rankings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: 'sk-test', range: 'bad' }) });
    assert.strictEqual(invalidRangeWithoutDatabase.res.status, 400);
    assertCorsJson(invalidRangeWithoutDatabase);
    assert.deepStrictEqual(invalidRangeWithoutDatabase.json, { error: { message: '请先正确配置聊天模型', code: 'MODEL_NOT_CONFIGURED' } });

    const missingApiKey = await request(baseUrl, '/api/usage/personal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: 'today' }),
    });
    assert.strictEqual(missingApiKey.res.status, 400);
    assertCorsJson(missingApiKey);
    assert.deepStrictEqual(missingApiKey.json, { error: { message: '请先配置有效的 API Key', code: 'INVALID_API_KEY' } });

    const unknownUsage = await request(baseUrl, '/api/usage/not-found');
    assert.strictEqual(unknownUsage.res.status, 404);
    assertCorsJson(unknownUsage);
    assert.deepStrictEqual(unknownUsage.json, { error: { message: '未找到使用统计接口' } });
  });
}

async function testApiContractUsageConfiguredValidationShapes() {
  const invalidRankingRange = await invokeUsageRoute('/api/usage/rankings', { method: 'POST', body: JSON.stringify({ api_key: 'sk-test', model: 'gpt-test', range: 'bad' }), usageStats: { async getUserByApiKey() { return { username: 'tester' }; }, async getRanking() { return []; } } });
  assert.strictEqual(invalidRankingRange.status, 400);
  assert.strictEqual(invalidRankingRange.headers['Access-Control-Allow-Origin'], '*');
  assert.deepStrictEqual(invalidRankingRange.json, { error: { message: '不支持的排行范围' } });

  const invalidPersonalRange = await invokeUsageRoute('/api/usage/personal', {
    method: 'POST',
      body: JSON.stringify({ api_key: 'sk-test', model: 'gpt-test', range: 'bad' }),
    usageStats: { async getUserByApiKey() { return { username: 'tester' }; }, async getPersonalRange() { return null; } },
  });
  assert.strictEqual(invalidPersonalRange.status, 400);
  assert.strictEqual(invalidPersonalRange.headers['Access-Control-Allow-Origin'], '*');
  assert.deepStrictEqual(invalidPersonalRange.json, { error: { message: '不支持的统计范围' } });
}

async function testApiContractUsageCombinedEndpointsKeepCompatibility() {
  const previousPassword = process.env.USAGE_DEPARTMENT_PASSWORD;
  process.env.USAGE_DEPARTMENT_PASSWORD = 'dep-pass';
  try {
    const overview = await invokeUsageRoute('/api/usage/overview', {
      method: 'POST',
      body: JSON.stringify({ api_key: 'sk-test', model: 'gpt-test', ranking_range: 'today', personal_range: 'yesterday', compact: true }),
      usageStats: {
        async getUserByApiKey() { return { username: 'tester' }; },
        async getRanking(range) { return [{ username: `rank-${range}`, total_tokens: 10, prompt_tokens: 6, completion_tokens: 4, prompt_cached_tokens: 1, completion_reasoning_tokens: 2 }]; },
        async getPersonalRange(apiKey, range) { return { username: `${apiKey}-${range}`, total_tokens: 20, prompt_tokens: 12, completion_tokens: 8, prompt_cached_tokens: 3, completion_reasoning_tokens: 4 }; },
      },
    });
    assert.strictEqual(overview.status, 200);
    assert.deepStrictEqual(overview.json, { ok: 1, available: true, rr: 'today', pr: 'yesterday', rows: [['rank-today', 10, 6, 4, 1, 2]], personal: ['sk-test-yesterday', 20, 12, 8, 3, 4] });

    const summary = await invokeUsageRoute('/api/usage/department/summary', {
      method: 'POST',
      body: JSON.stringify({ password: 'dep-pass', api_key: 'sk-test', model: 'gpt-test', range: 'today', compact: true }),
      usageStats: {
        async getUserByApiKey() { return { username: 'tester' }; },
        async getDepartmentRanking(range) { return [{ department_id: 'dept-1', department_name: `研发-${range}`, total_tokens: 30, prompt_tokens: 18, completion_tokens: 12, prompt_cached_tokens: 5, completion_reasoning_tokens: 6 }]; },
      },
    });
    assert.strictEqual(summary.status, 200);
    assert.deepStrictEqual(summary.json, { ok: 1, available: true, authorized: true, r: 'today', rows: [['dept-1', '研发-today', 30, 18, 12, 5, 6]] });
  } finally {
    if (previousPassword === undefined) delete process.env.USAGE_DEPARTMENT_PASSWORD;
    else process.env.USAGE_DEPARTMENT_PASSWORD = previousPassword;
  }
}

async function testApiContractJobMissingAndAbortShapes() {
  await withServer(async baseUrl => {
    const missingChat = await request(baseUrl, '/api/chat-jobs/missing-job');
    assert.strictEqual(missingChat.res.status, 404);
    assertJson(missingChat);
    assert.deepStrictEqual(missingChat.json, { error: { message: '任务不存在或服务已重启' } });

    const abortMissingImage = await request(baseUrl, '/api/image-jobs/missing-job/abort', { method: 'POST' });
    assert.strictEqual(abortMissingImage.res.status, 404);
    assertJson(abortMissingImage);
    assert.deepStrictEqual(abortMissingImage.json, { error: { message: '任务不存在或服务已重启' } });

    const wrongMethod = await request(baseUrl, '/api/image-jobs/missing-job', { method: 'POST', body: '{}' });
    assert.strictEqual(wrongMethod.res.status, 405);
    assertJson(wrongMethod);
    assert.deepStrictEqual(wrongMethod.json, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
  });
}

module.exports = [
  testApiContractCoreEndpointsKeepShape,
  testApiContractMethodAndCorsPreflight,
  testApiContractUsageUnavailableAndValidationShapes,
  testApiContractUsageConfiguredValidationShapes,
  testApiContractUsageCombinedEndpointsKeepCompatibility,
  testApiContractJobMissingAndAbortShapes,
];
