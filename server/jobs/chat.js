const { sendJson } = require('../http/response');
const { performance } = require('perf_hooks');
const { normalizeExtraHeaders } = require('../proxy/headers');
const { makeJobId, getJobIdFromUrl, publicJob, extractProxyRequest, createUpstreamFetch, safeParseJson, respondJobError, normalizeUpstreamErrorMessage, findJobOr404, responsesInputFileDataParts } = require('./common');
const { normalizeContentText, normalizeReasoningText } = require('./reasoning');
const chatStreamParser = require('./chat-stream-parser');
const { DEFAULT_CONTEXT_WINDOW_TOKENS, applyContextBudgetToOpenAiPayload } = require('../../shared/config/context-budget');
const { safeLog, redactUrl } = require('../logging/safe-log');
const { limiter, withLimiter } = require('../concurrency');
const { extractResponsesStreamDelta } = require('../proxy/responses-stream');
const executionProtocolValidator = require('../validators/dispatch-contract.validator');

function elapsedSince(startedAt) {
  const elapsed = performance.now() - Number(startedAt || performance.now());
  return Math.max(1, elapsed);
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

function createChatJobHandlers({ chatJobs, notifyJob, upstreamTimeoutMs, contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS, requestTrace, errorLog }) {
async function runChatJob(job) {
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
let timer = null;
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
  });
  timer = upstreamRequest.timer;
  releaseChatJobFileData(job);
  const upstream = await upstreamRequest.response;
  upstreamStatus = Number(upstream.status) || 0;
  job.upstreamAcceptedAt = Date.now();
  job.upstreamAcceptedAtMs = performance.now();
  const text = await upstream.text();
  const data = safeParseJson(text);
  if (!upstream.ok) throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
  job.status = 'done';
  job.data = data;
  job.durationMs = elapsedSince(job.serverStartAtMs);
} catch (err) {
  failure = err;
  const aborted = err?.name === 'AbortError';
  errorLog?.log(err, { source: 'chat_job', traceId: traceSpan?.traceId || '' });
  job.status = 'error';
  job.error = normalizeUpstreamErrorMessage(err, { aborted });
} finally {
  if (timer) clearTimeout(timer);
  delete job.controller;
  job.updatedAt = Date.now();
  if (job.status === 'done') {
    requestTrace?.complete?.(traceSpan, { status: upstreamStatus, response: job.data, durationMs: job.durationMs });
  } else {
    requestTrace?.fail?.(traceSpan, { status: upstreamStatus, error: failure || new Error(job.error) });
  }
  notifyJob(job);
}
}

async function runChatStreamJob(job) {
if (job.streamStarted) return;
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
let timer = null;
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
  });
  timer = upstreamRequest.timer;
  releaseChatJobFileData(job);
  const upstream = await upstreamRequest.response;
  upstreamStatus = Number(upstream.status) || 0;
  job.upstreamAcceptedAt = Date.now();
  job.upstreamAcceptedAtMs = performance.now();
  contentType = upstream.headers.get('content-type') || '';
  if (!upstream.ok) {
    const text = await upstream.text();
    const data = safeParseJson(text);
    throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
  }
  if (!upstream.body) throw new Error('上游没有返回流式响应体');
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    const text = await upstream.text();
    const data = safeParseJson(text);
    const content = normalizeContentText(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.message?.text || data?.choices?.[0]?.message?.output_text || data?.output_text || data?.content || data?.text || data?.message || data?.response || data?.output || data?.raw || '');
    const msg = data?.choices?.[0]?.message || {};
    const outputReasoning = Array.isArray(data?.output) ? data.output.filter(item => /reason/i.test(String(item?.type || item?.role || '')) || item?.summary || item?.summary_text || item?.reasoning) : '';
    const reasoning = normalizeReasoningText(msg.reasoning_content || msg.reasoning || data?.reasoning_summary || data?.summary || data?.reasoning_content || data?.reasoning || outputReasoning || '');
    if (content || reasoning) markFirstToken(job);
    job.data = { choices: [{ message: { content, reasoning_content: reasoning } }] };
  } else {
    for await (const chunk of upstream.body) {
      if (updateChatJobFromStreamChunk(job, Buffer.from(chunk).toString('utf8'), { notify: false, ...(job.api === 'responses' ? { extractDelta: extractResponsesStreamDelta } : {}) })) notifyChatStreamJob(job);
    }
    if (job.buffer) {
      if (updateChatJobFromStreamChunk(job, '\n\n', { notify: false, ...(job.api === 'responses' ? { extractDelta: extractResponsesStreamDelta } : {}) })) notifyChatStreamJob(job);
    }
  }
  job.status = 'done';
  job.durationMs = elapsedSince(job.serverStartAtMs);
  delete job.buffer;
} catch (err) {
  failure = err;
  const aborted = err?.name === 'AbortError';
  errorLog?.log(err, { source: 'chat_stream_job', traceId: traceSpan?.traceId || '' });
  job.status = 'error';
  job.error = normalizeUpstreamErrorMessage(err, { aborted });
} finally {
  if (timer) clearTimeout(timer);
  delete job.controller;
  job.updatedAt = Date.now();
  if (job.status === 'done') {
    requestTrace?.complete?.(traceSpan, { status: upstreamStatus, response: job.data, contentType, durationMs: job.durationMs });
  } else {
    requestTrace?.fail?.(traceSpan, { status: upstreamStatus, error: failure || new Error(job.error), contentType });
  }
  notifyChatStreamJob(job);
}
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
  const targetPath = api === 'responses' ? '/responses' : '/chat/completions';
  payload = applyContextBudgetToOpenAiPayload(body.payload || {}, { contextWindowTokens, targetPath, summarizeOmitted: false });
  validationStage = 'execution_protocol';
  const validation = validateManagedChatExecution(body, payload, api);
  const executionContract = executionContractFromValidation(validation);
  safeLog('[chat-stream-job] upstream payload', { ...summarizeChatPayload(payload), api });
  jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
  let job = chatJobs.get(jobId);
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
    chatJobs.set(jobId, job);
    job.parentTraceId = req._traceId || '';
    job.rootTraceId = req._rootTraceId || '';
  }
  if (body.start === true && !job.streamStarted && job.status === 'running') withLimiter(limiter, () => runChatStreamJob(job)).catch(err => {
    job.status = 'error';
    job.error = err.message || String(err);
    job.updatedAt = Date.now();
  });
  sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
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
  const targetPath = api === 'responses' ? '/responses' : '/chat/completions';
  payload = applyContextBudgetToOpenAiPayload(body.payload || {}, { contextWindowTokens, targetPath, summarizeOmitted: false });
  validationStage = 'execution_protocol';
  const validation = validateManagedChatExecution(body, payload, api);
  const executionContract = executionContractFromValidation(validation);
  safeLog('[chat-job] upstream payload', { ...summarizeChatPayload(payload), api });
  jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
  if (chatJobs.has(jobId)) {
    validationStage = 'job_contract';
    executionProtocolValidator.assertJobExecutionContract(chatJobs.get(jobId), executionContract);
    traceExecution('executionAccepted', { reused: true });
    return sendJson(res, 200, publicJob(chatJobs.get(jobId)), { 'Access-Control-Allow-Origin': '*' });
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
    data: null,
    error: '',
  };
  chatJobs.set(job.id, job);
  job.parentTraceId = req._traceId || '';
  job.rootTraceId = req._rootTraceId || '';
  withLimiter(limiter, () => runChatJob(job)).catch(err => {
    job.status = 'error';
    job.error = err.message || String(err);
    job.updatedAt = Date.now();
  });
  sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
} catch (err) {
  traceExecution('executionRejected', { error: err });
  respondJobError(res, err);
}
}

function getChatJob(req, res) {
safeLog('[getChatJob]', { path: redactUrl(req.url) });
const id = getJobIdFromUrl(req);
const job = findJobOr404(chatJobs, id, res);
if (!job) return;
sendJson(res, 200, publicJob(job, { resumeUrl: req.url }), { 'Access-Control-Allow-Origin': '*' });
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
  };
}

module.exports = { createChatJobHandlers, summarizeChatPayload, releaseChatJobFileData };
