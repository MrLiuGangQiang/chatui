'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  redactString,
  redactValue,
  normalizeSecrets,
  sanitizeTarget,
  envFlag,
  positiveInteger,
  now,
  traceId,
  resolveFilePath,
  createFileWriter,
  createTraceContext,
} = require('./logger');
const dispatchContractContract = require('../../shared/dispatch-contract');
const { responseOutputText } = require('../proxy/responses-output');

const TRACE_SCHEMA_VERSION = 'request_trace.v1';
const DEFAULT_TRACE_RELATIVE_PATH = path.join('temp', 'request-trace.ndjson');
const DEFAULT_TRACE_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TRACE_ROTATIONS = 3;
const DEFAULT_TEXT_LIMIT = 16 * 1024;
const DEFAULT_MESSAGE_LIMIT = 12;
const ROUTE_MESSAGE_LIMIT = 20;
const BINARY_FIELD_RE = /^(?:b64(?:_json)?|base64|file_data|image_data|audio_data|input_audio|bytes)$/i;
const CREDENTIAL_FIELD_RE = /api[_-]?key|authorization|secret|password|cookie|set-cookie|access[_-]?token|refresh[_-]?token/i;

function requestTraceEnabled(env = process.env) {
  return envFlag(env.CHATUI_REQUEST_TRACE, false);
}

function requestTraceFullEnabled(env = process.env) {
  return envFlag(env.CHATUI_REQUEST_TRACE_FULL, false);
}

function hashText(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function traceText(value = '', { maxChars = DEFAULT_TEXT_LIMIT, secrets = [], includeText = true } = {}) {
  const original = String(value ?? '');
  let text = original;
  for (const secret of normalizeSecrets(secrets)) text = text.split(secret).join('[redacted]');
  text = redactString(text);
  const limit = positiveInteger(maxChars, DEFAULT_TEXT_LIMIT);
  const truncated = text.length > limit;
  return {
    chars: original.length,
    ...(includeText ? { text: truncated ? `${text.slice(0, limit)}…[truncated]` : text } : {}),
    truncated,
  };
}

function traceIdentityList(values = [], limit = 40) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim().slice(0, 512);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function summarizeContextProjection(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const count = (snake, camel) => {
    const number = Number(value[snake] ?? value[camel]);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  const list = (snake, camel) => traceIdentityList(value[snake] ?? value[camel]);
  return {
    input_message_count: count('input_message_count', 'inputMessageCount'),
    normalized_message_count: count('normalized_message_count', 'normalizedMessageCount'),
    selected_message_count: count('selected_message_count', 'selectedMessageCount'),
    quoted_message_count: count('quoted_message_count', 'quotedMessageCount'),
    expected_message_resource_ids: list('expected_message_resource_ids', 'expectedMessageResourceIds'),
    available_message_resource_ids: list('available_message_resource_ids', 'availableMessageResourceIds'),
    available_message_ids: list('available_message_ids', 'availableMessageIds'),
    selected_message_resource_ids: list('selected_message_resource_ids', 'selectedMessageResourceIds'),
    missing_message_resource_ids: list('missing_message_resource_ids', 'missingMessageResourceIds'),
  };
}

function summarizeSystemContent(content, options = {}) {
  let serialized;
  try { serialized = typeof content === 'string' ? content : JSON.stringify(content); }
  catch { serialized = String(content || ''); }
  if (options.includeSystemText === true) {
    return { ...traceText(serialized, options), sha256: hashText(serialized) };
  }
  return { chars: serialized.length, sha256: hashText(serialized), omitted: true };
}

function summarizeRemoteValue(value = '') {
  const text = String(value || '');
  if (!text) return { source: 'empty', chars: 0 };
  if (/^data:/i.test(text)) return { source: 'data_url', chars: text.length, redacted: true };
  if (/^[A-Za-z0-9+/=\r\n]{4096,}$/.test(text)) return { source: 'base64', chars: text.length, redacted: true };
  return { source: 'url', target: sanitizeTarget(text), chars: text.length };
}

function summarizeContentPart(part = {}, options = {}) {
  if (!part || typeof part !== 'object') return traceText(part, options);
  const type = String(part.type || 'unknown');
  if (['text', 'input_text', 'output_text'].includes(type) || Object.prototype.hasOwnProperty.call(part, 'text')) {
    return { type, ...traceText(part.text || '', options) };
  }
  if (['image_url', 'input_image', 'output_image'].includes(type) || part.image_url || part.image) {
    const source = part.image_url?.url || part.image_url || part.image || part.url || '';
    return { type, media: 'image', ...summarizeRemoteValue(source) };
  }
  if (type === 'input_file' || part.file_data) {
    return {
      type: 'input_file',
      filename: String(part.filename || part.name || ''),
      detail: String(part.detail || ''),
      fileDataChars: String(part.file_data || '').length,
      fileDataRedacted: !!part.file_data,
    };
  }
  if (type === 'input_audio' || part.audio_data) {
    return { type: 'input_audio', dataChars: String(part.audio_data || part.data || '').length, dataRedacted: true };
  }
  return { type, fields: Object.keys(part).slice(0, 20) };
}

function selectedMessages(messages = [], limit = DEFAULT_MESSAGE_LIMIT) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= limit) return { messages: list, omitted: 0 };
  const tailCount = Math.max(1, limit - (list[0]?.role === 'system' ? 1 : 0));
  const selected = list[0]?.role === 'system'
    ? [list[0], ...list.slice(-tailCount)]
    : list.slice(-limit);
  return { messages: selected, omitted: Math.max(0, list.length - selected.length) };
}

function summarizeMessages(messages = [], options = {}) {
  const limit = positiveInteger(options.messageLimit, DEFAULT_MESSAGE_LIMIT);
  const { messages: selected, omitted } = selectedMessages(messages, limit);
  const summarized = selected.map((msg, idx) => {
    if (!msg || typeof msg !== 'object') return traceText(msg, options);
    const role = String(msg.role || '');
    const isSystem = role === 'system';
    if (isSystem) {
      return { index: idx, role, content: summarizeSystemContent(msg.content, options) };
    }
    if (Array.isArray(msg.content)) {
      return {
        index: idx,
        role,
        content: msg.content.map(part => summarizeContentPart(part, options)),
        name: String(msg.name || ''),
      };
    }
    return {
      index: idx,
      role,
      content: traceText(msg.content, options),
      name: String(msg.name || ''),
    };
  });
  return { count: Array.isArray(messages) ? messages.length : 0, omitted, items: summarized };
}

function summarizeTools(tools = [], options = {}) {
  if (!Array.isArray(tools)) return { count: 0 };
  return {
    count: tools.length,
    names: tools.slice(0, 50).map(t => {
      if (!t || typeof t !== 'object') return '';
      return String(t.function?.name || t.type || '');
    }).filter(Boolean),
  };
}

function traceContractText(value = '', options = {}) {
  const original = String(value ?? '');
  return { ...traceText(original, options), sha256: hashText(original) };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => String(part?.text || part?.input_text || part?.content || '')).filter(Boolean).join('\n');
}

function lastUserPayloadText(payload = {}, transportApi = '') {
  const api = transportApi === 'responses' || Array.isArray(payload?.input) ? 'responses' : 'chat';
  const items = api === 'responses' ? payload?.input : payload?.messages;
  for (let index = (Array.isArray(items) ? items.length : 0) - 1; index >= 0; index -= 1) {
    if (items[index]?.role === 'user') return textFromContent(items[index].content).trim();
  }
  return '';
}

function normalizedComparableText(value = '') {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function summarizeBinding(binding = {}) {
  return {
    key: String(binding?.key || binding?.resource_key || ''),
    type: String(binding?.type || ''),
    role: String(binding?.role || ''),
    resource_id: String(binding?.resource_id || binding?.resourceId || ''),
    source: String(binding?.source || ''),
  };
}

function sortedBindingSummaries(bindings = []) {
  return (Array.isArray(bindings) ? bindings : [])
    .map(summarizeBinding)
    .sort((left, right) => `${left.key}\u0000${JSON.stringify(left)}`.localeCompare(`${right.key}\u0000${JSON.stringify(right)}`));
}

function bindingDiff(expected = [], actual = []) {
  const expectedItems = sortedBindingSummaries(expected);
  const actualItems = sortedBindingSummaries(actual);
  const counts = items => {
    const result = new Map();
    for (const item of items) {
      const key = JSON.stringify(item);
      result.set(key, (result.get(key) || 0) + 1);
    }
    return result;
  };
  const expectedCounts = counts(expectedItems);
  const actualCounts = counts(actualItems);
  const expandDifference = (left, right) => {
    const items = [];
    for (const [serialized, count] of left) {
      const difference = count - (right.get(serialized) || 0);
      for (let index = 0; index < difference; index += 1) items.push(JSON.parse(serialized));
    }
    return items;
  };
  return {
    match: JSON.stringify(expectedItems) === JSON.stringify(actualItems),
    expected: expectedItems,
    actual: actualItems,
    missing: expandDifference(expectedCounts, actualCounts),
    unexpected: expandDifference(actualCounts, expectedCounts),
  };
}

function suppliedImageBindings(files = [], masks = []) {
  return [
    ...(Array.isArray(files) ? files : []).map(file => ({
      key: file?.routeResourceKey || file?.key,
      type: 'image',
      role: file?.routeRole || file?.role,
      resource_id: file?.routeResourceId || file?.resource_id || file?.resourceId,
      source: file?.routeSource || file?.source,
    })),
    ...(Array.isArray(masks) ? masks : []).map(file => ({
      key: file?.routeResourceKey || file?.key,
      type: 'image',
      role: file?.routeRole || file?.role || 'mask',
      resource_id: file?.routeResourceId || file?.resource_id || file?.resourceId,
      source: file?.routeSource || file?.source,
    })),
  ];
}

function executionPayloadPrompt(payload = {}, { mode = '', transportApi = '' } = {}) {
  return mode === 'image' || mode === 'edit_image'
    ? String(payload?.prompt || '').trim()
    : lastUserPayloadText(payload, transportApi);
}

function summarizeDispatchContract(plan = null, options = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const prompt = String(plan?.arguments?.prompt || '');
  return {
    schema_version: String(plan.schema_version || ''),
    operation: String(plan.operation || ''),
    api: String(plan.api || ''),
    relation: String(plan.relation || ''),
    idempotency_key: String(plan.idempotency_key || ''),
    prompt: traceContractText(prompt, { ...options, maxChars: 4096 }),
    bindings: sortedBindingSummaries(plan.bindings),
    context_policy: plan.context_policy && typeof plan.context_policy === 'object'
      ? {
        history: String(plan.context_policy.history || ''),
        quoted: plan.context_policy.quoted === true,
        unbound_resources: String(plan.context_policy.unbound_resources || ''),
        message_resource_ids: (Array.isArray(plan.context_policy.message_resource_ids)
          ? plan.context_policy.message_resource_ids : []).map(value => String(value || '')),
      }
      : null,
  };
}

function summarizeExecutionContract({
  body = {}, payload = body?.payload || {}, mode = '', transportApi = '', files = [], masks = [],
  includeText = true, secrets = [], validationPassed = false, error = null, payloadAvailable = true,
} = {}) {
  const plan = body?.dispatchContract;
  const evidence = Array.isArray(body?.bindingEvidence) ? body.bindingEvidence : [];
  const planValid = !!dispatchContractContract.hasExactDispatchContract?.(plan);
  const planPrompt = String(plan?.arguments?.prompt || '').trim();
  const payloadPrompt = executionPayloadPrompt(payload, { mode, transportApi });
  let promptMatch = null;
  let evidenceMatch = null;
  if (planValid && payloadAvailable) {
    promptMatch = plan.api === 'chat'
      ? !!dispatchContractContract.chatPromptMatchesPlan?.(planPrompt, payloadPrompt)
      : normalizedComparableText(planPrompt) === normalizedComparableText(payloadPrompt);
  }
  if (planValid) {
    try {
      dispatchContractContract.assertBindingEvidence?.(plan, evidence);
      evidenceMatch = true;
    } catch {
      evidenceMatch = false;
    }
  }
  const expectedEvidence = planValid
    ? plan.bindings.filter(binding => binding.type !== 'text')
    : [];
  const evidenceComparison = bindingDiff(expectedEvidence, evidence);
  const expectedImageBindings = planValid
    ? plan.bindings.filter(binding => binding.type === 'image')
    : [];
  const suppliedBindings = suppliedImageBindings(files, masks);
  const suppliedComparison = bindingDiff(expectedImageBindings, suppliedBindings);
  const resolvedMode = mode === 'edit_image' ? 'edit_image' : mode === 'image' ? 'image' : '';
  const resolvedTransportApi = transportApi === 'responses' ? 'responses' : transportApi === 'chat' ? 'chat' : '';
  return {
    request_purpose: String(body?.requestPurpose || ''),
    transport: {
      mode: resolvedMode,
      api: resolvedTransportApi,
      model: String(payload?.model || ''),
    },
    dispatch_contract: summarizeDispatchContract(plan, { includeText, secrets }),
    payload: payloadAvailable ? {
      prompt: traceContractText(payloadPrompt, { includeText, secrets, maxChars: 4096 }),
      fields: payload && typeof payload === 'object' && !Array.isArray(payload)
        ? Object.keys(payload).filter(key => !CREDENTIAL_FIELD_RE.test(key))
        : [],
    } : {
      available: false,
      fields: [],
    },
    binding_evidence: {
      ...evidenceComparison,
      match: planValid ? evidenceMatch : null,
    },
    resource_bindings: resolvedMode
      ? { ...suppliedComparison, match: planValid ? suppliedComparison.match : null }
      : null,
    checks: {
      validation_passed: validationPassed === true,
      plan_valid: planValid,
      prompt_match: promptMatch,
      binding_evidence_match: evidenceMatch,
      resource_binding_match: resolvedMode && planValid ? suppliedComparison.match : null,
    },
    ...(error ? {
      error: {
        name: String(error?.name || 'Error'),
        code: String(error?.code || ''),
        status_code: Number(error?.statusCode) || 0,
        message: traceContractText(error?.message || String(error), { includeText: true, secrets, maxChars: 4096 }),
      },
    } : {}),
  };
}

function isRouteIntentRequest(payload = {}) {
  const schemaName = String(
    payload?.text?.format?.name
    || payload?.response_format?.json_schema?.name
    || '',
  );
  if (/route_intent/i.test(schemaName)) return true;
  const items = Array.isArray(payload?.input)
    ? payload.input
    : (Array.isArray(payload?.messages) ? payload.messages : []);
  return items.some(message => /route_intent\.v(?:1|2)/i.test(textFromContent(message?.content)));
}

function requestKind(targetPath = '', payload = {}, kind = '') {
  if (kind) return kind;
  const path = String(targetPath || '').split('?')[0];
  if (path === '/chat/completions' || path === '/responses') {
    return isRouteIntentRequest(payload) ? 'route_intent' : 'chat';
  }
  if (path === '/images/generations') return 'image_generation';
  if (path === '/images/edits') return 'image_edit';
  return 'api_proxy';
}

function summarizeRequestPayload(payload = {}, {
  kind = 'api_proxy',
  targetPath = '',
  includeText = true,
  includeSystemText = false,
  maxTextChars = DEFAULT_TEXT_LIMIT,
  secrets = [],
  fileCount = 0,
  maskCount = 0,
} = {}) {
  if (!payload || typeof payload !== 'object') return traceText(payload, { secrets, includeText });

  const fields = Object.keys(payload).filter(k => !CREDENTIAL_FIELD_RE.test(k));
  const model = String(payload.model || '');

  if (kind === 'route_intent' || kind === 'chat') {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const input = Array.isArray(payload.input) ? payload.input : [];
    const transport = input.length || payload.text ? 'responses' : 'chat';
    const combined = transport === 'responses' ? input : messages;
    const msgSummary = summarizeMessages(combined, {
      messageLimit: ROUTE_MESSAGE_LIMIT,
      secrets,
      includeText,
      includeSystemText,
      maxChars: maxTextChars,
    });
    const textFormat = payload.text?.format;
    return {
      model,
      transport,
      messages: msgSummary,
      tools: summarizeTools(payload.tools, { secrets, includeText }),
      stream: !!payload.stream,
      max_tokens: Number(payload.max_tokens || 0) || undefined,
      temperature: Number.isFinite(payload.temperature) ? payload.temperature : undefined,
      top_p: Number.isFinite(payload.top_p) ? payload.top_p : undefined,
      text_format: textFormat
        ? {
          type: String(textFormat.type || ''),
          name: String(textFormat.name || ''),
          strict: textFormat.strict === true,
        }
        : undefined,
      response_format: payload.response_format
        ? { type: String(payload.response_format.type || '') }
        : undefined,
      fields,
    };
  }

  if (kind === 'image_generation') {
    return {
      model,
      prompt: includeText ? traceText(payload.prompt, { secrets, maxChars: 2048 }) : { chars: String(payload.prompt || '').length },
      n: Number(payload.n || 1),
      size: String(payload.size || ''),
      quality: String(payload.quality || ''),
      style: String(payload.style || ''),
      fields,
    };
  }

  if (kind === 'image_edit') {
    const files = fileCount || 0;
    const masks = maskCount || 0;
    return {
      model,
      prompt: includeText ? traceText(payload.prompt, { secrets, maxChars: 2048 }) : { chars: String(payload.prompt || '').length },
      image_files: files,
      mask_files: masks,
      n: Number(payload.n || 1),
      size: String(payload.size || ''),
      fields,
    };
  }

  // Generic: just list fields and model
  const redacted = redactValue(payload);
  return includeText ? redacted : { model, fields };
}

function summarizeResponsePayload(response, {
  kind = 'api_proxy',
  contentType = '',
  includeText = true,
  maxTextChars = 1024,
  secrets = [],
} = {}) {
  if (!response) return null;

  // If it''s a string, try to parse or trace as text
  if (typeof response === 'string') {
    if (contentType.includes('json') || contentType.includes('javascript')) {
      try { response = JSON.parse(response); } catch { /* keep as string */ }
    }
  }

  if (typeof response === 'string') {
    return includeText ? traceText(response, { secrets, maxChars: 4096 }) : { chars: response.length };
  }

  if (typeof response !== 'object') return String(response);

  // Standard OpenAI-style response
  const fields = Object.keys(response);
  const model = String(response.model || '');

  if (kind === 'route_intent' || kind === 'chat') {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const usage = response.usage || {};
    const outputText = responseOutputText(response);
    const summarizedChoices = choices.slice(0, 4).map((choice, idx) => {
      if (!choice || typeof choice !== 'object') return traceText(choice, { secrets, includeText });
      const msg = choice.message || {};
      const content = msg.content;
      const reasoning = msg.reasoning_content || msg.reasoning;
      return {
        index: choice.index ?? idx,
        finishReason: String(choice.finish_reason || choice.finishReason || ''),
        message: {
          role: String(msg.role || ''),
          content: traceText(content, { secrets, maxChars: maxTextChars, includeText }),
          ...(reasoning ? { reasoning: { present: true, chars: String(reasoning).length, omitted: true } } : {}),
        },
      };
    });
    return {
      fields,
      id: String(response.id || ''),
      model,
      choices: summarizedChoices,
      omittedChoices: Math.max(0, choices.length - 4),
      ...(outputText ? { output_text: traceText(outputText, { secrets, maxChars: maxTextChars, includeText }) } : {}),
      usage: {
        prompt_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
        completion_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
        total_tokens: Number(usage.total_tokens || 0),
        ...(Number(usage.prompt_tokens_details?.cached_tokens || usage.input_tokens_details?.cached_tokens || usage.prompt_cached_tokens || 0)
          ? { cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens || usage.input_tokens_details?.cached_tokens || usage.prompt_cached_tokens || 0) }
          : {}),
        ...(Number(usage.completion_tokens_details?.reasoning_tokens || usage.output_tokens_details?.reasoning_tokens || usage.completion_reasoning_tokens || 0)
          ? { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens || usage.output_tokens_details?.reasoning_tokens || usage.completion_reasoning_tokens || 0) }
          : {}),
      },
      kind,
    };
  }

  if (kind === 'image_generation' || kind === 'image_edit') {
    const images = Array.isArray(response.data) ? response.data : [];
    const items = images.slice(0, 20).map(item => {
      const b64 = String(item?.b64_json || '');
      const url = String(item?.url || '');
      return {
        image: b64
          ? { source: 'base64', chars: b64.length, redacted: true }
          : { source: 'url', target: sanitizeTarget(url), chars: url.length },
      };
    });
    return {
      fields,
      model,
      images: {
        count: images.length,
        omitted: Math.max(0, images.length - items.length),
        items,
      },
      revised_prompt: includeText
        ? traceText(images[0]?.revised_prompt || '', { secrets, maxChars: 512 })
        : { chars: String(images[0]?.revised_prompt || '').length },
      kind,
    };
  }

  if (response.streamed) {
    return { fields, model, streamed: true, kind };
  }

  // Generic
  const redacted = redactValue(response);
  return includeText ? redacted : { fields, model, kind };
}

function redactTraceEvent(event = {}) {
  const redacted = { ...event };
  // Redact sensitive header names in request/response
  if (redacted.request && typeof redacted.request === 'object') {
    if (Array.isArray(redacted.request.messages)) {
      redacted.request = { ...redacted.request };
    }
  }
  return redacted;
}

function resolveTraceFile(rootPath = process.cwd()) {
  return resolveFilePath(
    process.env.CHATUI_REQUEST_TRACE_FILE || DEFAULT_TRACE_RELATIVE_PATH,
    rootPath,
  );
}

function createRequestTraceLogger({
  root = process.cwd(),
  enabled = requestTraceEnabled(),
  includeText = !envFlag(process.env.CHATUI_REQUEST_TRACE_NO_TEXT),
  fullText = requestTraceFullEnabled(),
  maxBytes = positiveInteger(process.env.CHATUI_REQUEST_TRACE_MAX_BYTES, DEFAULT_TRACE_MAX_BYTES),
  rotations = positiveInteger(process.env.CHATUI_REQUEST_TRACE_ROTATIONS, DEFAULT_TRACE_ROTATIONS),
  filePath = '',
  onError = null,
} = {}) {
  const resolvedFile = filePath ? resolveFilePath(filePath, root) : resolveTraceFile(root);
  const writer = createFileWriter(resolvedFile, { maxBytes, rotations, enabled });
  const textLimit = fullText ? Number.MAX_SAFE_INTEGER : DEFAULT_TEXT_LIMIT;

  function reportError(err) {
    if (typeof onError === 'function') onError(err);
    else console.error('[request-trace] write error:', err?.message || err);
  }

  function write(event = {}) {
    if (!enabled) return false;
    try {
      const timestampMs = Number(event.timestamp_ms) || now();
      const line = {
        schema_version: TRACE_SCHEMA_VERSION,
        timestamp: new Date(timestampMs).toISOString(),
        ...redactTraceEvent(event),
        timestamp_ms: timestampMs,
      };
      if (!writer.writeLine(line)) throw new Error('writer returned false');
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  function begin({
    source = 'proxy',
    requestId = '',
    jobId = '',
    submissionId = '',
    method = 'POST',
    target = '',
    targetPath = '',
    payload = {},
    kind = '',
    headerNames = [],
    queryKeys = [],
    fileCount = 0,
    maskCount = 0,
    secrets = [],
    // NEW: trace correlation
    parentSpan = null,
    parentTraceId = '',
    rootTraceId = '',
  } = {}) {
    if (!enabled) return null;
    const startedAt = now();
    const resolvedKind = requestKind(targetPath, payload, kind);

    // Determine trace correlation IDs
    const traceIdValue = String(requestId || traceId());
    const parentId = String(parentTraceId || parentSpan?.traceId || '');
    const rootId = String(rootTraceId || parentSpan?.rootTraceId || parentSpan?.traceId || traceIdValue);

    const span = {
      traceId: traceIdValue,
      parentTraceId: parentId || null,
      rootTraceId: rootId,
      startedAt,
      closed: false,
      kind: resolvedKind,
      secrets: normalizeSecrets(secrets),
      source: String(source || 'proxy'),
      jobId: String(jobId || ''),
      submissionId: String(submissionId || ''),
    };

    write({
      event: 'request.started',
      trace_id: span.traceId,
      parent_trace_id: span.parentTraceId || undefined,
      root_trace_id: span.rootTraceId,
      source: span.source,
      kind: resolvedKind,
      ...(span.jobId ? { job_id: span.jobId } : {}),
      ...(span.submissionId ? { submission_id: span.submissionId } : {}),
      method: String(method || 'POST').toUpperCase(),
      target: sanitizeTarget(target),
      target_path: String(targetPath || ''),
      header_names: [...new Set((Array.isArray(headerNames) ? headerNames : []).map(value => String(value || '')).filter(Boolean))],
      query_keys: [...new Set((Array.isArray(queryKeys) ? queryKeys : []).map(value => String(value || '')).filter(Boolean))],
      request: summarizeRequestPayload(payload, {
        kind: resolvedKind,
        targetPath,
        includeText,
        includeSystemText: fullText,
        maxTextChars: textLimit,
        secrets: span.secrets,
        fileCount,
        maskCount,
      }),
      timestamp_ms: startedAt,
    });
    return span;
  }

  function closeSpan(span, event, {
    status = 0,
    response = null,
    responseText = undefined,
    contentType = '',
    error = null,
    durationMs = null,
  } = {}) {
    if (!enabled || !span || span.closed) return false;
    span.closed = true;
    const finishedAt = now();
    const hasExplicitDuration = durationMs !== null && durationMs !== undefined && Number.isFinite(Number(durationMs));
    const duration = hasExplicitDuration
      ? Math.max(0, Number(durationMs))
      : Math.max(0, finishedAt - Number(span.startedAt || finishedAt));
    const details = {
      event,
      trace_id: span.traceId,
      parent_trace_id: span.parentTraceId || undefined,
      root_trace_id: span.rootTraceId,
      source: span.source,
      kind: span.kind,
      ...(span.jobId ? { job_id: span.jobId } : {}),
      ...(span.submissionId ? { submission_id: span.submissionId } : {}),
      status: Number(status) || 0,
      duration_ms: Math.round(duration),
      timestamp_ms: finishedAt,
    };
    const responseValue = responseText !== undefined ? responseText : response;
    if (responseValue !== undefined && responseValue !== null) {
      details.response = summarizeResponsePayload(responseValue, {
        kind: span.kind,
        contentType,
        includeText,
        maxTextChars: textLimit,
        secrets: span.secrets,
      });
    }
    if (error) {
      details.error = {
        name: String(error?.name || ''),
        code: String(error?.code || error?.cause?.code || ''),
        message: traceText(error?.message || String(error), { includeText: true, secrets: span.secrets, maxChars: 4096 }),
      };
    }
    return write(details);
  }

  function complete(span, details = {}) {
    return closeSpan(span, 'request.completed', details);
  }

  function fail(span, details = {}) {
    return closeSpan(span, 'request.failed', details);
  }

  function recordExecution(event, {
    traceId: eventTraceId = '', rootTraceId = '', parentTraceId = '', source = 'managed_execution',
    submissionId = '', jobId = '', body = {}, payload = body?.payload || {}, mode = '', transportApi = '',
    files = [], masks = [], secrets = [], reused = false, stage = '', error = null,
    payloadAvailable = true, contextProjection = null,
  } = {}) {
    if (!enabled) return false;
    const resolvedTraceId = String(eventTraceId || traceId());
    const contract = summarizeExecutionContract({
      body, payload, mode, transportApi, files, masks, includeText, secrets,
      validationPassed: event === 'execution.accepted', error, payloadAvailable,
    });
    return write({
      event,
      trace_id: resolvedTraceId,
      ...(parentTraceId ? { parent_trace_id: String(parentTraceId) } : {}),
      root_trace_id: String(rootTraceId || resolvedTraceId),
      source: String(source || 'managed_execution'),
      ...(submissionId ? { submission_id: String(submissionId) } : {}),
      ...(jobId ? { job_id: String(jobId) } : {}),
      ...(stage ? { validation_stage: String(stage) } : {}),
      ...(reused ? { reused: true } : {}),
      ...contract,
      ...(contextProjection ? { context_projection: summarizeContextProjection(contextProjection) } : {}),
    });
  }

  function executionAccepted(details = {}) {
    return recordExecution('execution.accepted', details);
  }

  function executionRejected(details = {}) {
    return recordExecution('execution.rejected', details);
  }

  // Startup info logged via server-log instead

  return Object.freeze({
    enabled: !!enabled,
    filePath: resolvedFile,
    includeText: !!includeText,
    fullText: !!fullText,
    maxBytes,
    rotations,
    record: write,
    begin,
    complete,
    fail,
    executionAccepted,
    executionRejected,
  });
}

module.exports = {
  TRACE_SCHEMA_VERSION,
  DEFAULT_TRACE_RELATIVE_PATH,
  DEFAULT_TRACE_MAX_BYTES,
  DEFAULT_TRACE_ROTATIONS,
  requestTraceEnabled,
  requestTraceFullEnabled,
  sanitizeTarget,
  traceText,
  requestKind,
  summarizeRequestPayload,
  summarizeResponsePayload,
  summarizeDispatchContract,
  summarizeExecutionContract,
  bindingDiff,
  resolveTraceFile,
  createRequestTraceLogger,
};
