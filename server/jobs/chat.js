const { sendJson } = require('../http/response');
const { readBody, parseJson } = require('../http/body');
const { normalizeExtraHeaders } = require('../proxy/headers');
const { normalizeBaseUrl } = require('../security/url-policy');
const { makeJobId, getJobIdFromUrl, publicJob } = require('./common');
const { normalizeContentText, normalizeReasoningText } = require('./reasoning');

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

function createChatJobHandlers({ chatJobs, notifyJob, upstreamTimeoutMs }) {
async function runChatJob(job) {
const controller = new AbortController();
job.controller = controller;
const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
try {
  const upstream = await fetch(job.targetUrl, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(job.extraHeaders || {}),
      ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
    },
    body: JSON.stringify(job.payload),
  });
  const text = await upstream.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
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
const controller = new AbortController();
job.controller = controller;
const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
try {
  const upstream = await fetch(job.targetUrl, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(job.extraHeaders || {}),
      ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
    },
    body: JSON.stringify({ ...job.payload, stream: true }),
  });
  const contentType = upstream.headers.get('content-type') || '';
  if (!upstream.ok) {
    const text = await upstream.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
  }
  if (!upstream.body) throw new Error('上游没有返回流式响应体');
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    const text = await upstream.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
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
try {
  const body = parseJson(await readBody(req));
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const apiKey = String(body.apiKey || '').trim();
  const payload = body.payload || {};
  const extraHeaders = normalizeExtraHeaders(body.headers || body.extraHeaders);
  if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
  const jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
  let job = chatJobs.get(jobId);
  if (!job) {
    job = makeChatJob(jobId, baseUrl, apiKey, payload, { stream: true, extraHeaders });
    chatJobs.set(jobId, job);
  }
  if (body.start === true && !job.streamStarted && job.status === 'running') runChatStreamJob(job);
  sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
} catch (err) {
  sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
}
}

async function startChatJob(req, res) {
try {
  const body = parseJson(await readBody(req));
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const apiKey = String(body.apiKey || '').trim();
  const payload = body.payload || {};
  const extraHeaders = normalizeExtraHeaders(body.headers || body.extraHeaders);
  if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
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
  runChatJob(job);
  sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
} catch (err) {
  sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
}
}

function getChatJob(req, res) {
const id = getJobIdFromUrl(req);
const job = chatJobs.get(id);
if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
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

module.exports = { createChatJobHandlers, makeChatJob };
