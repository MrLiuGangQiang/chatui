'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const {
  createRequestTraceLogger,
  requestKind,
  summarizeResponsePayload,
} = require('../../server/logging/request-trace');
const { createOpenAiProxy } = require('../../server/proxy/openai');
const { runImageJob } = require('../../server/jobs/image');

function withTempTrace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-request-trace-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readTrace(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function testRequestTracePersistsCorrelatedRouteEvidenceWithoutCredentialsOrBinary() {
  withTempTrace(root => {
    const file = path.join(root, 'request-trace.ndjson');
    const apiKey = 'sk-live-secret-value-123456789';
    const logger = createRequestTraceLogger({ enabled: true, root, filePath: file, onError: error => { throw error; } });
    const span = logger.begin({
      source: 'proxy',
      target: `https://user:password@example.com/v1/chat/completions?api_key=${apiKey}`,
      targetPath: '/chat/completions',
      payload: {
        model: 'route-model',
        response_format: { type: 'json_schema', json_schema: { name: 'chatui_pending_continuation_v6', strict: true } },
        messages: [
          { role: 'system', content: 'private classifier system prompt' },
          { role: 'user', content: `{"current_input":"有几个颜色","credential":"${apiKey}","image":"data:image/png;base64,${'A'.repeat(5000)}"}` },
        ],
      },
      headerNames: ['X-Trace-Id'],
      secrets: [apiKey],
    });
    logger.complete(span, {
      status: 200,
      response: {
        choices: [{
          message: {
            content: '{"relation":"pending_assistance","assistant_reply":"共有 8 种颜色"}',
            reasoning_content: 'never persist private reasoning',
          },
        }],
      },
    });

    const events = readTrace(file);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].event, 'request.started');
    assert.strictEqual(events[1].event, 'request.completed');
    assert.strictEqual(events[0].trace_id, events[1].trace_id);
    assert.strictEqual(events[0].kind, 'pending_continuation');
    assert.strictEqual(events[0].target, 'https://example.com/v1/chat/completions');
    assert.deepStrictEqual(events[0].header_names, ['X-Trace-Id']);
    assert.match(events[0].request.messages.items[1].content.text, /有几个颜色/);
    assert.match(events[1].response.choices[0].message.content.text, /共有 8 种颜色/);
    assert.deepStrictEqual(events[1].response.choices[0].message.reasoning, {
      present: true, chars: 'never persist private reasoning'.length, omitted: true,
    });

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(apiKey));
    assert.ok(!raw.includes('password@example.com'));
    assert.ok(!raw.includes('private classifier system prompt'));
    assert.ok(!raw.includes('never persist private reasoning'));
    assert.ok(!raw.includes('data:image/png;base64'));
    assert.ok(!raw.includes('A'.repeat(1000)));
  });
}

function testDisabledRequestTraceDoesNotCreateAFile() {
  withTempTrace(root => {
    const file = path.join(root, 'disabled.ndjson');
    const logger = createRequestTraceLogger({ enabled: false, root, filePath: file });
    const span = logger.begin({ target: 'https://example.com/v1/chat/completions', payload: { model: 'test' } });
    assert.strictEqual(span, null);
    assert.strictEqual(logger.complete(span, { status: 200 }), false);
    assert.strictEqual(fs.existsSync(file), false);
  });
}

function testImageResponsesAreSummarizedWithoutPersistingBase64OrSignedQueries() {
  const base64 = `iVBOR${'A'.repeat(6000)}`;
  const summary = summarizeResponsePayload({
    data: [
      { b64_json: base64, revised_prompt: '一只橘色猫' },
      { url: 'https://images.example.com/output/cat.png?signature=private' },
    ],
  }, { kind: 'image_generation' });

  assert.strictEqual(summary.images.count, 2);
  assert.deepStrictEqual(summary.images.items[0].image, { source: 'base64', chars: base64.length, redacted: true });
  assert.strictEqual(summary.images.items[1].image.target, 'https://images.example.com/output/cat.png');
  assert.ok(!JSON.stringify(summary).includes(base64));
  assert.ok(!JSON.stringify(summary).includes('signature=private'));
}

function testRequestKindRecognizesStructuredRouteFallbacks() {
  assert.strictEqual(requestKind('/chat/completions', {
    response_format: { type: 'json_schema', json_schema: { name: 'chatui_route_decision_v1' } },
  }), 'route_decision');
  assert.strictEqual(requestKind('/chat/completions', {
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: '只返回 pending_continuation.v6 JSON' }],
  }), 'pending_continuation');
  assert.strictEqual(requestKind('/images/generations', { model: 'gpt-image-2' }), 'image_generation');
}

function testRequestTraceRotatesBoundedLocalFiles() {
  withTempTrace(root => {
    const file = path.join(root, 'bounded.ndjson');
    const logger = createRequestTraceLogger({
      enabled: true,
      root,
      filePath: file,
      maxBytes: 500,
      rotations: 1,
      onError: error => { throw error; },
    });
    for (let index = 0; index < 6; index += 1) {
      logger.record({ event: 'test.event', index, text: 'x'.repeat(180) });
    }
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(`${file}.1`));
    assert.ok(fs.statSync(file).size <= 800, 'the active trace file must remain bounded to roughly one event');
  });
}

function createProxyResponse() {
  const response = new EventEmitter();
  response.status = 0;
  response.headers = {};
  response.chunks = [];
  response.destroyed = false;
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
  response.write = chunk => { response.chunks.push(Buffer.from(chunk)); return true; };
  response.end = chunk => { if (chunk) response.chunks.push(Buffer.from(chunk)); };
  return response;
}

async function testDirectProxyWritesRequestAndResponseTrace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-request-trace-proxy-'));
  const originalFetch = global.fetch;
  const originalAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  const apiKey = 'sk-proxy-secret-value-12345';
  try {
    const file = path.join(root, 'request-trace.ndjson');
    const logger = createRequestTraceLogger({ enabled: true, root, filePath: file, onError: error => { throw error; } });
    global.fetch = async () => ({
      status: 200,
      ok: true,
      headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
      text: async () => JSON.stringify({
        choices: [{ message: { content: '{"operation":"plain_chat","relation":"followup"}' } }],
      }),
    });
    const { proxy } = createOpenAiProxy({
      chatJobs: new Map(),
      makeChatJob: id => ({ id, status: 'running', createdAt: Date.now(), updatedAt: Date.now() }),
      notifyJob: () => {},
      updateChatJobFromStreamChunk: () => {},
      upstreamTimeoutMs: 1000,
      allowedProxyMethods: new Set(['POST']),
      allowedProxyPaths: [/^\/chat\/completions$/],
      requestTrace: logger,
    });
    const body = JSON.stringify({
      baseUrl: 'http://127.0.0.1:18765/v1',
      apiKey,
      method: 'POST',
      payload: {
        model: 'route-model',
        response_format: { type: 'json_schema', json_schema: { name: 'chatui_route_decision_v1', strict: true } },
        messages: [
          { role: 'system', content: 'route system prompt' },
          { role: 'user', content: '{"current_input":"有几个颜色"}' },
        ],
      },
    });
    const request = Readable.from([body]);
    request.url = '/api/chat/completions';
    request.method = 'POST';
    request.headers = { 'content-type': 'application/json' };
    const response = createProxyResponse();
    await proxy(request, response);

    assert.strictEqual(response.status, 200);
    const events = readTrace(file);
    assert.deepStrictEqual(events.map(event => event.event), ['request.started', 'request.completed']);
    assert.strictEqual(events[0].kind, 'route_decision');
    assert.match(events[0].request.messages.items[1].content.text, /有几个颜色/);
    assert.match(events[1].response.choices[0].message.content.text, /plain_chat/);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(apiKey));
  } finally {
    global.fetch = originalFetch;
    if (originalAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = originalAllowPrivate;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testManagedImageJobWritesPromptAndBinarySafeResultTrace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-request-trace-image-'));
  const originalFetch = global.fetch;
  const originalAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  const apiKey = 'sk-image-secret-value-12345';
  const imageBase64 = `iVBOR${'A'.repeat(6000)}`;
  try {
    const file = path.join(root, 'request-trace.ndjson');
    const logger = createRequestTraceLogger({ enabled: true, root, filePath: file, onError: error => { throw error; } });
    global.fetch = async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ data: [{ b64_json: imageBase64 }] }),
    });
    const job = {
      id: 'imgjob-trace-test',
      mode: 'image',
      status: 'running',
      targetUrl: 'http://127.0.0.1:18765/v1/images/generations',
      apiKey,
      extraHeaders: { 'X-Trace': 'private-header-value' },
      payload: { model: 'gpt-image-2', prompt: '一只橘色猫', size: '1024x1024' },
      files: [],
      masks: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      data: null,
      error: '',
    };
    await runImageJob(job, { upstreamTimeoutMs: 1000, requestTrace: logger });

    assert.strictEqual(job.status, 'done');
    const events = readTrace(file);
    assert.deepStrictEqual(events.map(event => event.event), ['request.started', 'request.completed']);
    assert.strictEqual(events[0].kind, 'image_generation');
    assert.strictEqual(events[0].request.prompt.text, '一只橘色猫');
    assert.deepStrictEqual(events[0].header_names, ['X-Trace']);
    assert.deepStrictEqual(events[1].response.images.items[0].image, {
      source: 'base64', chars: imageBase64.length, redacted: true,
    });
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(apiKey));
    assert.ok(!raw.includes('private-header-value'));
    assert.ok(!raw.includes(imageBase64));
  } finally {
    global.fetch = originalFetch;
    if (originalAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = originalAllowPrivate;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = [
  testRequestTracePersistsCorrelatedRouteEvidenceWithoutCredentialsOrBinary,
  testDisabledRequestTraceDoesNotCreateAFile,
  testImageResponsesAreSummarizedWithoutPersistingBase64OrSignedQueries,
  testRequestKindRecognizesStructuredRouteFallbacks,
  testRequestTraceRotatesBoundedLocalFiles,
  testDirectProxyWritesRequestAndResponseTrace,
  testManagedImageJobWritesPromptAndBinarySafeResultTrace,
];
