'use strict';

const assert = require('assert');
const { Readable } = require('stream');

const { createUpstreamFetch } = require('../../server/jobs/common');
const { withChatuiUserAgent, CHATUI_USER_AGENT } = require('../../server/proxy/headers');
const { createPluginService } = require('../../server/services/plugin.service');
const { createUsageAccessValidator } = require('../../server/services/usage-access.service');
const { createDingTalkFeedbackSender } = require('../../server/services/dingtalk-feedback.service');
const feedbackReview = require('../../server/services/feedback-review.service');
const { createOpenAiProxy } = require('../../server/proxy/openai');
const { createImageJobHandlers, imageUpstreamBaseHeaders } = require('../../server/jobs/image');
const { createChatJobHandlers } = require('../../server/jobs/chat');
const { readVersion } = require('../../scripts/version-source');
const { attachTestPrincipal, makeTestPrincipal } = require('../helpers/request-principal-fixture');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

function userAgentOf(headers) {
  const entry = Object.entries(headers || {}).find(([name]) => String(name).toLowerCase() === 'user-agent');
  return entry ? entry[1] : '';
}

async function withPrivateUpstreamAllowed(run) {
  const previous = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = previous;
  }
}

function stubGlobalFetch(handler) {
  const previous = global.fetch;
  global.fetch = handler;
  return async () => {
    try {
      return await Promise.resolve();
    } finally {
      global.fetch = previous;
    }
  };
}

function testUpstreamUserAgentFollowsTheVersionSourceOfTruth() {
  assert.strictEqual(CHATUI_USER_AGENT, `chatui/${readVersion()}`,
    'the User-Agent must be derived from version.json, the single version source');
}

function testWithChatuiUserAgentKeepsExistingAndAuthHeaders() {
  const withAuth = withChatuiUserAgent({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' });
  assert.strictEqual(userAgentOf(withAuth), CHATUI_USER_AGENT);
  assert.strictEqual(withAuth.Authorization, 'Bearer sk-test');
  assert.strictEqual(withAuth['Content-Type'], 'application/json');

  const custom = withChatuiUserAgent({ 'User-Agent': 'custom-agent/9' });
  assert.strictEqual(userAgentOf(custom), 'custom-agent/9', 'an explicit caller User-Agent must not be overwritten');

  const missing = withChatuiUserAgent(undefined);
  assert.strictEqual(userAgentOf(missing), CHATUI_USER_AGENT, 'a missing header map must not drop the identity');
}

async function testSharedUpstreamBoundarySendsChatuiUserAgent() {
  await withPrivateUpstreamAllowed(async () => {
    const restore = await stubGlobalFetch(async (_url, options = {}) => {
      assert.strictEqual(userAgentOf(options.headers), CHATUI_USER_AGENT,
        'every proxied upstream request must identify the ChatUI build that sent it');
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' };
    });
    const upstream = createUpstreamFetch('http://127.0.0.1:65534/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      body: '{}',
      upstreamTimeoutMs: 1000,
    });
    try {
      await upstream.response;
    } finally {
      upstream.cleanup();
      await restore();
    }
  });
}

async function testManagedChatJobUpstreamRequestSendsChatuiUserAgent() {
  const handlers = createChatJobHandlers({
    chatJobs: new Map(),
    notifyJob() {},
    upstreamTimeoutMs: 1000,
    contextWindowTokens: 128000,
    requestTrace: null,
    errorLog: null,
    idempotencyTable: null,
    providerCapabilities: null,
  });
  const job = {
    id: 'chatjob-user-agent',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    api: 'chat',
    targetPath: '/chat/completions',
    targetUrl: 'http://127.0.0.1:65534/v1/chat/completions',
    apiKey: 'sk-test',
    extraHeaders: { 'X-Trace': '1' },
    payload: { model: 'mock-model', messages: [{ role: 'user', content: 'hello' }] },
    data: {},
    error: '',
  };
  await withPrivateUpstreamAllowed(async () => {
    const restore = await stubGlobalFetch(async (_url, options = {}) => {
      assert.strictEqual(userAgentOf(options.headers), CHATUI_USER_AGENT);
      assert.strictEqual(options.headers['X-Trace'], '1', 'extra headers must survive the User-Agent injection');
      assert.strictEqual(options.headers.Authorization, 'Bearer sk-test');
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: Readable.from(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']),
      };
    });
    try {
      const created = handlers.makeChatJob(job.id, 'http://127.0.0.1:65534/v1', 'sk-test', job.payload, { api: 'chat' });
      created.targetPath = '/chat/completions';
      created.targetUrl = 'http://127.0.0.1:65534/v1/chat/completions';
      created.extraHeaders = { 'X-Trace': '1' };
      await handlers.runChatStreamJob(created);
      Object.assign(job, { status: created.status, error: created.error });
    } finally {
      await restore();
    }
  });
  assert.strictEqual(job.status, 'done', `managed chat job must complete: ${job.error || 'no error'}`);
}

async function testManagedImageJobUpstreamRequestSendsChatuiUserAgent() {
  const handlers = createImageJobHandlers({
    imageJobs: new Map(),
    notifyJob() {},
    upstreamTimeoutMs: 1000,
    requestTrace: null,
    errorLog: null,
  });
  const req = Readable.from([JSON.stringify({
    baseUrl: 'http://127.0.0.1:65534/v1',
    apiKey: 'sk-test',
    requestPurpose: 'final_execution',
    dispatchContract: makeDispatchContract({ operation: 'text_to_image', prompt: 'a cat' }),
    bindingEvidence: [],
    mode: 'image',
    payload: { model: 'mock-model', prompt: 'a cat' },
  })]);
  req.method = 'POST';
  req.url = '/api/image-jobs';
  req.headers = {};
  attachTestPrincipal(req, makeTestPrincipal());
  const res = { status: null, headers: {}, body: '', writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(body = '') { this.body = String(body || ''); } };

  await withPrivateUpstreamAllowed(async () => {
    const restore = await stubGlobalFetch(async (_url, options = {}) => {
      assert.strictEqual(userAgentOf(options.headers), CHATUI_USER_AGENT);
      assert.strictEqual(options.headers.Authorization, 'Bearer sk-test');
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"data":[{"url":"https://img.example/out.png"}]}' };
    });
    try {
      await handlers.startImageJob(req, res);
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      await restore();
    }
  });
  const started = JSON.parse(res.body);
  assert.strictEqual(started.status, 'running', `image job must be accepted: ${res.body}`);
  assert.strictEqual(userAgentOf(imageUpstreamBaseHeaders({ apiKey: 'sk-test' })), '',
    'header composition stays in the shared upstream boundary, not duplicated in the job layer');
}

async function testOpenAiProxyUpstreamRequestSendsChatuiUserAgent() {
  const { proxy } = createOpenAiProxy({
    chatJobs: new Map(),
    makeChatJob: id => ({ id, status: 'running', createdAt: Date.now(), updatedAt: Date.now() }),
    notifyJob() {},
    updateChatJobFromStreamChunk() {},
    upstreamTimeoutMs: 1000,
    allowedProxyMethods: new Set(['POST']),
    allowedProxyPaths: [/^\/chat\/completions$/],
  });
  const body = JSON.stringify({
    baseUrl: 'http://127.0.0.1:65534/v1',
    apiKey: 'sk-test',
    method: 'POST',
    requestPurpose: 'final_execution',
    dispatchContract: makeDispatchContract({ prompt: 'hello' }),
    bindingEvidence: [],
    payload: { model: 'mock-model', messages: [{ role: 'user', content: 'hello' }] },
  });
  const req = attachTestPrincipal(Readable.from([body]), makeTestPrincipal());
  req.url = '/api/chat/completions';
  req.headers = {};
  const res = {
    status: 0, headers: {}, chunks: [], ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.ended = true; },
  };

  await withPrivateUpstreamAllowed(async () => {
    const restore = await stubGlobalFetch(async (_url, options = {}) => {
      assert.strictEqual(userAgentOf(options.headers), CHATUI_USER_AGENT);
      assert.strictEqual(options.headers.Authorization, 'Bearer sk-test');
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"choices":[{"message":{"content":"hi"}}]}' };
    });
    try {
      await proxy(req, res);
    } finally {
      await restore();
    }
  });
  assert.strictEqual(res.status, 200);
}

function testPluginHttpAndMcpRequestsSendChatuiUserAgent() {
  process.env.CHATUI_TEST_PLUGIN_UA_KEY = 'plugin-secret';
  const config = {
    schema_version: 'chatui_plugins.v1',
    plugins: [{
      id: 'weather',
      type: 'http',
      label: '天气',
      enabled: true,
      baseUrl: 'https://api.example.com',
      auth: { type: 'bearer', env: 'CHATUI_TEST_PLUGIN_UA_KEY' },
      tools: [{
        name: 'get_weather', description: '查询城市天气', method: 'GET', path: '/v1/weather/{city}',
        risk: 'read', requiresApproval: false,
        inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
      }],
    }],
  };
  const seen = [];
  const service = createPluginService({
    initialConfig: config,
    assertUrl: async () => true,
    fetchImpl: async (_url, init) => {
      seen.push(init.headers);
      return new Response(JSON.stringify({ city: '上海' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return service.callTool('weather:get_weather', { city: '上海' })
    .then(() => {
      delete process.env.CHATUI_TEST_PLUGIN_UA_KEY;
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(userAgentOf(seen[0]), CHATUI_USER_AGENT, 'plugin HTTP tools must identify ChatUI upstream');
      assert.strictEqual(seen[0].Authorization, 'Bearer plugin-secret');
    })
    .catch(error => {
      delete process.env.CHATUI_TEST_PLUGIN_UA_KEY;
      throw error;
    });
}

async function testSupportServicesSendChatuiUserAgent() {
  const usageRequests = [];
  const validator = createUsageAccessValidator({
    fetchImpl: async (_url, init) => {
      usageRequests.push(init.headers);
      return { ok: true, json: async () => ({ data: [{ id: 'chat-model' }] }) };
    },
  });
  await validator.validate('sk-test', 'chat-model');
  assert.strictEqual(userAgentOf(usageRequests[0]), CHATUI_USER_AGENT, 'usage key validation must identify ChatUI upstream');

  const feedbackRequests = [];
  const reviewer = feedbackReview.createFeedbackReviewer({
    baseUrl: 'https://example.test/v1',
    fetchImpl: async (_url, init) => {
      feedbackRequests.push(init.headers);
      return {
        ok: true,
        text: async () => JSON.stringify({
          output_text: JSON.stringify({
            schema_version: feedbackReview.FEEDBACK_REVIEW_SCHEMA_VERSION,
            has_problem_description: true,
            has_reproduction_description: true,
            has_expected_result: true,
            reasonable: true,
            message: '',
          }),
        }),
      };
    },
  });
  await reviewer.review('问题描述已写\n\n复现描述已写\n\n期望结果已写', { apiKey: 'sk-test', model: 'chat-model' });
  assert.strictEqual(userAgentOf(feedbackRequests[0]), CHATUI_USER_AGENT, 'feedback review must identify ChatUI upstream');
  assert.strictEqual(feedbackRequests[0].Authorization, 'Bearer sk-test');

  const dingtalkRequests = [];
  const sender = createDingTalkFeedbackSender({
    accessToken: 'A'.repeat(32),
    fetchImpl: async (_url, init) => {
      dingtalkRequests.push(init.headers);
      return { ok: true, json: async () => ({ errcode: 0 }) };
    },
    now: () => 0,
  });
  await sender.send('问题描述\n\n复现描述\n\n期望结果');
  assert.strictEqual(userAgentOf(dingtalkRequests[0]), CHATUI_USER_AGENT, 'feedback delivery must identify ChatUI upstream');
}

module.exports = [
  testUpstreamUserAgentFollowsTheVersionSourceOfTruth,
  testWithChatuiUserAgentKeepsExistingAndAuthHeaders,
  testSharedUpstreamBoundarySendsChatuiUserAgent,
  testManagedChatJobUpstreamRequestSendsChatuiUserAgent,
  testManagedImageJobUpstreamRequestSendsChatuiUserAgent,
  testOpenAiProxyUpstreamRequestSendsChatuiUserAgent,
  testPluginHttpAndMcpRequestsSendChatuiUserAgent,
  testSupportServicesSendChatuiUserAgent,
];
