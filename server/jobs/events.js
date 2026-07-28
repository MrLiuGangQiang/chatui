const { SECURITY_HEADERS } = require('../http/response');
const { safeLog, redactUrl } = require('../logging/safe-log');
const { getJobIdFromUrl } = require('./job-url');
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
    safeLog('[subscribeJob]', { id, found: !!job, path: redactUrl(req.url) });
    if (!job) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: update\ndata: ${JSON.stringify({ status: 'error', error: { message: '任务不存在或服务已重启' } })}\n\n`);
      res.end();
      return;
    }
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

module.exports = { getJobIdFromUrl, publicJob, compactResumeSnapshot, createJobEvents };
