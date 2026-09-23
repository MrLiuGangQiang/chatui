const { sendJson } = require('../http/response');
const { performance } = require('perf_hooks');
const { StringDecoder } = require('string_decoder');
const { normalizeExtraHeaders } = require('../proxy/headers');
const { makeJobId, getJobIdFromUrl, publicJob, extractProxyRequest, createUpstreamFetch, readUpstreamText, safeParseJson, respondJobError, normalizeUpstreamErrorMessage, findJobOr404, responsesInputFileDataParts } = require('./common');
const { normalizeContentText, normalizeReasoningText } = require('./reasoning');
const chatStreamParser = require('./chat-stream-parser');
const { DEFAULT_CONTEXT_WINDOW_TOKENS, applyContextBudgetToOpenAiPayload } = require('../../shared/config/context-budget');
const { safeLog, redactUrl } = require('../logging/safe-log');
const { limiter, withLimiter } = require('../concurrency');
const { extractResponsesStreamDelta, extractResponsesSources, webSourcesMarkdown } = require('../proxy/responses-stream');
const executionProtocolValidator = require('../validators/dispatch-contract.validator');
const { assertJobOwnedBy, assertRequestPrincipal, bindJobOwner, jobOwnerScope } = require('../security/job-ownership');
const { JOB_RESPONSE_HEADERS } = require('./http-contract');
const {
  executionConsumedError,
  executionIdempotencyConflictError,
  executionIdempotencyScope,
  deriveIdempotencyKey,
  contentFingerprint,
} = require('../validators/idempotency.validator');
const { assertProviderCapability } = require('../validators/provider-capability.validator');
const {
  failJobIfRunning,
  jobCancellationSignal,
  jobCanRun,
  preserveJobCancellation,
  releaseJobIdempotency,
} = require('./cancellation');

function elapsedSince(startedAt) {
  const elapsed = performance.now() - Number(startedAt || performance.now());
  return Math.max(1, elapsed);
}

function normalizeWebSearchJobError(job = {}, error = null) {
  const message = String(error?.message || error || '').trim();
  const usesWebSearch = Array.isArray(job?.payload?.tools)
    && job.payload.tools.some(tool => tool?.type === 'web_search');
  if (!usesWebSearch) return message;
  if (/(?:web_search|web search|tool).*(?:not supported|unsupported|unknown|invalid|not available)|(?:not supported|unsupported|unknown).*(?:web_search|web search|tool)/i.test(message)) {
    return '当前 Endpoint 或模型不支持 Responses API 的 web_search 工具，请更换支持联网搜索的模型或服务。';
  }
  return message || '联网搜索请求失败，请检查当前 Endpoint 是否支持 Responses API 的 web_search 工具。';
}

function makeChatJob(jobId, baseUrl, apiKey, payload, { stream = true, extraHeaders = {}, api = 'chat', executionContract = null, submissionId = '' } = {}) {
  const normalizedApi = api === 'responses' ? 'responses' : 'chat';
  const targetPath = normalizedApi === 'responses' ? '/responses' : '/chat/completions';
  return {
    id: jobId,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    api: normalizedApi,
    targetPath,
    requestPurpose: executionContract?.requestPurpose || '',
    submissionId: String(submissionId || ''),
    dispatchContract: executionContract?.dispatchContract || null,
    bindingEvidence: Array.isArray(executionContract?.bindingEvidence) ? executionContract.bindingEvidence.map(item => ({ ...item })) : [],
    targetUrl: `${baseUrl}${targetPath}`,
    apiKey,
    extraHeaders: normalizeExtraHeaders(extraHeaders),
    payload: stream ? { ...payload, stream: true } : { ...payload, stream: false },
    data: { choices: [{ message: { content: '', reasoning_content: '' } }] },
    error: '',
    buffer: '',
    streamStarted: false,
    serverStartAtMs: null,
    upstreamAcceptedAtMs: null,
    firstTokenMs: null,
    compactStream: true,
    streamSeq: 0,
    streamDelta: null,
  };
}

function summarizeChatPayload(payload = {}) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let imageParts = 0;
  let textParts = 0;
  const imageUrlLengths = [];
  messages.forEach(message => {
    if (!Array.isArray(message?.content)) return;
    message.content.forEach(part => {
      if (!part || typeof part !== 'object') return;
      if (part.type === 'image_url' || part.image_url) {
        imageParts += 1;
        const url = String(part.image_url?.url || part.image_url || '');
        imageUrlLengths.push(url.length);
      } else if (part.type === 'text' || part.text) textParts += 1;
    });
  });
  return {
    model: String(payload.model || ''),
    messages: messages.length,
    arrayContentMessages: messages.filter(message => Array.isArray(message?.content)).length,
    textParts,
    imageParts,
    imageUrlLengths,
  };
}

function releaseChatJobFileData(job) {
  const parts = responsesInputFileDataParts(job?.payload);
  for (const part of parts) delete part.file_data;
  return parts.length;
}

function validateManagedChatExecution(body, payload, api) {
  return executionProtocolValidator.validateManagedChatRequest({ ...body, payload, api }, {
    payload,
    transportApi: api,
  });
}

function executionContractFromValidation(validation) {
  return {
    requestPurpose: validation.requestPurpose,
    dispatchContract: validation.dispatchContract,
    bindingEvidence: validation.bindingEvidence,
  };
}

function pluginUnavailableError() {
  const error = new Error('插件功能未配置，请先在服务端启用插件');
  error.code = 'PLUGINS_UNAVAILABLE';
  error.statusCode = 503;
  return error;
}

function pluginUnsupportedTransportError() {
  const error = new Error('当前模型接口不支持插件调用，请使用 Chat Completions 兼容模型');
  error.code = 'PLUGIN_TRANSPORT_UNSUPPORTED';
  error.statusCode = 400;
  return error;
}

function createChatJobHandlers({ chatJobs, notifyJob, upstreamTimeoutMs, contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS, requestTrace, errorLog, idempotencyTable = null, providerCapabilities = null, pluginService = null }) {
function chatToolCalls(data = {}) {
  const message = data?.choices?.[0]?.message || {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls
    .filter(call => call && typeof call === 'object' && String(call.type || 'function') === 'function')
    .map(call => ({
      id: String(call.id || ''),
      type: 'function',
      function: {
        name: String(call.function?.name || ''),
        arguments: String(call.function?.arguments || '{}'),
      },
    }));
}

async function requestChatCompletionOnce(job, payload) {
  const upstreamRequest = createUpstreamFetch(job.targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(job.extraHeaders || {}),
      ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
    },
    body: JSON.stringify({ ...payload, stream: false }),
    job,
    upstreamTimeoutMs,
    signal: jobCancellationSignal(job),
  });
  const cleanup = upstreamRequest.cleanup;
  try {
    const upstream = await upstreamRequest.response;
    const text = await readUpstreamText(upstream, upstreamRequest.touch);
    const data = safeParseJson(text);
    if (!upstream.ok) throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
    return data;
  } finally {
    cleanup?.();
  }
}

async function runPluginChatJob(job) {
  const selectedTools = Array.isArray(job.pluginTools) ? job.pluginTools : [];
  const trace = [];
  let messages = Array.isArray(job.payload.messages) ? job.payload.messages.map(item => ({ ...item })) : [];
  for (let round = 0; round < 6; round += 1) {
    const data = await requestChatCompletionOnce(job, { ...job.payload, messages, stream: false });
    const calls = chatToolCalls(data);
    if (!calls.length) {
      job.data = data;
      return job;
    }
    const assistant = data?.choices?.[0]?.message || {};
    messages.push({
      role: 'assistant',
      content: typeof assistant.content === 'string' ? assistant.content : '',
      tool_calls: calls,
    });
    for (const call of calls) {
      const selected = selectedTools.find(item => item.toolName === call.function.name);
      if (!selected) {
        const error = new Error(`模型请求了未授权的插件工具：${call.function.name}`);
        error.code = 'PLUGIN_TOOL_NOT_AUTHORIZED';
        error.statusCode = 400;
        throw error;
      }
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); }
      catch {
        const error = new Error(`插件 ${selected.pluginId} 的参数不是有效 JSON`);
        error.code = 'PLUGIN_ARGUMENT_INVALID';
        error.statusCode = 400;
        throw error;
      }
      const result = await pluginService.callTool(`${selected.pluginId}:${selected.toolName}`, args, {
        signal: jobCancellationSignal(job),
      });
      trace.push({ pluginId: result.pluginId, toolName: result.toolName, status: 'done' });
      job.pluginTrace = trace.slice(-16);
      job.updatedAt = Date.now();
      notifyJob(job);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
    }
  }
  const error = new Error('插件调用轮数过多，请缩小问题范围后重试');
  error.code = 'PLUGIN_ROUNDS_EXCEEDED';
  error.statusCode = 502;
  throw error;
}

async function runChatJob(job) {
if (!jobCanRun(job)) return job;
if (Array.isArray(job.pluginTools) && job.pluginTools.length > 0) return runPluginChatJob(job);
job.serverStartAtMs = performance.now();
const traceSpan = requestTrace?.begin?.({
  parentTraceId: job.parentTraceId || '',
  rootTraceId: job.rootTraceId || '',
  source: 'chat_job',
  kind: 'chat',
  jobId: job.id,
  submissionId: job.submissionId || '',
  method: 'POST',
  target: job.targetUrl,
  targetPath: job.targetPath,
  payload: job.payload,
  headerNames: Object.keys(job.extraHeaders || {}),
  secrets: [job.apiKey],
});
let cleanup = null;
let upstreamStatus = 0;
let failure = null;
try {
  const upstreamRequest = createUpstreamFetch(job.targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(job.extraHeaders || {}),
      ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
    },
    body: JSON.stringify(job.payload),
    job,
    upstreamTimeoutMs,
    signal: jobCancellationSignal(job),
  });
  cleanup = upstreamRequest.cleanup;
  releaseChatJobFileData(job);
  const upstream = await upstreamRequest.response;
  if (!jobCanRun(job)) return job;
  upstreamStatus = Number(upstream.status) || 0;
  job.upstreamAcceptedAt = Date.now();
  job.upstreamAcceptedAtMs = performance.now();
  const text = await readUpstreamText(upstream, upstreamRequest.touch);
  if (!jobCanRun(job)) return job;
  let data = safeParseJson(text);
  if (!upstream.ok) throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
  if (job.api === 'responses') {
    const sourceMarkdown = webSourcesMarkdown(extractResponsesSources(data));
    if (sourceMarkdown) data = { ...data, output_text: `${normalizeContentText(data?.output_text || data?.output || '')}${sourceMarkdown}` };
  }
  if (!jobCanRun(job)) return job;
  job.status = 'done';
  job.error = '';
  job.data = data;
  job.durationMs = elapsedSince(job.serverStartAtMs);
} catch (err) {
  failure = err;
  if (!preserveJobCancellation(job) && job.status === 'running') {
    const aborted = err?.name === 'AbortError';
    errorLog?.log(err, { source: 'chat_job', traceId: traceSpan?.traceId || '' });
    job.status = 'error';
    job.error = normalizeWebSearchJobError(job, normalizeUpstreamErrorMessage(err, { aborted }));
  }
} finally {
  cleanup?.();
  delete job.controller;
  job.updatedAt = Date.now();
  if (job.status === 'done') {
    requestTrace?.complete?.(traceSpan, { status: upstreamStatus, response: job.data, durationMs: job.durationMs });
  } else {
    requestTrace?.fail?.(traceSpan, { status: upstreamStatus, error: failure || new Error(job.error) });
  }
  notifyJob(job);
}
return job;
}

async function runChatStreamJob(job) {
if (job.streamStarted || !jobCanRun(job)) return job;
job.streamStarted = true;
job.serverStartAt = Date.now();
job.serverStartAtMs = performance.now();
job.firstTokenMs = null;
const traceSpan = requestTrace?.begin?.({
  parentTraceId: job.parentTraceId || '',
  rootTraceId: job.rootTraceId || '',
  source: 'chat_stream_job',
  kind: 'chat',
  jobId: job.id,
  submissionId: job.submissionId || '',
  method: 'POST',
  target: job.targetUrl,
  targetPath: job.targetPath,
  payload: { ...job.payload, stream: true },
  headerNames: Object.keys(job.extraHeaders || {}),
  secrets: [job.apiKey],
});
let cleanup = null;
let upstreamStatus = 0;
let contentType = '';
let failure = null;
try {
  const upstreamRequest = createUpstreamFetch(job.targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(job.extraHeaders || {}),
      ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
    },
    body: JSON.stringify({ ...job.payload, stream: true }),
    job,
    upstreamTimeoutMs,
    signal: jobCancellationSignal(job),
  });
  cleanup = upstreamRequest.cleanup;
  releaseChatJobFileData(job);
  const upstream = await upstreamRequest.response;
  if (!jobCanRun(job)) return job;
  upstreamStatus = Number(upstream.status) || 0;
  job.upstreamAcceptedAt = Date.now();
  job.upstreamAcceptedAtMs = performance.now();
  contentType = upstream.headers.get('content-type') || '';
  if (!upstream.ok) {
    const text = await readUpstreamText(upstream, upstreamRequest.touch);
    if (!jobCanRun(job)) return job;
    const data = safeParseJson(text);
    throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
  }
  if (!upstream.body) throw new Error('上游没有返回流式响应体');
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    const text = await readUpstreamText(upstream, upstreamRequest.touch);
    if (!jobCanRun(job)) return job;
    const data = safeParseJson(text);
    const baseContent = normalizeContentText(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.message?.text || data?.choices?.[0]?.message?.output_text || data?.output_text || data?.content || data?.text || data?.message || data?.response || data?.output || data?.raw || '');
    const content = `${baseContent}${job.api === 'responses' ? webSourcesMarkdown(extractResponsesSources(data)) : ''}`;
    const msg = data?.choices?.[0]?.message || {};
    const outputReasoning = Array.isArray(data?.output) ? data.output.filter(item => /reason/i.test(String(item?.type || item?.role || '')) || item?.summary || item?.summary_text || item?.reasoning) : '';
    const reasoning = normalizeReasoningText(msg.reasoning_content || msg.reasoning || data?.reasoning_summary || data?.summary || data?.reasoning_content || data?.reasoning || outputReasoning || '');
    if (content || reasoning) markFirstToken(job);
    job.data = { choices: [{ message: { content, reasoning_content: reasoning } }] };
  } else {
    const decoder = new StringDecoder('utf8');
    for await (const chunk of upstream.body) {
      if (!jobCanRun(job)) return job;
      const decoded = decoder.write(Buffer.from(chunk));
      const progressed = updateChatJobFromStreamChunk(job, decoded, { notify: false, ...(job.api === 'responses' ? { extractDelta: extractResponsesStreamDelta } : {}) });
      if (progressed) {
        upstreamRequest.touch();
        notifyChatStreamJob(job);
      }
    }
    const decodedTail = decoder.end();
    if (decodedTail) {
      const progressed = updateChatJobFromStreamChunk(job, decodedTail, { notify: false, ...(job.api === 'responses' ? { extractDelta: extractResponsesStreamDelta } : {}) });
      if (progressed) {
        upstreamRequest.touch();
        notifyChatStreamJob(job);
      }
    }
    if (job.buffer) {
      const progressed = updateChatJobFromStreamChunk(job, '\n\n', { notify: false, ...(job.api === 'responses' ? { extractDelta: extractResponsesStreamDelta } : {}) });
      if (progressed) {
        upstreamRequest.touch();
        notifyChatStreamJob(job);
      }
    }
  }
  if (!jobCanRun(job)) return job;
  job.status = 'done';
  job.error = '';
  job.durationMs = elapsedSince(job.serverStartAtMs);
  delete job.buffer;
} catch (err) {
  failure = err;
  if (!preserveJobCancellation(job) && job.status === 'running') {
    const aborted = err?.name === 'AbortError';
    errorLog?.log(err, { source: 'chat_stream_job', traceId: traceSpan?.traceId || '' });
    job.status = 'error';
    job.error = normalizeWebSearchJobError(job, normalizeUpstreamErrorMessage(err, { aborted }));
  }
} finally {
  cleanup?.();
  delete job.controller;
  job.updatedAt = Date.now();
  if (job.status === 'done') {
    requestTrace?.complete?.(traceSpan, { status: upstreamStatus, response: job.data, contentType, durationMs: job.durationMs });
  } else {
    requestTrace?.fail?.(traceSpan, { status: upstreamStatus, error: failure || new Error(job.error), contentType });
  }
  notifyChatStreamJob(job);
}
return job;
}

async function registerChatStreamJob(req, res) {
const extracted = await extractProxyRequest(req, res);
if (!extracted) return;
const { body, baseUrl, apiKey, extraHeaders } = extracted;
let api = body.api === 'responses' ? 'responses' : 'chat';
let payload = body.payload || {};
let jobId = String(body?.jobId || '');
let validationStage = 'prepare_payload';
const traceExecution = (event, extra = {}) => requestTrace?.[event]?.({
  traceId: req._traceId || '',
  rootTraceId: req._rootTraceId || '',
  source: 'managed_chat_stream_execution',
  submissionId: String(body?.submissionId || ''),
  jobId,
  body,
  payload,
  transportApi: api,
  secrets: [apiKey],
  stage: validationStage,
  ...extra,
});
try {
  const principal = assertRequestPrincipal(req);
  jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
  let job = chatJobs.get(jobId);
  if (job) {
    validationStage = 'job_owner';
    assertJobOwnedBy(job, principal);
  }
  const targetPath = api === 'responses' ? '/responses' : '/chat/completions';
  payload = applyContextBudgetToOpenAiPayload(body.payload || {}, { contextWindowTokens, targetPath, summarizeOmitted: false });
  validationStage = 'execution_protocol';
  const validation = validateManagedChatExecution(body, payload, api);
  const executionContract = executionContractFromValidation(validation);
  if (body.pluginToolIds !== undefined) throw pluginUnsupportedTransportError();
  safeLog('[chat-stream-job] upstream payload', { ...summarizeChatPayload(payload), api });
  if (job) {
    validationStage = 'job_contract';
    executionProtocolValidator.assertJobExecutionContract(job, executionContract);
    traceExecution('executionAccepted', { reused: true });
  }
  if (!job) {
    validationStage = 'accepted';
    traceExecution('executionAccepted');
    job = makeChatJob(jobId, baseUrl, apiKey, payload, {
      stream: true, extraHeaders, api, executionContract, submissionId: body.submissionId,
    });
    bindJobOwner(job, principal);
    chatJobs.set(jobId, job);
    job.parentTraceId = req._traceId || '';
    job.rootTraceId = req._rootTraceId || '';
  }
  if (body.start === true && !job.streamStarted && job.status === 'running') withLimiter(
    limiter,
    () => runChatStreamJob(job),
    { signal: jobCancellationSignal(job) },
  ).catch(err => {
    if (failJobIfRunning(job, err)) notifyJob(job);
  });
  sendJson(res, 202, publicJob(job), JOB_RESPONSE_HEADERS);
} catch (err) {
  traceExecution('executionRejected', { error: err });
  respondJobError(res, err);
}
}

async function startChatJob(req, res) {
const extracted = await extractProxyRequest(req, res);
if (!extracted) return;
const { body, baseUrl, apiKey, extraHeaders } = extracted;
let api = body.api === 'responses' ? 'responses' : 'chat';
let payload = body.payload || {};
let jobId = String(body?.jobId || '');
let validationStage = 'prepare_payload';
const traceExecution = (event, extra = {}) => requestTrace?.[event]?.({
  traceId: req._traceId || '',
  rootTraceId: req._rootTraceId || '',
  source: 'managed_chat_execution',
  submissionId: String(body?.submissionId || ''),
  jobId,
  body,
  payload,
  transportApi: api,
  secrets: [apiKey],
  stage: validationStage,
  ...extra,
});
try {
  const principal = assertRequestPrincipal(req);
  jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
  const existingJob = chatJobs.get(jobId);
  if (existingJob) {
    validationStage = 'job_owner';
    assertJobOwnedBy(existingJob, principal);
  }
  const targetPath = api === 'responses' ? '/responses' : '/chat/completions';
  payload = applyContextBudgetToOpenAiPayload(body.payload || {}, { contextWindowTokens, targetPath, summarizeOmitted: false });
  validationStage = 'execution_protocol';
  const validation = validateManagedChatExecution(body, payload, api);
  const executionContract = executionContractFromValidation(validation);
  validationStage = 'plugin_tools';
  let pluginTools = [];
  if (body.pluginToolIds !== undefined) {
    if (!pluginService) throw pluginUnavailableError();
    if (api !== 'chat') throw pluginUnsupportedTransportError();
    const tools = pluginService.chatTools(body.pluginToolIds);
    const selected = pluginService.resolveSelectedTools(body.pluginToolIds);
    if (!tools.length || tools.length !== selected.length) {
      const error = new Error('没有可用的插件工具，请重新选择后重试');
      error.code = 'PLUGIN_TOOL_NOT_FOUND';
      error.statusCode = 400;
      throw error;
    }
    payload = { ...payload, tools, stream: false };
    pluginTools = selected.map(({ plugin, tool }) => ({ pluginId: plugin.id, toolName: tool.name }));
  }
  safeLog('[chat-job] upstream payload', { ...summarizeChatPayload(payload), api });
  if (existingJob) {
    validationStage = 'job_contract';
    executionProtocolValidator.assertJobExecutionContract(existingJob, executionContract);
    traceExecution('executionAccepted', { reused: true });
    return sendJson(res, 200, publicJob(existingJob), JOB_RESPONSE_HEADERS);
  }
  // Design doc v2.7 10: idempotency dedup before creating a new Job. The
  // same canonical plan (or the same client-derived key) must not execute
  // twice. Existing-Job reuse above stays the fast path for identical jobId.
  let idempotencyEntry = null;
  if (idempotencyTable && executionContract.dispatchContract) {
    const plan = executionContract.dispatchContract;
    const key = deriveIdempotencyKey(plan);
    const fingerprint = contentFingerprint(plan);
    const scope = executionIdempotencyScope(jobOwnerScope(principal), body.submissionId, jobId);
    const idem = idempotencyTable.check({ key, fingerprint, scope });
    if (idem.status === 'conflict') throw executionIdempotencyConflictError(idem.result);
    if (idem.status === 'consumed') throw executionConsumedError(idem.result);
    idempotencyEntry = { key, fingerprint, scope };
  }
  // Design doc v2.7 7.1: provider capability gate before Job creation.
  // Unconfigured provider (null) keeps baseline behavior (allow).
  if (providerCapabilities && executionContract.dispatchContract) {
    assertProviderCapability({
      operation: executionContract.dispatchContract.operation || '',
      bindings: Array.isArray(executionContract.dispatchContract.bindings)
        ? executionContract.dispatchContract.bindings
        : [],
      argumentsValue: executionContract.dispatchContract.arguments || {},
      provider: providerCapabilities,
    });
  }
  validationStage = 'accepted';
  traceExecution('executionAccepted');
  const job = {
    id: jobId,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    api,
    targetPath,
    targetUrl: `${baseUrl}${targetPath}`,
    apiKey,
    extraHeaders,
    requestPurpose: executionContract.requestPurpose,
    submissionId: String(body.submissionId || ''),
    dispatchContract: executionContract.dispatchContract,
    bindingEvidence: executionContract.bindingEvidence,
    payload: { ...payload, stream: false },
    ...(pluginTools.length ? { pluginTools } : {}),
    data: null,
    error: '',
    ...(idempotencyEntry ? {
      idempotencyKey: idempotencyEntry.key,
      idempotencyFingerprint: idempotencyEntry.fingerprint,
      idempotencyScope: idempotencyEntry.scope,
    } : {}),
  };
  bindJobOwner(job, principal);
  chatJobs.set(job.id, job);
  if (idempotencyEntry && idempotencyTable) {
    idempotencyTable.consume({ ...idempotencyEntry, result: job.id });
  }
  job.parentTraceId = req._traceId || '';
  job.rootTraceId = req._rootTraceId || '';
  withLimiter(
    limiter,
    () => runChatJob(job),
    { signal: jobCancellationSignal(job) },
  ).catch(err => {
    if (failJobIfRunning(job, err)) notifyJob(job);
  }).finally(() => {
    if (job.status === 'error') releaseJobIdempotency(job, idempotencyTable);
  });
  sendJson(res, 202, publicJob(job), JOB_RESPONSE_HEADERS);
} catch (err) {
  traceExecution('executionRejected', { error: err });
  respondJobError(res, err);
}
}

function getChatJob(req, res) {
safeLog('[getChatJob]', { path: redactUrl(req.url) });
const id = getJobIdFromUrl(req);
const job = findJobOr404(chatJobs, id, res, req.authPrincipal);
if (!job) return;
sendJson(res, 200, publicJob(job, { resumeUrl: req.url }), JOB_RESPONSE_HEADERS);
}


function notifyChatStreamJob(job) {
  notifyJob(job);
}

function updateChatJobFromStreamChunk(job, text, options = {}) {
  return chatStreamParser.updateChatJobFromStreamChunk(job, text, {
    ...options,
    notifyChatStreamJob,
    elapsedSince,
  });
}

  return {
    makeChatJob,
    registerChatStreamJob,
    startChatJob,
    getChatJob,
    updateChatJobFromStreamChunk,
    runChatStreamJob,
  };
}

module.exports = { createChatJobHandlers, summarizeChatPayload, releaseChatJobFileData, normalizeWebSearchJobError };
