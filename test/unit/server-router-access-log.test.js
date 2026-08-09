'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const { createRouter } = require('../../server/api/router');
const { send, sendJson, sendMethodNotAllowed } = require('../../server/http/response');
const { principalService } = require('../helpers/request-principal-fixture');

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
      return this;
    },
    end(body = '') { this.body += String(body || ''); },
  };
}

function createTestRouter({
  proxy = async (_req, res) => sendJson(res, 200, { ok: true }),
  serveStatic = async (_req, res) => send(res, 200, 'static'),
  accessLog = null,
  errorLog = null,
} = {}) {
  const records = [];
  const route = createRouter({
    appVersion: '1.0.0',
    buildIdentity: { version: '1.0.0', git_sha: 'abc' },
    readPublicConfig: () => ({}),
    readChangelog: () => [],
    readAnnouncements: () => [],
    send,
    sendJson,
    sendMethodNotAllowed,
    serveStatic,
    root: process.cwd(),
    rootWithSep: `${process.cwd()}\\`,
    proxy,
    proxyImage: async (_req, res) => sendJson(res, 200, { image: true }),
    imageJobs: new Map(),
    chatJobs: new Map(),
    abortJob: () => null,
    disposeJob: () => null,
    publicJob: value => value,
    subscribeJob: () => {},
    startImageJob: async (_req, res) => sendJson(res, 202, { id: 'image-job' }),
    getImageJob: async (_req, res) => sendJson(res, 404, { error: {} }),
    registerChatStreamJob: async (_req, res) => sendJson(res, 202, { id: 'chat-stream-job' }),
    startChatJob: async (_req, res) => sendJson(res, 202, { id: 'chat-job' }),
    getChatJob: async (_req, res) => sendJson(res, 404, { error: {} }),
    usageStats: {},
    usageAccessValidator: { async validate() { return { ok: true }; } },
    feedbackReviewer: { async review() { return { accepted: true }; } },
    feedbackSender: { async send() { return true; } },
    accessLog: accessLog || { log: (_req, _res, record) => records.push(record) },
    errorLog,
    requestPrincipal: principalService,
  });
  return { route, records };
}

async function testRouterLogsCoreOptionsAndStaticRoutesExactlyOnce() {
  const { route, records } = createTestRouter();
  await route({ method: 'GET', url: '/api/version', headers: {} }, response());
  await route({ method: 'OPTIONS', url: '/api/chat/completions', headers: {} }, response());
  await route({ method: 'GET', url: '/index.html', headers: {} }, response());
  assert.strictEqual(records.length, 3);
  assert.deepStrictEqual(records.map(record => record.statusCode), [200, 204, 200]);
  assert.deepStrictEqual(records.map(record => record.route), ['core', 'options', 'static']);
}

async function testRouterLogsThrownApiFailuresExactlyOnce() {
  const upstreamError = new Error('proxy failed');
  const { route, records } = createTestRouter({ proxy: async () => { throw upstreamError; } });
  await assert.rejects(
    route({ method: 'POST', url: '/api/chat/completions', headers: {} }, response()),
    error => error === upstreamError,
  );
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].route, 'proxy');
  assert.strictEqual(records[0].statusCode, 500);
}



async function testRouterRejectsInvalidUtf8AndLogsTheHttp400() {
  const { route, records } = createTestRouter();
  const req = Readable.from([Buffer.from([0xc3]), Buffer.from([0x28])]);
  req.method = 'POST';
  req.url = '/api/client-execution-trace';
  req.headers = {};
  const res = response();
  await route(req, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(JSON.parse(res.body).error.code, 'INVALID_UTF8');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].statusCode, 400);
  assert.strictEqual(records[0].route, 'core');
}

async function testRouterReportsAccessLogWriteFailureWithoutChangingResponse() {
  const errors = [];
  const res = response();
  const { route } = createTestRouter({
    accessLog: { enabled: true, log: () => false },
    errorLog: { log: (error, details) => errors.push({ error, details }) },
  });
  await route({ method: 'GET', url: '/index.html', headers: {} }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].error?.code, 'ACCESS_LOG_WRITE_FAILED');
  assert.strictEqual(errors[0].details?.source, 'access-log');
}


async function testRouterLogsImplicitResponseStatus() {
  const { route, records } = createTestRouter({
    serveStatic: async (_req, res) => {
      res.statusCode = 404;
      res.end('missing');
    },
  });
  await route({ method: 'GET', url: '/missing', headers: {} }, response());
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].statusCode, 404);
}

module.exports = [
  testRouterLogsCoreOptionsAndStaticRoutesExactlyOnce,
  testRouterLogsThrownApiFailuresExactlyOnce,
  testRouterRejectsInvalidUtf8AndLogsTheHttp400,
  testRouterReportsAccessLogWriteFailureWithoutChangingResponse,
  testRouterLogsImplicitResponseStatus,
];
