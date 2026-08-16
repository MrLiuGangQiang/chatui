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
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

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
      target: `https://user:password@example.com/v1/responses?api_key=${apiKey}`,
      targetPath: '/responses',
      payload: {
        model: 'route-model',
        text: { format: { type: 'json_schema', name: 'chatui_route_intent_v2', strict: true, schema: { type: 'object' } } },
        input: [
          { role: 'system', content: 'private route intent system prompt' },
          { role: 'user', content: `{"current_input":"有几个颜色","credential":"${apiKey}","image":"data:image/png;base64,${'A'.repeat(5000)}"}` },
        ],
      },
      headerNames: ['X-Trace-Id'],
      secrets: [apiKey],
    });
    logger.complete(span, {
      status: 200,
      response: {
        output_text: '{"operation":"plain_chat","relation":"followup","goal":"统计颜色数量","task_shape":"single","resource_refs":[]}',
        usage: { input_tokens: 12, output_tokens: 8 },
      },
    });

    const events = readTrace(file);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].event, 'request.started');
    assert.strictEqual(events[1].event, 'request.completed');
    assert.strictEqual(events[0].trace_id, events[1].trace_id);
    assert.strictEqual(events[0].kind, 'route_intent');
    assert.strictEqual(events[0].target, 'https://example.com/v1/responses');
    assert.deepStrictEqual(events[0].header_names, ['X-Trace-Id']);
    assert.strictEqual(events[0].request.transport, 'responses');
    assert.deepStrictEqual(events[0].request.text_format, {
      type: 'json_schema', name: 'chatui_route_intent_v2', strict: true,
    });
    assert.match(events[0].request.messages.items[1].content.text, /有几个颜色/);
    assert.deepStrictEqual(JSON.parse(events[1].response.output_text.text), {
      operation: 'plain_chat', relation: 'followup', goal: '统计颜色数量', task_shape: 'single', resource_refs: [],
    });
    assert.deepStrictEqual(events[1].response.usage, {
      prompt_tokens: 12, completion_tokens: 8, total_tokens: 0,
    });

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(apiKey));
    assert.ok(!raw.includes('password@example.com'));
    assert.ok(!raw.includes('private route intent system prompt'));
    assert.ok(!raw.includes('never persist private reasoning'));
    assert.ok(!raw.includes('data:image/png;base64'));
    assert.ok(!raw.includes('A'.repeat(1000)));
  });
}

function testRequestTraceSummarizesResponsesOutputContentWithoutReasoning() {
  const intent = JSON.stringify({
    operation: 'plain_chat',
    relation: 'new',
    goal: '联苯苄唑溶液能上飞机么',
    resource_refs: [],
    task_shape: 'single',
  });
  const summary = summarizeResponsePayload({
    id: 'resp-output-content',
    model: 'gpt-5.6-luna',
    output: [
      {
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'private chain of thought must not be logged' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: intent }],
      },
    ],
  }, { kind: 'route_intent', includeText: true });

  assert.strictEqual(summary.output_text.text, intent,
    'a standard Responses output envelope must retain the final route JSON in the trace');
  assert.ok(!summary.output_text.text.includes('private chain of thought'));
}

function testRequestTraceDerivesElapsedDurationWhenNoExplicitDurationIsProvided() {
  withTempTrace(root => {
    const file = path.join(root, 'duration.ndjson');
    const logger = createRequestTraceLogger({ enabled: true, root, filePath: file });
    const span = logger.begin({
      target: 'https://example.com/v1/responses',
      targetPath: '/responses',
      payload: { model: 'route-model', input: [] },
      kind: 'route_intent',
    });
    span.startedAt = Date.now() - 25;
    logger.complete(span, { status: 200, response: {} });
    const events = readTrace(file);
    assert.ok(events[1].duration_ms >= 20, `derived duration must reflect elapsed time, got ${events[1].duration_ms}`);
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

function testRequestKindRecognizesStructuredRouteIntentFallbacks() {
  assert.strictEqual(requestKind('/responses', {
    text: { format: { type: 'json_schema', name: 'chatui_route_intent_v2' } },
  }), 'route_intent');
  assert.strictEqual(requestKind('/responses', {
    text: { format: { type: 'json_object' } },
    input: [{ role: 'system', content: '只返回 route_intent.v2 JSON' }],
  }), 'route_intent');
  assert.strictEqual(requestKind('/responses', {
    input: [{ role: 'user', content: '你好' }],
  }), 'chat');
  assert.strictEqual(requestKind('/chat/completions', {
    response_format: { type: 'json_schema', json_schema: { name: 'chatui_route_intent_v2' } },
  }), 'route_intent', 'historical Chat Completions trace recognition remains supported');
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
        output_text: '{"operation":"plain_chat","relation":"followup"}',
      }),
    });
    const { proxy } = createOpenAiProxy({
      chatJobs: new Map(),
      makeChatJob: id => ({ id, status: 'running', createdAt: Date.now(), updatedAt: Date.now() }),
      notifyJob: () => {},
      updateChatJobFromStreamChunk: () => {},
      upstreamTimeoutMs: 1000,
      allowedProxyMethods: new Set(['POST']),
      allowedProxyPaths: [/^\/responses$/],
      requestTrace: logger,
    });
    const body = JSON.stringify({
      baseUrl: 'http://127.0.0.1:18765/v1',
      apiKey,
      method: 'POST',
      requestPurpose: 'intent_recognition',
      submissionId: 'submit-route-trace',
      payload: {
        model: 'route-model',
        text: { format: { type: 'json_schema', name: 'chatui_route_intent_v2', strict: true, schema: { type: 'object' } } },
        input: [
          { role: 'system', content: 'route system prompt' },
          { role: 'user', content: '{"current_input":"有几个颜色","output_format":"json"}' },
        ],
      },
    });
    const request = Readable.from([body]);
    request.url = '/api/responses';
    request.method = 'POST';
    request.headers = { 'content-type': 'application/json' };
    const response = createProxyResponse();
    await proxy(request, response);

    assert.strictEqual(response.status, 200);
    const events = readTrace(file);
    assert.deepStrictEqual(events.map(event => event.event), ['request.started', 'request.completed']);
    assert.strictEqual(events[0].kind, 'route_intent');
    assert.strictEqual(events[0].submission_id, 'submit-route-trace');
    assert.strictEqual(events[1].submission_id, 'submit-route-trace');
    assert.strictEqual(events[0].request.transport, 'responses');
    assert.match(events[0].request.messages.items[1].content.text, /有几个颜色/);
    assert.match(events[1].response.output_text.text, /plain_chat/);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(apiKey));
  } finally {
    global.fetch = originalFetch;
    if (originalAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = originalAllowPrivate;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testExecutionBoundaryTraceShowsPromptAndBindingAgreementWithoutSecretsOrBinary() {
  withTempTrace(root => {
    const file = path.join(root, 'request-trace.ndjson');
    const logger = createRequestTraceLogger({ enabled: true, root, filePath: file, onError: error => { throw error; } });
    const apiKey = 'sk-execution-boundary-secret-12345';
    const prompt = '候选 2：一位成年美国女性站在纽约街头';
    const acceptedPlan = makeDispatchContract({ prompt, operation: 'text_to_image' });
    logger.executionAccepted({
      traceId: 'trace-managed-image-accepted',
      rootTraceId: 'trace-managed-image-accepted',
      source: 'managed_image_execution',
      submissionId: 'submit-choice-2',
      jobId: 'imgjob-choice-2',
      body: {
        requestPurpose: 'final_execution',
        dispatchContract: acceptedPlan,
        bindingEvidence: [],
      },
      payload: { model: 'gpt-image-2', prompt },
      mode: 'image',
      secrets: [apiKey],
      stage: 'accepted',
    });

    const editPlan = makeDispatchContract({
      prompt: '只修改目标图的天空',
      operation: 'edit_image',
      resources: [{ key: 'r1', type: 'image', role: 'target', id: 'target-1' }],
    });
    const mismatch = new TypeError('Execution binding evidence disagrees with the execution plan');
    mismatch.code = 'DISPATCH_CONTRACT_PAYLOAD_MISMATCH';
    mismatch.statusCode = 400;
    logger.executionRejected({
      traceId: 'trace-managed-image-rejected',
      rootTraceId: 'trace-managed-image-rejected',
      source: 'managed_image_execution',
      submissionId: 'submit-binding-mismatch',
      jobId: 'imgjob-binding-mismatch',
      body: {
        requestPurpose: 'final_execution',
        dispatchContract: editPlan,
        bindingEvidence: [{ key: 'r2', type: 'image', role: 'target', resource_id: 'res:image:wrong', source: 'current' }],
      },
      payload: { model: 'gpt-image-2', prompt: '只修改目标图的天空' },
      mode: 'edit_image',
      files: [{
        routeResourceKey: 'r1', routeRole: 'target', routeResourceId: 'res:image:target-1', routeSource: 'current',
        data: `data:image/png;base64,${'A'.repeat(6000)}`,
      }],
      secrets: [apiKey],
      stage: 'execution_protocol',
      error: mismatch,
    });

    const events = readTrace(file);
    assert.strictEqual(events.length, 2);
    const accepted = events[0];
    assert.strictEqual(accepted.event, 'execution.accepted');
    assert.strictEqual(accepted.submission_id, 'submit-choice-2');
    assert.strictEqual(accepted.dispatch_contract.prompt.text, prompt);
    assert.strictEqual(accepted.payload.prompt.text, prompt);
    assert.strictEqual(accepted.dispatch_contract.prompt.sha256, accepted.payload.prompt.sha256);
    assert.deepStrictEqual(accepted.checks, {
      validation_passed: true,
      plan_valid: true,
      prompt_match: true,
      binding_evidence_match: true,
      resource_binding_match: true,
    });

    const rejected = events[1];
    assert.strictEqual(rejected.event, 'execution.rejected');
    assert.strictEqual(rejected.validation_stage, 'execution_protocol');
    assert.strictEqual(rejected.error.code, 'DISPATCH_CONTRACT_PAYLOAD_MISMATCH');
    assert.strictEqual(rejected.checks.prompt_match, true);
    assert.strictEqual(rejected.checks.binding_evidence_match, false);
    assert.deepStrictEqual(rejected.binding_evidence.missing.map(item => item.key), ['r1']);
    assert.deepStrictEqual(rejected.binding_evidence.unexpected.map(item => item.key), ['r2']);
    assert.strictEqual(rejected.checks.resource_binding_match, true);

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(apiKey));
    assert.ok(!raw.includes('data:image/png;base64'));
    assert.ok(!raw.includes('A'.repeat(1000)));
  });
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
  testRequestTraceSummarizesResponsesOutputContentWithoutReasoning,
  testRequestTraceDerivesElapsedDurationWhenNoExplicitDurationIsProvided,
  testDisabledRequestTraceDoesNotCreateAFile,
  testImageResponsesAreSummarizedWithoutPersistingBase64OrSignedQueries,
  testRequestKindRecognizesStructuredRouteIntentFallbacks,
  testRequestTraceRotatesBoundedLocalFiles,
  testDirectProxyWritesRequestAndResponseTrace,
  testExecutionBoundaryTraceShowsPromptAndBindingAgreementWithoutSecretsOrBinary,
  testManagedImageJobWritesPromptAndBinarySafeResultTrace,
];
