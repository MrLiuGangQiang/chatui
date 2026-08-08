'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const dispatchContract = require('../../shared/dispatch-contract');
const { makeExecutionFixture, makeDispatchContract } = require('../helpers/dispatch-contract-fixture');
const validator = require('../../server/validators/dispatch-contract.validator');
const { createOpenAiProxy } = require('../../server/proxy/openai');

function expectCode(fn, code) {
  assert.throws(fn, error => error?.code === code, `expected ${code}`);
}

function chatPayload(plan, { prompt = plan.arguments.prompt, history = [], quoted = false, images = 0, files = 0 } = {}) {
  const media = [];
  for (let index = 0; index < images; index += 1) {
    media.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${index + 1}` } });
  }
  for (let index = 0; index < files; index += 1) {
    media.push({ type: 'input_file', filename: `file-${index + 1}.txt`, file_data: `data:text/plain;base64,${index + 1}` });
  }
  const prior = history.length
    ? history
    : quoted ? [{ role: 'user', content: '<quoted_message role="user">quoted evidence</quoted_message>' }] : [];
  return {
    model: 'chat-model',
    messages: [...prior, {
      role: 'user',
      content: media.length ? [{ type: 'text', text: prompt }, ...media] : prompt,
    }],
  };
}

function finalChatBody(plan, options = {}) {
  const contract = options.contract || { executionResources: {} };
  return {
    requestPurpose: 'final_execution',
    dispatchContract: plan,
    bindingEvidence: options.bindingEvidence || dispatchContract.bindingEvidenceFromMedia(contract.executionResources),
    api: options.api || 'chat',
    payload: chatPayload(plan, options),
  };
}

function imageContract({ prompt = 'edit the image', operation = 'edit_image' } = {}) {
  return makeExecutionFixture({
    prompt,
    operation,
    resources: operation === 'edit_image'
      ? [{ key: 'r1', type: 'image', source: 'current', role: 'target', id: 'target-1', resource_id: 'res:image:target-1' }]
      : [],
  });
}

function createMockResponse() {
  const response = new EventEmitter();
  response.status = 0;
  response.headers = {};
  response.body = Buffer.alloc(0);
  response.destroyed = false;
  response.writeHead = (status, headers = {}) => { response.status = status; response.headers = headers; };
  response.write = chunk => { response.body = Buffer.concat([response.body, Buffer.from(chunk)]); return true; };
  response.end = chunk => { if (chunk) response.body = Buffer.concat([response.body, Buffer.from(chunk)]); };
  return response;
}

function createRequest(body, url = '/api/chat/completions') {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = 'POST';
  request.url = url;
  request.headers = { 'content-type': 'application/json' };
  return request;
}

async function testMissingPurposeAndInvalidPurposeAreRejected() {
  const plan = makeDispatchContract({ prompt: 'hello' });
  expectCode(() => validator.validateManagedChatRequest({ dispatchContract: plan, payload: chatPayload(plan) }), 'REQUEST_PURPOSE_REQUIRED');
  expectCode(() => validator.validateProxyExecutionRequest({ requestPurpose: 'guessing', payload: {} }, { targetPath: '/chat/completions', method: 'POST' }), 'REQUEST_PURPOSE_INVALID');
  expectCode(() => validator.validateProxyExecutionRequest({ requestPurpose: 'intent_recognition', payload: {} }, { targetPath: '/chat/completions', method: 'GET' }), 'INTENT_RECOGNITION_TARGET_INVALID');
}

async function testIntentRecognitionCannotCarryFinalContract() {
  const plan = makeDispatchContract({ prompt: 'hello' });
  expectCode(() => validator.validateProxyExecutionRequest({ requestPurpose: 'intent_recognition', dispatchContract: plan, payload: {} }, { targetPath: '/chat/completions', method: 'POST' }), 'INTENT_RECOGNITION_PLAN_FORBIDDEN');
  expectCode(() => validator.validateProxyExecutionRequest({ requestPurpose: 'intent_recognition', bindingEvidence: [{ key: 'r1' }], payload: {} }, { targetPath: '/responses', method: 'POST' }), 'INTENT_RECOGNITION_BINDINGS_FORBIDDEN');
  expectCode(() => validator.validateProxyExecutionRequest({ requestPurpose: 'intent_recognition', payload: {} }, { targetPath: '/images/generations', method: 'POST' }), 'INTENT_RECOGNITION_TARGET_INVALID');
}

async function testFinalChatRequiresExactPromptMediaAndEvidence() {
  const contract = makeExecutionFixture({
    prompt: 'describe this image',
    operation: 'image_qa',
    resources: [{ key: 'r1', type: 'image', source: 'current', role: 'source', id: 'image-1', resource_id: 'res:image:image-1' }],
  });
  const body = finalChatBody(contract.dispatchContract, { contract, images: 1 });
  assert.strictEqual(validator.validateManagedChatRequest(body).mode, 'chat');
  expectCode(() => validator.validateManagedChatRequest({ ...body, payload: chatPayload(contract.dispatchContract, { images: 1, prompt: 'different question' }) }), 'DISPATCH_CONTRACT_PAYLOAD_MISMATCH');
  expectCode(() => validator.validateManagedChatRequest({ ...body, payload: chatPayload(contract.dispatchContract), bindingEvidence: [] }), 'DISPATCH_CONTRACT_PAYLOAD_MISMATCH');
  expectCode(() => validator.validateManagedChatRequest({ ...body, payload: chatPayload(contract.dispatchContract, { images: 2 }) }), 'DISPATCH_CONTRACT_PAYLOAD_MISMATCH');
}

async function testFinalImageRequiresExactArgumentsAndRoleBindings() {
  const contract = imageContract({ prompt: 'replace the sky' });
  const file = { routeResourceKey: 'r1', routeRole: 'target', routeId: 'target-1', routeReferenceId: '', routeResourceId: 'res:image:target-1', routeSource: 'current' };
  const bindingEvidence = dispatchContract.bindingEvidenceFromMedia(contract.executionResources);
  const body = {
    requestPurpose: 'final_execution',
    mode: 'edit_image',
    dispatchContract: contract.dispatchContract,
    bindingEvidence,
    payload: { model: 'gpt-image-1', prompt: 'replace the sky' },
    files: [file],
    masks: [],
  };
  const validated = validator.validateManagedImageRequest(body, { files: [file] });
  assert.strictEqual(validated.mode, 'edit_image');
  assert.deepStrictEqual(validated.bindingEvidence, bindingEvidence);
  expectCode(() => validator.validateManagedImageRequest({ ...body, bindingEvidence: [] }, { files: [file] }), 'DISPATCH_CONTRACT_PAYLOAD_MISMATCH');
  expectCode(() => validator.validateManagedImageRequest({ ...body, payload: { ...body.payload, prompt: 'tampered' } }, { files: [file] }), 'DISPATCH_CONTRACT_PAYLOAD_MISMATCH');
  expectCode(() => validator.validateManagedImageRequest({ ...body, files: [{ ...file, routeRole: 'reference' }] }, { files: [{ ...file, routeRole: 'reference' }] }), 'DISPATCH_CONTRACT_PAYLOAD_MISMATCH');
  expectCode(() => validator.validateManagedImageRequest({ ...body, mode: 'image' }, { mode: 'image', files: [] }), 'DISPATCH_CONTRACT_API_MISMATCH');
}

async function testQuotedMessageBindingAuthorizesTextToImageWithoutMediaFiles() {
  const contract = makeExecutionFixture({
    prompt: '基于这个描述再生成一张图片。',
    operation: 'text_to_image',
    relation: 'followup',
    resources: [{
      key: 'r1', type: 'message', source: 'quoted', role: 'context',
      id: 'assistant-message-1', resource_id: 'res:message:assistant-message-1',
    }],
  });
  const bindingEvidence = dispatchContract.bindingEvidenceFromMedia(contract.executionResources);
  const body = {
    requestPurpose: 'final_execution',
    mode: 'image',
    dispatchContract: contract.dispatchContract,
    bindingEvidence,
    payload: { model: 'gpt-image-2', prompt: '基于这个描述再生成一张图片。' },
    files: [],
    masks: [],
  };
  assert.strictEqual(validator.validateManagedImageRequest(body).mode, 'image');
  expectCode(() => validator.validateManagedImageRequest({ ...body, bindingEvidence: [] }), 'DISPATCH_CONTRACT_PAYLOAD_MISMATCH');
}

async function testJobIdBindsOneImmutableDispatchContract() {
  const plan = makeDispatchContract({ prompt: 'same' });
  const different = makeDispatchContract({ prompt: 'different' });
  assert.strictEqual(validator.assertJobExecutionContract({ requestPurpose: 'final_execution', dispatchContract: plan }, { requestPurpose: 'final_execution', dispatchContract: plan }), true);
  expectCode(() => validator.assertJobExecutionContract({ requestPurpose: 'final_execution', dispatchContract: plan }, { requestPurpose: 'final_execution', dispatchContract: different }), 'DISPATCH_CONTRACT_JOB_CONFLICT');
}

function withBindings(plan, bindings) {
  const next = {
    ...plan,
    bindings: bindings.map(binding => ({ ...binding })),
    idempotency_key: '',
  };
  next.idempotency_key = dispatchContract.idempotencyKeyFor(next);
  return next;
}

async function testServerRejectsSemanticallyInvalidImageBindingCombinations() {
  const validEdit = imageContract({ prompt: 'edit it' }).dispatchContract;
  const target = validEdit.bindings[0];
  const reference = { ...target, role: 'reference' };
  const styleReference = { ...target, role: 'style_reference' };
  const invalidEditPlans = [
    withBindings(validEdit, [target, { ...target, key: 'r2', resource_id: 'res:image:target-2' }]),
    withBindings(validEdit, [reference]),
    withBindings(validEdit, [styleReference]),
  ];
  for (const plan of invalidEditPlans) {
    assert.strictEqual(dispatchContract.hasExactDispatchContract(plan), false);
    expectCode(() => validator.validateManagedImageRequest({
      requestPurpose: 'final_execution',
      mode: 'edit_image',
      dispatchContract: plan,
      bindingEvidence: plan.bindings,
      payload: { model: 'gpt-image-1', prompt: 'edit it' },
      files: [],
      masks: [],
    }), 'EXECUTION_BINDING_CONTRACT_INVALID');
  }

  const validReference = makeExecutionFixture({
    prompt: 'use this as a reference',
    operation: 'image_reference_gen',
    resources: [{
      key: 'r1', type: 'image', source: 'current', role: 'reference',
      id: 'reference-1', resource_id: 'res:image:reference-1',
    }],
  }).dispatchContract;
  const targetOnly = withBindings(validReference, [{ ...validReference.bindings[0], role: 'target' }]);
  assert.strictEqual(dispatchContract.hasExactDispatchContract(targetOnly), false);
  expectCode(() => validator.validateManagedImageRequest({
    requestPurpose: 'final_execution',
    mode: 'image',
    dispatchContract: targetOnly,
    bindingEvidence: targetOnly.bindings,
    payload: { model: 'gpt-image-1', prompt: 'use this as a reference' },
    files: [],
    masks: [],
  }), 'EXECUTION_BINDING_CONTRACT_INVALID');
}

async function testEmbeddedExecutionProtocolFieldsAreRejectedBeforeDispatch() {
  const plan = makeDispatchContract({ prompt: 'hello' });
  const finalBody = finalChatBody(plan);
  expectCode(() => validator.validateProxyExecutionRequest({
    requestPurpose: 'intent_recognition',
    payload: { model: 'route-model', dispatch_contract: { forged: true } },
  }, { targetPath: '/chat/completions', method: 'POST' }), 'EXECUTION_PROTOCOL_FIELD_SMUGGLING');
  expectCode(() => validator.validateManagedChatRequest({
    ...finalBody,
    payload: { ...finalBody.payload, requestPurpose: 'intent_recognition' },
  }), 'EXECUTION_PROTOCOL_FIELD_SMUGGLING');

  const image = makeExecutionFixture({
    prompt: 'draw a circle', operation: 'text_to_image', defaults: { size: '1024x1024', quality: 'low', count: 1 },
  });
  expectCode(() => validator.validateManagedImageRequest({
    requestPurpose: 'final_execution',
    dispatchContract: image.dispatchContract,
    mode: 'image',
    payload: {
      model: 'image-model', prompt: 'draw a circle', size: '1024x1024', quality: 'low', n: 1,
      binding_evidence: [{ forged: true }],
    },
  }), 'EXECUTION_PROTOCOL_FIELD_SMUGGLING');

  let upstreamCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    upstreamCalls += 1;
    throw new Error('upstream must not be called');
  };
  const { proxy } = createOpenAiProxy({
    chatJobs: new Map(),
    makeChatJob: id => ({ id, status: 'running' }),
    notifyJob: () => {},
    updateChatJobFromStreamChunk: () => {},
    upstreamTimeoutMs: 1000,
    allowedProxyMethods: new Set(['POST']),
    allowedProxyPaths: [/^\/chat\/completions$/],
  });
  try {
    const response = createMockResponse();
    await proxy(createRequest({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-only',
      method: 'POST',
      requestPurpose: 'final_execution',
      dispatchContract: plan,
      bindingEvidence: [],
      payload: { ...chatPayload(plan), dispatchContract: { forged: true } },
    }), response);
    assert.strictEqual(response.status, 400);
    assert.strictEqual(JSON.parse(response.body.toString('utf8')).error.code, 'EXECUTION_PROTOCOL_FIELD_SMUGGLING');
    assert.strictEqual(upstreamCalls, 0, 'smuggled protocol fields must be rejected before fetch');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testProxyNeverForwardsOuterExecutionProtocolFields() {
  const originalFetch = global.fetch;
  const originalPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  let upstreamRequest = null;
  global.fetch = async (_url, request) => {
    upstreamRequest = { ...request, body: JSON.parse(request.body) };
    return {
      status: 200,
      ok: true,
      headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'application/json' : null },
      text: async () => '{"choices":[{"message":{"content":"ok"}}]}',
    };
  };
  const plan = makeDispatchContract({ prompt: 'hello' });
  const body = {
    baseUrl: 'http://127.0.0.1:18765/v1',
    apiKey: 'sk-test-only',
    requestPurpose: 'final_execution',
    dispatchContract: plan,
    bindingEvidence: [],
    payload: chatPayload(plan),
    method: 'POST',
  };
  const { proxy } = createOpenAiProxy({
    chatJobs: new Map(),
    makeChatJob: id => ({ id, status: 'running' }),
    notifyJob: () => {},
    updateChatJobFromStreamChunk: () => {},
    upstreamTimeoutMs: 1000,
    allowedProxyMethods: new Set(['POST']),
    allowedProxyPaths: [/^\/chat\/completions$/],
  });
  try {
    const response = createMockResponse();
    await proxy(createRequest(body), response);
    assert.strictEqual(response.status, 200);
    assert.ok(upstreamRequest);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(upstreamRequest.body, 'dispatchContract'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(upstreamRequest.body, 'requestPurpose'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(upstreamRequest.body, 'bindingEvidence'), false);
    assert.strictEqual(JSON.stringify(upstreamRequest.body).includes(plan.idempotency_key), false);
  } finally {
    global.fetch = originalFetch;
    if (originalPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = originalPrivate;
  }
}

module.exports = [
  testMissingPurposeAndInvalidPurposeAreRejected,
  testIntentRecognitionCannotCarryFinalContract,
  testFinalChatRequiresExactPromptMediaAndEvidence,
  testFinalImageRequiresExactArgumentsAndRoleBindings,
  testQuotedMessageBindingAuthorizesTextToImageWithoutMediaFiles,
  testJobIdBindsOneImmutableDispatchContract,
  testServerRejectsSemanticallyInvalidImageBindingCombinations,
  testEmbeddedExecutionProtocolFieldsAreRejectedBeforeDispatch,
  testProxyNeverForwardsOuterExecutionProtocolFields,
];
