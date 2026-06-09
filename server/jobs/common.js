const { SECURITY_HEADERS, sendJson } = require('../http/response');
const { readBody, parseJson } = require('../http/body');
const { normalizeExtraHeaders } = require('../proxy/headers');
const { normalizeBaseUrl } = require('../security/url-policy');

function makeJobId(value = '') {
  const supplied = String(value || '').trim();
  if (/^(imgjob|chatjob)-[a-z0-9-]{8,80}$/i.test(supplied)) return supplied;
  return `imgjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getJobIdFromUrl(req) {
  return decodeURIComponent(req.url.split('?')[0].split('/').filter(Boolean).at(-1) === 'events'
    ? req.url.split('?')[0].split('/').filter(Boolean).at(-2) || ''
    : req.url.split('?')[0].split('/').filter(Boolean).at(-1) || '');
}

function publicJob(job, options = {}) {
  const metrics = {
    firstTokenMs: Number.isFinite(job.firstTokenMs) ? job.firstTokenMs : null,
    durationMs: Number.isFinite(job.durationMs) ? job.durationMs : null,
  };
  const minimalCompact = (options.live === true || options.resumeUrl) && job.compactStream === true;
  if (minimalCompact) {
    const payload = {};
    if (options.resumeUrl) {
      const url = new URL(options.resumeUrl, 'http://localhost');
      const contentLength = Math.max(0, Number(url.searchParams.get('contentLength') || 0) || 0);
      const reasoningLength = Math.max(0, Number(url.searchParams.get('reasoningLength') || 0) || 0);
      const message = job.data?.choices?.[0]?.message || {};
      const content = String(message.content || '');
      const reasoning = String(message.reasoning_content || '');
      const contentStart = Math.min(contentLength, content.length);
      const reasoningStart = Math.min(reasoningLength, reasoning.length);
      if (content.length > contentStart) payload.d = content.slice(contentStart);
      if (reasoning.length > reasoningStart) payload.r = reasoning.slice(reasoningStart);
    } else if (job.status === 'running') {
      const delta = job.streamDelta || {};
      if (delta.content) payload.d = delta.content;
      if (delta.reasoning) payload.r = delta.reasoning;
    }
    const shouldSendFt = Number.isFinite(job.firstTokenMs) && job.firstTokenMs >= 0 && !job.firstTokenNotified && !options.resumeUrl;
    if (shouldSendFt) payload.ft = job.firstTokenMs;
    if (job.status === 'done') payload.done = 1;
    if (job.status === 'error') payload.e = job.error || '任务失败';
    return payload;
  }
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    data: job.data || null,
    metrics,
    error: job.error ? { message: job.error } : null,
  };
}

function compactResumeSnapshot(job, req) {
  return publicJob(job, { resumeUrl: req.url });
}

function createJobEvents({ jobSubscribers }) {
  function notifyJob(job) {
    const subscribers = jobSubscribers.get(job.id);
    if (!subscribers) return;
    const data = `event: update\ndata: ${JSON.stringify(publicJob(job, { live: true }))}\n\n`;
    for (const res of subscribers) {
      res.write(data);
      res.flushHeaders?.();
    }
    if (Number.isFinite(job.firstTokenMs) && job.firstTokenMs >= 0 && !job.firstTokenNotified) job.firstTokenNotified = true;
    delete job.streamDelta;
    if (job.status === 'done' || job.status === 'error') {
      for (const res of subscribers) res.end();
      jobSubscribers.delete(job.id);
    }
  }

  function subscribeJob(req, res, store) {
    const id = getJobIdFromUrl(req);
    const job = store.get(id);
    if (!job) { res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' }); res.write(`event: update\ndata: ${JSON.stringify({ status: 'error', error: { message: '任务不存在或服务已重启' } })}\n\n`); res.end(); return; }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: update\ndata: ${JSON.stringify(compactResumeSnapshot(job, req))}\n\n`);
    res.flushHeaders?.();
    if (job.status === 'done' || job.status === 'error') return res.end();
    if (!jobSubscribers.has(id)) jobSubscribers.set(id, new Set());
    jobSubscribers.get(id).add(res);
    req.on('close', () => {
      const set = jobSubscribers.get(id);
      if (!set) return;
      set.delete(res);
      if (!set.size) jobSubscribers.delete(id);
    });
  }

  function abortJob(store, id, message = '任务已停止') {
    const job = store.get(id);
    if (!job) return null;
    if (job.status === 'done' || job.status === 'error') return job;
    job.status = 'error';
    job.error = message;
    job.updatedAt = Date.now();
    try { job.controller?.abort(); } catch {}
    notifyJob(job);
    return job;
  }

  return { notifyJob, subscribeJob, abortJob };
}

async function extractProxyRequest(req, res) {
  let body;
  try {
    body = parseJson(await readBody(req));
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: { message: err.message || String(err) } });
    return null;
  }
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const apiKey = String(body.apiKey || '').trim();
  const extraHeaders = normalizeExtraHeaders(body.headers || body.extraHeaders);
  if (!baseUrl) {
    sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    return null;
  }
  return { body, baseUrl, apiKey, extraHeaders };
}

function createUpstreamFetch(url, { method, headers, body, job, upstreamTimeoutMs }) {
  const controller = new AbortController();
  if (job) job.controller = controller;
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
  const response = fetch(url, { method, headers, body, signal: controller.signal });
  return { response, controller, timer };
}

function safeParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function respondJobError(res, err) {
  sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
}

function findJobOr404(store, id, res) {
  const job = store.get(id);
  if (!job) sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
  return job;
}

module.exports = { makeJobId, getJobIdFromUrl, publicJob, createJobEvents, extractProxyRequest, createUpstreamFetch, safeParseJson, respondJobError, findJobOr404 };
