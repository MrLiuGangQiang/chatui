const { sendJson } = require('../http/response');
const { normalizeExtraHeaders } = require('../proxy/headers');
const { makeJobId, getJobIdFromUrl, publicJob, extractProxyRequest, createUpstreamFetch, safeParseJson, respondJobError, findJobOr404 } = require('./common');
const { normalizeContentText, normalizeReasoningText } = require('./reasoning');
const { DEFAULT_CONTEXT_WINDOW_TOKENS, applyContextBudgetToChatPayload } = require('../../client/core/context-budget');
const { safeLog, redactUrl } = require('../logging/safe-log');
const { limiter, withLimiter } = require('../concurrency');

function makeChatJob(jobId, baseUrl, apiKey, payload, { stream = true, extraHeaders = {} } = {}) {
  return {
    id: jobId,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    targetUrl: `${baseUrl}/chat/completions`,
    apiKey,
    extraHeaders: normalizeExtraHeaders(extraHeaders),
    payload: stream ? { ...payload, stream: true } : { ...payload, stream: false },
    data: { choices: [{ message: { content: '', reasoning_content: '' } }] },
    error: '',
    buffer: '',
    streamStarted: false,
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

function createChatJobHandlers({ chatJobs, notifyJob, upstreamTimeoutMs, contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS }) {
async function runChatJob(job) {
const { response: upstreamResponse, controller, timer } = createUpstreamFetch(job.targetUrl, {
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
try {
  const upstream = await upstreamResponse;
  const text = await upstream.text();
  const data = safeParseJson(text);
  if (!upstream.ok) throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
  job.status = 'done';
  job.data = data;
} catch (err) {
  const aborted = err?.name === 'AbortError';
  job.status = 'error';
  job.error = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
} finally {
  clearTimeout(timer);
  delete job.controller;
  job.updatedAt = Date.now();
  notifyJob(job);
}
}

async function runChatStreamJob(job) {
if (job.streamStarted) return;
job.streamStarted = true;
job.serverStartAt = Date.now();
job.firstTokenMs = null;
const { response: upstreamResponse, controller, timer } = createUpstreamFetch(job.targetUrl, {
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
try {
  const upstream = await upstreamResponse;
  const contentType = upstream.headers.get('content-type') || '';
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
    const outputReasoning = Array.isArray(data?.output) ? data.output.filter(item => /reason/i.test(String(item?.type || item?.role || '')) || item?.summary || item?.reasoning || item?.thinking) : '';
    const reasoning = normalizeReasoningText(msg.reasoning_content || msg.reasoning || msg.thinking || msg.reasoning_details || msg.thinking_content || data?.reasoning_content || data?.reasoning || data?.thinking || data?.reasoning_details || data?.thinking_content || outputReasoning || '');
    if (content || reasoning) markFirstToken(job);
    job.data = { choices: [{ message: { content, reasoning_content: reasoning } }] };
  } else {
    for await (const chunk of upstream.body) {
      if (updateChatJobFromStreamChunk(job, Buffer.from(chunk).toString('utf8'), { notify: false })) notifyChatStreamJob(job);
    }
    if (job.buffer) {
      if (updateChatJobFromStreamChunk(job, '\n\n', { notify: false })) notifyChatStreamJob(job);
    }
  }
  job.status = 'done';
  delete job.buffer;
} catch (err) {
  const aborted = err?.name === 'AbortError';
  job.status = 'error';
  job.error = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
} finally {
  clearTimeout(timer);
  delete job.controller;
  job.updatedAt = Date.now();
  notifyChatStreamJob(job);
}
}

async function registerChatStreamJob(req, res) {
const extracted = await extractProxyRequest(req, res);
if (!extracted) return;
const { body, baseUrl, apiKey, extraHeaders } = extracted;
try {
  const payload = applyContextBudgetToChatPayload(body.payload || {}, { contextWindowTokens });
  safeLog('[chat-stream-job] upstream payload', summarizeChatPayload(payload));
  const jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
  let job = chatJobs.get(jobId);
  if (!job) {
    job = makeChatJob(jobId, baseUrl, apiKey, payload, { stream: true, extraHeaders });
    chatJobs.set(jobId, job);
  }
  if (body.start === true && !job.streamStarted && job.status === 'running') withLimiter(limiter, () => runChatStreamJob(job)).catch(err => {
    job.status = 'error';
    job.error = err.message || String(err);
    job.updatedAt = Date.now();
  });
  sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
} catch (err) {
  respondJobError(res, err);
}
}

async function startChatJob(req, res) {
const extracted = await extractProxyRequest(req, res);
if (!extracted) return;
const { body, baseUrl, apiKey, extraHeaders } = extracted;
try {
  const payload = applyContextBudgetToChatPayload(body.payload || {}, { contextWindowTokens });
  safeLog('[chat-job] upstream payload', summarizeChatPayload(payload));
  const jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
  if (chatJobs.has(jobId)) return sendJson(res, 200, publicJob(chatJobs.get(jobId)), { 'Access-Control-Allow-Origin': '*' });
  const job = {
    id: jobId,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    targetUrl: `${baseUrl}/chat/completions`,
    apiKey,
    extraHeaders,
    payload: { ...payload, stream: false },
    data: null,
    error: '',
  };
  chatJobs.set(job.id, job);
  withLimiter(limiter, () => runChatJob(job)).catch(err => {
    job.status = 'error';
    job.error = err.message || String(err);
    job.updatedAt = Date.now();
  });
  sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
} catch (err) {
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

function markFirstToken(job) {
  if (job.firstTokenMs === null || job.firstTokenMs === undefined) {
    job.firstTokenMs = Date.now() - Number(job.serverStartAt || job.createdAt || Date.now());
  }
}

function updateChatJobFromStreamChunk(job, text, { notify = true } = {}) {
job.buffer = (job.buffer || '') + text;
const events = job.buffer.split(/\r?\n\r?\n/);
job.buffer = events.pop() || '';
const message = job.data.choices[0].message;
let chunkContent = '';
let chunkReasoning = '';
for (const eventText of events) {
  const dataText = eventText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n')
    .trim();
  if (!dataText || dataText === '[DONE]') continue;
  try {
    const data = JSON.parse(dataText);
    const delta = data?.choices?.[0]?.delta || data?.choices?.[0]?.message || {};
    const content = normalizeContentText(delta.content || delta.text || delta.output_text || data?.output_text || data?.content || data?.text || data?.message || data?.response || data?.output || '');
    const reasoning = normalizeReasoningText(delta.reasoning_content || delta.reasoning || delta.thinking || delta.reasoning_details || delta.thinking_content || data?.reasoning_content || data?.reasoning || data?.thinking || data?.reasoning_details || data?.thinking_content || '');
    if (content || reasoning) markFirstToken(job);
    if (content) { message.content += content; chunkContent += content; }
    if (reasoning) { message.reasoning_content += reasoning; chunkReasoning += reasoning; }
    job.updatedAt = Date.now();
    if (notify && (content || reasoning)) notifyChatStreamJob(job);
  } catch {}
}
if (chunkContent || chunkReasoning) {
  job.streamSeq = (job.streamSeq || 0) + 1;
  job.streamDelta = { content: chunkContent, reasoning: chunkReasoning };
  return true;
}
return false;
}

  return {
    makeChatJob,
    registerChatStreamJob,
    startChatJob,
    getChatJob,
    updateChatJobFromStreamChunk,
  };
}

module.exports = { createChatJobHandlers, summarizeChatPayload };
