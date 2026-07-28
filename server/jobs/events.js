const { SECURITY_HEADERS, applyResponseHeaders } = require('../http/response');
const { safeLog, redactUrl } = require('../logging/safe-log');
const { getJobIdFromUrl } = require('./job-url');
const { positiveInteger } = require('../config/numbers');
const MAX_JOB_SUBSCRIBERS = positiveInteger(process.env.MAX_JOB_SUBSCRIBERS, 32, { max: 10_000 });
const MAX_TOTAL_JOB_SUBSCRIBERS = positiveInteger(process.env.MAX_TOTAL_JOB_SUBSCRIBERS, 2048, { max: 100_000 });
const MAX_SUBSCRIBER_BUFFER_BYTES = positiveInteger(process.env.MAX_JOB_SUBSCRIBER_BUFFER_BYTES, 1024 * 1024, { max: 64 * 1024 * 1024 });
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
    if (Number.isFinite(job.durationMs) && job.durationMs >= 0) payload.rt = job.durationMs;
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

async function writeWithBackpressure(res, data, chunkChars = 64 * 1024) {
  const source = String(data || '');
  const chunkSize = Math.max(2, positiveInteger(chunkChars, 64 * 1024, { max: 1024 * 1024 }));
  for (let offset = 0; offset < source.length;) {
    if (res.destroyed || res.writableEnded) return false;
    let end = Math.min(source.length, offset + chunkSize);
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end -= 1;
    const chunk = source.slice(offset, end);
    offset = end;
    let writable;
    try { writable = res.write(chunk); }
    catch { return false; }
    if (writable) continue;
    const drained = await new Promise(resolve => {
      const cleanup = () => {
        res.removeListener('drain', onDrain);
        res.removeListener('close', onClose);
        res.removeListener('error', onClose);
      };
      const onDrain = () => { cleanup(); resolve(true); };
      const onClose = () => { cleanup(); resolve(false); };
      res.once('drain', onDrain);
      res.once('close', onClose);
      res.once('error', onClose);
    });
    if (!drained) return false;
  }
  return true;
}

function createJobEvents({ jobSubscribers, maxJobSubscribers = MAX_JOB_SUBSCRIBERS, maxTotalSubscribers = MAX_TOTAL_JOB_SUBSCRIBERS } = {}) {
  const perJobLimit = positiveInteger(maxJobSubscribers, MAX_JOB_SUBSCRIBERS, { max: 10_000 });
  const totalLimit = positiveInteger(maxTotalSubscribers, MAX_TOTAL_JOB_SUBSCRIBERS, { max: 100_000 });
  const subscriberWrites = new WeakMap();

  function totalSubscriberCount() {
    let count = 0;
    for (const subscribers of jobSubscribers.values()) count += subscribers.size;
    return count;
  }

  function queueSubscriberEvent(res, data, { end = false, onFailure = () => {} } = {}) {
    if (res.destroyed || res.writableEnded) return false;
    const bytes = Buffer.byteLength(String(data || ''), 'utf8');
    let state = subscriberWrites.get(res);
    if (!state) {
      state = { tail: Promise.resolve(), queuedBytes: 0, closed: false };
      subscriberWrites.set(res, state);
    }
    if (bytes > MAX_SUBSCRIBER_BUFFER_BYTES) {
      state.closed = true;
      onFailure();
      const errorEvent = `event: update\ndata: ${JSON.stringify({ status: 'error', error: { message: '任务事件过大，请改用任务查询接口获取结果' } })}\n\n`;
      try { res.end(errorEvent); } catch {}
      return false;
    }
    if (state.closed || (state.queuedBytes > 0 && state.queuedBytes + bytes > MAX_SUBSCRIBER_BUFFER_BYTES)) {
      state.closed = true;
      onFailure();
      try { res.end(); } catch {}
      return false;
    }
    state.queuedBytes += bytes;
    state.tail = state.tail.then(async () => {
      if (state.closed) return;
      const written = await writeWithBackpressure(res, data);
      if (!written) throw new Error('subscriber closed');
      res.flushHeaders?.();
      if (end) {
        state.closed = true;
        res.end();
      }
    }).catch(() => {
      state.closed = true;
      onFailure();
      try { res.end(); } catch {}
    }).finally(() => {
      state.queuedBytes = Math.max(0, state.queuedBytes - bytes);
      if (state.closed && state.queuedBytes === 0) subscriberWrites.delete(res);
    });
    return true;
  }

  function notifyJob(job) {
    const subscribers = jobSubscribers.get(job.id);
    if (!subscribers) return;
    const data = `event: update\ndata: ${JSON.stringify(publicJob(job, { live: true }))}\n\n`;
    for (const res of [...subscribers]) {
      if (res.destroyed || res.writableEnded || Number(res.writableLength || 0) > MAX_SUBSCRIBER_BUFFER_BYTES) {
        subscribers.delete(res);
        try { res.end(); } catch {}
        continue;
      }
      queueSubscriberEvent(res, data, {
        end: job.status === 'done' || job.status === 'error',
        onFailure: () => subscribers.delete(res),
      });
    }
    if (Number.isFinite(job.firstTokenMs) && job.firstTokenMs >= 0 && !job.firstTokenNotified) job.firstTokenNotified = true;
    delete job.streamDelta;
    if (job.status === 'done' || job.status === 'error') {
      jobSubscribers.delete(job.id);
    } else if (!subscribers.size) {
      jobSubscribers.delete(job.id);
    }
  }

  function subscribeJob(req, res, store) {
    const id = req.jobId || getJobIdFromUrl(req);
    const job = store.get(id);
    safeLog('[subscribeJob]', { id, found: !!job, path: redactUrl(req.url) });
    if (!job) {
      res.writeHead(200, applyResponseHeaders(res, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' }));
      queueSubscriberEvent(res, `event: update\ndata: ${JSON.stringify({ status: 'error', error: { message: '任务不存在或服务已重启' } })}\n\n`, { end: true });
      return;
    }
    res.writeHead(200, applyResponseHeaders(res, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    }));
    const initialData = `event: update\ndata: ${JSON.stringify(compactResumeSnapshot(job, req))}\n\n`;
    if (job.status === 'done' || job.status === 'error') {
      queueSubscriberEvent(res, initialData, { end: true });
      return;
    }
    const subscribers = jobSubscribers.get(id) || new Set();
    if (subscribers.size >= perJobLimit) {
      queueSubscriberEvent(res, `event: update\ndata: ${JSON.stringify({ status: 'error', error: { message: '任务事件订阅过多，请稍后重试' } })}\n\n`, { end: true });
      return;
    }
    if (totalSubscriberCount() >= totalLimit) {
      queueSubscriberEvent(res, `event: update\ndata: ${JSON.stringify({ status: 'error', error: { message: 'Service subscriber capacity reached; retry later' } })}\n\n`, { end: true });
      return;
    }
    if (!jobSubscribers.has(id)) jobSubscribers.set(id, subscribers);
    subscribers.add(res);
    const cleanup = () => {
      const set = jobSubscribers.get(id);
      if (!set) return;
      set.delete(res);
      if (!set.size) jobSubscribers.delete(id);
    };
    req.once('close', cleanup);
    res.once('close', cleanup);
    queueSubscriberEvent(res, initialData, { onFailure: cleanup });
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

  function disposeJob(store, id, message = '会话已删除，任务已清理') {
    const job = store.get(id);
    if (job && job.status !== 'done' && job.status !== 'error') abortJob(store, id, message);
    else {
      const subscribers = jobSubscribers.get(id);
      if (subscribers) {
        for (const res of subscribers) {
          try { res.end(); } catch {}
        }
        jobSubscribers.delete(id);
      }
    }
    store.delete(id);
    return job || null;
  }

  return { notifyJob, subscribeJob, abortJob, disposeJob };
}

module.exports = { getJobIdFromUrl, publicJob, compactResumeSnapshot, createJobEvents, writeWithBackpressure, MAX_JOB_SUBSCRIBERS, MAX_TOTAL_JOB_SUBSCRIBERS, MAX_SUBSCRIBER_BUFFER_BYTES };
