'use strict';

const dispatchContractContract = require('../../shared/dispatch-contract');
const capabilityRegistry = require('../../shared/capability-registry');

const REQUEST_PURPOSES = Object.freeze({
  INTENT_RECOGNITION: 'intent_recognition',
  FINAL_EXECUTION: 'final_execution',
});

const CHAT_TARGET_PATHS = new Set(['/chat/completions', '/responses']);
const IMAGE_GENERATION_TARGET_PATHS = new Set(['/images/generations']);
const IMAGE_EDIT_TARGET_PATHS = new Set(['/images/edits', '/openai/image_edit']);
const EXECUTION_TARGET_PATHS = new Set([
  ...CHAT_TARGET_PATHS,
  ...IMAGE_GENERATION_TARGET_PATHS,
  ...IMAGE_EDIT_TARGET_PATHS,
]);

const RESERVED_PROVIDER_PROTOCOL_FIELDS = new Set([
  'requestpurpose',
  'dispatchcontract',
  'bindingevidence',
]);

function executionProtocolError(message, code = 'EXECUTION_PROTOCOL_INVALID', statusCode = 400) {
  const error = new TypeError(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizedPurpose(value = '') {
  return String(value || '').trim();
}

function normalizedTargetPath(value = '') {
  const path = String(value || '').trim();
  if (!path) return '';
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizedProtocolFieldName(value = '') {
  return String(value || '').replace(/_/g, '').toLowerCase();
}

function assertNoEmbeddedExecutionProtocolFields(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true;
  const embedded = Object.keys(payload).find(key => RESERVED_PROVIDER_PROTOCOL_FIELDS.has(normalizedProtocolFieldName(key)));
  if (embedded) {
    throw executionProtocolError(
      `Provider payload must not include reserved ChatUI protocol field: ${embedded}`,
      'EXECUTION_PROTOCOL_FIELD_SMUGGLING',
    );
  }
  return true;
}

function hasOuterDispatchContract(body = {}) {
  return Object.prototype.hasOwnProperty.call(body, 'dispatchContract')
    && body.dispatchContract !== undefined
    && body.dispatchContract !== null;
}

function hasOuterBindingEvidence(body = {}) {
  return Object.prototype.hasOwnProperty.call(body, 'bindingEvidence')
    && body.bindingEvidence !== undefined
    && body.bindingEvidence !== null;
}

function assertRequestPurpose(body = {}, expected = '') {
  const actual = normalizedPurpose(body.requestPurpose);
  if (!actual) {
    throw executionProtocolError('requestPurpose is required', 'REQUEST_PURPOSE_REQUIRED');
  }
  if (![REQUEST_PURPOSES.INTENT_RECOGNITION, REQUEST_PURPOSES.FINAL_EXECUTION].includes(actual)) {
    throw executionProtocolError('requestPurpose is invalid', 'REQUEST_PURPOSE_INVALID');
  }
  if (expected && actual !== expected) {
    throw executionProtocolError(`requestPurpose must be ${expected}`, 'REQUEST_PURPOSE_MISMATCH');
  }
  return actual;
}

function assertIntentRecognitionRequest(body = {}, { targetPath = '', method = 'POST' } = {}) {
  const normalizedPath = normalizedTargetPath(targetPath);
  assertRequestPurpose(body, REQUEST_PURPOSES.INTENT_RECOGNITION);
  assertNoEmbeddedExecutionProtocolFields(body.payload || {});
  if (String(method || 'POST').toUpperCase() !== 'POST' || !CHAT_TARGET_PATHS.has(normalizedPath)) {
    throw executionProtocolError('Intent recognition must use a chat endpoint', 'INTENT_RECOGNITION_TARGET_INVALID');
  }
  if (hasOuterDispatchContract(body)) {
    throw executionProtocolError('Intent recognition must not include a dispatch contract', 'INTENT_RECOGNITION_PLAN_FORBIDDEN');
  }
  if (hasOuterBindingEvidence(body)) {
    const evidence = body.bindingEvidence;
    if (!Array.isArray(evidence) || evidence.length > 0) {
      throw executionProtocolError('意图识别请求不得携带资源绑定证据', 'INTENT_RECOGNITION_BINDINGS_FORBIDDEN');
    }
  }
  return Object.freeze({ requestPurpose: REQUEST_PURPOSES.INTENT_RECOGNITION, targetPath: normalizedPath });
}

function transportApiForPath(targetPath = '', fallback = '') {
  const normalizedPath = normalizedTargetPath(targetPath);
  if (normalizedPath === '/responses') return 'responses';
  if (normalizedPath === '/chat/completions') return 'chat';
  return fallback === 'responses' ? 'responses' : fallback === 'chat' ? 'chat' : '';
}

function imageModeForPath(targetPath = '', fallback = '') {
  const normalizedPath = normalizedTargetPath(targetPath);
  if (IMAGE_EDIT_TARGET_PATHS.has(normalizedPath)) return 'edit_image';
  if (IMAGE_GENERATION_TARGET_PATHS.has(normalizedPath)) return 'image';
  return fallback === 'edit_image' ? 'edit_image' : fallback === 'image' ? 'image' : '';
}

function assertFinalExecutionRequest(body = {}, {
  targetPath = '',
  method = 'POST',
  payload = body.payload || {},
  transportApi = '',
  mode = '',
  files = body.files || [],
  masks = body.masks || [],
  bindingEvidence = body.bindingEvidence || [],
} = {}) {
  assertRequestPurpose(body, REQUEST_PURPOSES.FINAL_EXECUTION);
  assertNoEmbeddedExecutionProtocolFields(payload);
  if (String(method || 'POST').toUpperCase() !== 'POST') {
    throw executionProtocolError('Final execution requests must use POST', 'FINAL_EXECUTION_METHOD_INVALID');
  }
  if (!hasOuterDispatchContract(body)) {
    throw executionProtocolError('Final execution requests require a valid dispatch_contract.v1', 'DISPATCH_CONTRACT_REQUIRED');
  }
  const candidatePlan = body.dispatchContract;
  if (candidatePlan && typeof candidatePlan === 'object'
      && capabilityRegistry.capabilityFor(candidatePlan.operation)
      && Array.isArray(candidatePlan.bindings)) {
    try {
      capabilityRegistry.assertExecutionBindings(candidatePlan.operation, candidatePlan.bindings);
    } catch {
      throw executionProtocolError(
        'Dispatch contract bindings do not satisfy the operation requirements',
        'EXECUTION_BINDING_CONTRACT_INVALID',
      );
    }
  }
  if (!dispatchContractContract.hasExactDispatchContract(candidatePlan)) {
    throw executionProtocolError('Final execution requests require a valid dispatch_contract.v1', 'DISPATCH_CONTRACT_REQUIRED');
  }

  const plan = candidatePlan;
  const normalizedPath = normalizedTargetPath(targetPath);
  const resolvedTransportApi = transportApiForPath(normalizedPath, transportApi || body.api);
  const resolvedMode = imageModeForPath(normalizedPath, mode || body.mode);

  if (resolvedTransportApi) {
    if (plan.api !== 'chat') {
      throw executionProtocolError('Dispatch contract API does not match the chat endpoint', 'DISPATCH_CONTRACT_API_MISMATCH');
    }
    if (body.api && !['chat', 'responses'].includes(body.api)) {
      throw executionProtocolError('Execution transport API is invalid', 'EXECUTION_TRANSPORT_INVALID');
    }
    if (body.api && body.api !== resolvedTransportApi) {
      throw executionProtocolError('Execution transport API does not match the endpoint', 'EXECUTION_TRANSPORT_MISMATCH');
    }
    dispatchContractContract.assertPayloadMatchesDispatchContract(plan, {
      payload,
      transportApi: resolvedTransportApi,
      bindingEvidence,
      enforceContextPolicy: true,
    });
    return Object.freeze({
      requestPurpose: REQUEST_PURPOSES.FINAL_EXECUTION,
      targetPath: normalizedPath,
      transportApi: resolvedTransportApi,
      mode: 'chat',
      dispatchContract: plan,
      bindingEvidence,
    });
  }

  if (resolvedMode) {
    const expectedPlanApi = resolvedMode === 'edit_image' ? 'image_edit' : 'image_generation';
    if (plan.api !== expectedPlanApi) {
      throw executionProtocolError('Dispatch contract API does not match the image endpoint', 'DISPATCH_CONTRACT_API_MISMATCH');
    }
    if (body.mode && body.mode !== resolvedMode) {
      throw executionProtocolError('Execution mode does not match the endpoint', 'EXECUTION_MODE_MISMATCH');
    }
    dispatchContractContract.assertPayloadMatchesDispatchContract(plan, {
      payload,
      mode: resolvedMode,
      files,
      masks,
      bindingEvidence,
    });
    return Object.freeze({
      requestPurpose: REQUEST_PURPOSES.FINAL_EXECUTION,
      targetPath: normalizedPath,
      transportApi: '',
      mode: resolvedMode,
      dispatchContract: plan,
      bindingEvidence,
    });
  }

  throw executionProtocolError('Final execution target is unsupported by the dispatch contract', 'FINAL_EXECUTION_TARGET_INVALID');
}

function validateProxyExecutionRequest(body = {}, options = {}) {
  const targetPath = normalizedTargetPath(options.targetPath);
  const method = String(options.method || body.method || 'POST').toUpperCase();
  // Only non-execution endpoints may use the metadata shortcut. Execution
  // paths must always enter the request-purpose validator, even for GET, so
  // an invalid transport cannot bypass the intent/final-execution protocol.
  if (!EXECUTION_TARGET_PATHS.has(targetPath)) {
    return Object.freeze({ requestPurpose: '', targetPath, metadataRequest: true });
  }
  const purpose = assertRequestPurpose(body);
  if (purpose === REQUEST_PURPOSES.INTENT_RECOGNITION) {
    return assertIntentRecognitionRequest(body, { targetPath, method });
  }
  return assertFinalExecutionRequest(body, { ...options, targetPath, method });
}

function validateManagedChatRequest(body = {}, { payload = body.payload || {}, transportApi = body.api || 'chat' } = {}) {
  const api = transportApi === 'responses' ? 'responses' : 'chat';
  return assertFinalExecutionRequest(body, {
    targetPath: api === 'responses' ? '/responses' : '/chat/completions',
    method: 'POST',
    payload,
    transportApi: api,
    bindingEvidence: body.bindingEvidence || [],
  });
}

function validateManagedImageRequest(body = {}, {
  payload = body.payload || {},
  mode = body.mode || 'image',
  files = body.files || [],
  masks = body.masks || [],
} = {}) {
  const normalizedMode = mode === 'edit_image' ? 'edit_image' : 'image';
  return assertFinalExecutionRequest(body, {
    targetPath: normalizedMode === 'edit_image' ? '/images/edits' : '/images/generations',
    method: 'POST',
    payload,
    mode: normalizedMode,
    files,
    masks,
    bindingEvidence: body.bindingEvidence || [],
  });
}

function sameDispatchContract(left, right) {
  return dispatchContractContract.hasExactDispatchContract(left)
    && dispatchContractContract.hasExactDispatchContract(right)
    && dispatchContractContract.stableStringify(left) === dispatchContractContract.stableStringify(right);
}

function assertJobExecutionContract(existingJob, incoming = {}) {
  if (!existingJob) return true;
  if (existingJob.requestPurpose !== REQUEST_PURPOSES.FINAL_EXECUTION
      || normalizedPurpose(incoming.requestPurpose) !== REQUEST_PURPOSES.FINAL_EXECUTION
      || !sameDispatchContract(existingJob.dispatchContract, incoming.dispatchContract)) {
    throw executionProtocolError('The existing job is bound to a different dispatch contract', 'DISPATCH_CONTRACT_JOB_CONFLICT', 409);
  }
  return true;
}

function executionContractSnapshot(body = {}, validation = {}) {
  return Object.freeze({
    requestPurpose: REQUEST_PURPOSES.FINAL_EXECUTION,
    dispatchContract: body.dispatchContract,
    bindingEvidence: Array.isArray(validation.bindingEvidence)
      ? validation.bindingEvidence.map(item => ({ ...item }))
      : [],
  });
}

module.exports = {
  REQUEST_PURPOSES,
  CHAT_TARGET_PATHS,
  IMAGE_GENERATION_TARGET_PATHS,
  IMAGE_EDIT_TARGET_PATHS,
  EXECUTION_TARGET_PATHS,
  RESERVED_PROVIDER_PROTOCOL_FIELDS,
  executionProtocolError,
  normalizedPurpose,
  assertNoEmbeddedExecutionProtocolFields,
  transportApiForPath,
  imageModeForPath,
  assertRequestPurpose,
  assertIntentRecognitionRequest,
  assertFinalExecutionRequest,
  validateProxyExecutionRequest,
  validateManagedChatRequest,
  validateManagedImageRequest,
  sameDispatchContract,
  assertJobExecutionContract,
  executionContractSnapshot,
};

