'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const { createOpenAiProxy } = require('../../server/proxy/openai');
const { attachTestPrincipal } = require('../helpers/request-principal-fixture');

function createResponse() {
  const response = new EventEmitter();
  response.status = 0;
  response.headers = {};
  response.chunks = [];
  response.ended = false;
  response.destroyed = false;
  response.writeHead = (status, headers) => {
    response.status = status;
    response.headers = headers;
    response.headersSent = true;
  };
  response.write = chunk => {
    response.chunks.push(Buffer.from(chunk));
    return true;
  };
  response.end = chunk => {
    if (chunk) response.chunks.push(Buffer.from(chunk));
    response.ended = true;
  };
  return response;
}

function createRequest(payload, path = '/api/responses') {
  const body = JSON.stringify({
    baseUrl: 'http://127.0.0.1:18765/v1',
    apiKey: 'test-route-key',
    method: 'POST',
    requestPurpose: 'intent_recognition',
    payload: { stream: false, ...(payload || {}) },
  });
  const request = attachTestPrincipal(Readable.from([body]));
  request.url = path;
  request.headers = { 'content-type': 'application/json' };
  return request;
}

function upstreamJson(status, value) {
  const text = JSON.stringify(value);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
    text: async () => text,
    body: null,
  };
}

function upstreamSse(events) {
  const text = Array.isArray(events) ? events.join('') : String(events || '');
  return {
    status: 200,
    ok: true,
    headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null },
    text: async () => text,
    body: Readable.from([text]),
  };
}

function createProxy() {
  return createOpenAiProxy({
    chatJobs: new Map(),
    makeChatJob: id => ({ id, status: 'running', createdAt: Date.now(), updatedAt: Date.now() }),
    notifyJob: () => {},
    updateChatJobFromStreamChunk: () => {},
    upstreamTimeoutMs: 1000,
    allowedProxyMethods: new Set(['POST']),
    allowedProxyPaths: [/^\/responses$/, /^\/chat\/completions$/],
  });
}

function requestRecord(options = {}) {
  return {
    payload: JSON.parse(String(options.body || '{}')),
    accept: String(options.headers?.Accept || options.headers?.accept || ''),
  };
}

async function withPrivateUpstreamAllowed(run) {
  const originalAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  try {
    await run();
  } finally {
    if (originalAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = originalAllowPrivate;
  }
}

async function testIntentResponsesRemainOneShotJsonEndToEnd() {
  const originalFetch = global.fetch;
  const calls = [];
  const upstream = { object: 'response', id: 'resp-internal', output_text: '{"operation":"plain_chat"}' };
  const expected = { output_text: '{"operation":"plain_chat"}' };
  global.fetch = async (_url, options = {}) => {
    calls.push(requestRecord(options));
    return upstreamJson(200, upstream);
  };

  try {
    await withPrivateUpstreamAllowed(async () => {
      const { proxy } = createProxy();
      const response = createResponse();
      await proxy(createRequest({ model: 'route-model', input: 'classify request' }), response);

      assert.strictEqual(calls.length, 1, 'intent recognition must make one upstream request');
      assert.strictEqual(calls[0].payload.stream, false, 'intent recognition must explicitly disable streaming');
      assert.strictEqual(calls[0].accept, '', 'intent recognition must not negotiate SSE');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.ended, true);
      assert.match(String(response.headers['Content-Type'] || ''), /^application\/json/i);
      assert.deepStrictEqual(JSON.parse(Buffer.concat(response.chunks).toString('utf8')), expected);
    });
  } finally {
    global.fetch = originalFetch;
  }
}

async function testIntentResponsesNormalizeOutputArrayForStructuredRouteParsing() {
  const originalFetch = global.fetch;
  const routeJson = '{"operation":"plain_chat","relation":"followup","goal":"那还不错","resource_refs":[],"task_shape":"single"}';
  const upstreamResponse = {
    id: 'resp-provider-only',
    object: 'response',
    model: 'route-model',
    usage: { input_tokens: 999, output_tokens: 999 },
    tools: [{ type: 'image_generation' }],
    output: [
      {
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'do not expose hidden reasoning' }],
        encrypted_content: 'do-not-forward-encrypted-reasoning',
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: routeJson }],
      },
    ],
  };
  global.fetch = async () => upstreamJson(200, upstreamResponse);

  try {
    await withPrivateUpstreamAllowed(async () => {
      const { proxy } = createProxy();
      const response = createResponse();
      await proxy(createRequest({ model: 'route-model', input: 'classify request' }), response);

      assert.strictEqual(response.status, 200);
      const forwarded = JSON.parse(Buffer.concat(response.chunks).toString('utf8'));
      assert.deepStrictEqual(forwarded, { output_text: routeJson },
        'the intent boundary must expose only the schema-constrained answer');
      assert.strictEqual(Object.hasOwn(forwarded, 'output'), false);
      assert.strictEqual(Object.hasOwn(forwarded, 'usage'), false);
      assert.strictEqual(Object.hasOwn(forwarded, 'tools'), false);
      assert.ok(!forwarded.output_text.includes('hidden reasoning'));
      assert.ok(!forwarded.output_text.includes('encrypted-reasoning'));
    });
  } finally {
    global.fetch = originalFetch;
  }
}


async function testIntentChatFallbackResponseIsReducedToOutputText() {
  const originalFetch = global.fetch;
  const routeJson = '{"operation":"plain_chat","relation":"new","goal":"hello","resource_refs":[],"task_shape":"single"}';
  const upstreamResponse = {
    id: 'chatcmpl-provider-only',
    object: 'chat.completion',
    usage: { prompt_tokens: 999, completion_tokens: 999 },
    choices: [{
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: routeJson }],
      },
    }],
  };
  global.fetch = async () => upstreamJson(200, upstreamResponse);

  try {
    await withPrivateUpstreamAllowed(async () => {
      const { proxy } = createProxy();
      const response = createResponse();
      await proxy(createRequest({ model: 'route-model', input: 'classify request' }, '/api/chat/completions'), response);

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(JSON.parse(Buffer.concat(response.chunks).toString('utf8')), { output_text: routeJson });
    });
  } finally {
    global.fetch = originalFetch;
  }
}


async function testIntentResponsesRejectSuccessfulEnvelopeWithoutOutputText() {
  const originalFetch = global.fetch;
  const upstreamResponse = {
    id: 'resp-without-output-text',
    object: 'response',
    usage: { input_tokens: 999 },
    output: [{
      type: 'reasoning',
      encrypted_content: 'must-not-leak',
    }],
  };
  global.fetch = async () => upstreamJson(200, upstreamResponse);

  try {
    await withPrivateUpstreamAllowed(async () => {
      const { proxy } = createProxy();
      const response = createResponse();
      await proxy(createRequest({ model: 'route-model', input: 'classify request' }), response);

      assert.strictEqual(response.status, 502);
      const body = Buffer.concat(response.chunks).toString('utf8');
      assert.strictEqual(JSON.parse(body).error?.code, 'INTENT_RESPONSE_OUTPUT_MISSING');
      assert.ok(!body.includes('resp-without-output-text'));
      assert.ok(!body.includes('must-not-leak'));
    });
  } finally {
    global.fetch = originalFetch;
  }
}

async function testIntentResponsesNeverRetryAsStreamAfterGatewayError() {
  const originalFetch = global.fetch;
  const calls = [];
  const upstreamFailure = { error: { code: 'internal_error', message: 'failed to do request: empty stream chunks' } };
  global.fetch = async (_url, options = {}) => {
    calls.push(requestRecord(options));
    return upstreamJson(500, upstreamFailure);
  };

  try {
    await withPrivateUpstreamAllowed(async () => {
      const { proxy } = createProxy();
      const response = createResponse();
      await proxy(createRequest({ model: 'route-model', input: 'classify request' }), response);

      assert.strictEqual(calls.length, 1, 'a route request must never be retried as SSE');
      assert.strictEqual(calls[0].payload.stream, false, 'the only upstream route request must explicitly remain non-streaming');
      assert.strictEqual(calls[0].accept, '', 'the route request must not ask for an event stream');
      assert.strictEqual(response.status, 500, 'the gateway failure must be preserved for normal route fallback handling');
      assert.deepStrictEqual(JSON.parse(Buffer.concat(response.chunks).toString('utf8')), upstreamFailure);
    });
  } finally {
    global.fetch = originalFetch;
  }
}

async function testIntentResponsesRejectUnexpectedUpstreamSseInsteadOfRelayingIt() {
  const originalFetch = global.fetch;
  const calls = [];
  const upstreamEvents = [
    'event: response.output_text.delta\n',
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '{"operation":"plain_chat"}' })}\n\n`,
    'event: response.completed\n',
    `data: ${JSON.stringify({ type: 'response.completed' })}\n\n`,
  ];
  global.fetch = async (_url, options = {}) => {
    calls.push(requestRecord(options));
    return upstreamSse(upstreamEvents);
  };

  try {
    await withPrivateUpstreamAllowed(async () => {
      const { proxy } = createProxy();
      const response = createResponse();
      await proxy(createRequest({ model: 'route-model', input: 'classify request' }), response);

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].payload.stream, false);
      assert.strictEqual(calls[0].accept, '');
      assert.strictEqual(response.status, 502, 'an intent caller must never receive an SSE response it did not request');
      assert.match(String(response.headers['Content-Type'] || ''), /^application\/json/i);
      const body = Buffer.concat(response.chunks).toString('utf8');
      assert.doesNotMatch(body, /^event:/m, 'the proxy must not relay unexpected SSE to intent recognition');
      assert.strictEqual(JSON.parse(body).error?.code, 'INTENT_RESPONSE_STREAM_UNEXPECTED');
    });
  } finally {
    global.fetch = originalFetch;
  }
}

module.exports = [
  testIntentResponsesRemainOneShotJsonEndToEnd,
  testIntentResponsesNormalizeOutputArrayForStructuredRouteParsing,
  testIntentChatFallbackResponseIsReducedToOutputText,
  testIntentResponsesRejectSuccessfulEnvelopeWithoutOutputText,
  testIntentResponsesNeverRetryAsStreamAfterGatewayError,
  testIntentResponsesRejectUnexpectedUpstreamSseInsteadOfRelayingIt,
];
