const assert = require('assert');

const { createRuntimeConfig, RuntimeConfigError } = require('../../server/config/runtime-config');
const { createCorsPolicy, setResponseCorsHeaders } = require('../../server/http/cors');
const { sendJson } = require('../../server/http/response');
const { createRequestHandler } = require('../../server/http/request-handler');
const { makeJobId } = require('../../server/jobs/common');
const { createApp } = require('../../server/app');

function createMockResponse() {
  return {
    headers: {},
    status: 0,
    body: '',
    ended: false,
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers) { this.status = status; this.headers = { ...this.headers, ...headers }; },
    end(body = '') { this.body += String(body); this.ended = true; },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

async function withServer(options, run) {
  const { server } = createApp(options);
  const baseUrl = await listen(server);
  try {
    await run(baseUrl);
  } finally {
    await close(server);
  }
}

function testRuntimeConfigParsesStrictCorsOrigins() {
  const config = createRuntimeConfig({ CHATUI_CORS_ORIGINS: 'https://chat.example.com/, http://localhost:3000,https://chat.example.com' });
  assert.deepStrictEqual(config.corsOrigins, ['https://chat.example.com', 'http://localhost:3000']);
  assert.throws(
    () => createRuntimeConfig({ CHATUI_CORS_ORIGINS: '*,https://chat.example.com/path' }),
    error => error instanceof RuntimeConfigError
      && error.errors.every(item => item === 'CHATUI_CORS_ORIGINS must be a comma-separated list of absolute HTTP(S) origins without paths.'),
  );
}

function testResponsePolicyOverridesLegacyWildcardCorsHeaders() {
  const response = createMockResponse();
  setResponseCorsHeaders(response, createCorsPolicy({ origins: ['https://allowed.example'] }).headersFor({ headers: { origin: 'https://allowed.example' } }));
  sendJson(response, 200, { ok: true }, { 'Access-Control-Allow-Origin': '*' });
  assert.strictEqual(response.headers['Access-Control-Allow-Origin'], 'https://allowed.example');
  assert.strictEqual(response.headers['Access-Control-Allow-Methods'], 'GET,POST,DELETE,OPTIONS');
}

async function testRequestHandlerContainsAsyncFailures() {
  const errors = [];
  const handler = createRequestHandler(async () => {
    const err = new Error('database password should not be sent to the browser');
    err.code = 'DB_FAILURE';
    throw err;
  }, { onError: (...args) => errors.push(args) });
  const response = createMockResponse();
  await handler({ method: 'GET', url: '/api/test', headers: {} }, response);
  assert.strictEqual(response.status, 500);
  assert.ok(response.headers['X-Request-Id']);
  assert.deepStrictEqual(JSON.parse(response.body), { error: { message: 'Internal Server Error', code: 'INTERNAL_SERVER_ERROR' } });
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0][1].code, 'DB_FAILURE');
}

function testGeneratedJobIdsUseCryptographicUuid() {
  const ids = new Set(Array.from({ length: 12 }, () => makeJobId()));
  assert.strictEqual(ids.size, 12);
  for (const id of ids) assert.match(id, /^imgjob-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.strictEqual(makeJobId('chatjob-client-id-0001'), 'chatjob-client-id-0001');
}

async function testCorsDefaultsToSameOriginAndAllowsConfiguredOrigins() {
  await withServer({}, async baseUrl => {
    const denied = await fetch(`${baseUrl}/api/version`, { headers: { Origin: 'https://untrusted.example' } });
    assert.strictEqual(denied.status, 200);
    assert.strictEqual(denied.headers.get('access-control-allow-origin'), null);

    const preflight = await fetch(`${baseUrl}/api/version`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'GET' },
    });
    assert.strictEqual(preflight.status, 403);
    assert.deepStrictEqual(await preflight.json(), { error: { message: 'CORS origin is not allowed', code: 'CORS_ORIGIN_DENIED' } });
  });

  await withServer({ corsOrigins: ['https://allowed.example'] }, async baseUrl => {
    const allowed = await fetch(`${baseUrl}/api/version`, { headers: { Origin: 'https://allowed.example' } });
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.strictEqual(allowed.headers.get('vary'), 'Origin');

    const preflight = await fetch(`${baseUrl}/api/version`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://allowed.example', 'Access-Control-Request-Method': 'GET' },
    });
    assert.strictEqual(preflight.status, 204);
    assert.strictEqual(preflight.headers.get('access-control-allow-origin'), 'https://allowed.example');
  });
}

module.exports = [
  testRuntimeConfigParsesStrictCorsOrigins,
  testResponsePolicyOverridesLegacyWildcardCorsHeaders,
  testRequestHandlerContainsAsyncFailures,
  testGeneratedJobIdsUseCryptographicUuid,
  testCorsDefaultsToSameOriginAndAllowsConfiguredOrigins,
];
