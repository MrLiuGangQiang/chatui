const { SECURITY_HEADERS } = require('../http/response');
const { safeLog, redactUrl } = require('../logging/safe-log');
const { getJobIdFromUrl } = require('./job-url');
const { findOwnedJob, jobOwnedBy } = require('../security/job-ownership');
const { JOB_NOT_FOUND_MESSAGE, JOB_SSE_HEADERS } = require('./http-contract');
const { requestJobCancellation } = require('./cancellation');
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
    payload.status = job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : 'running';

    if (job.status === 'done') payload.done = 1;

    if (job.status === 'error') {
      const message = job.error || '任务失败';
      payload.e = message;
      payload.error = { message };
    }

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
    const terminal = job.status === 'done' || job.status === 'error';
    let delivered = false;
    for (const subscriber of [...subscribers]) {
      if (subscriber?.job !== job) continue;
      const res = subscriber.res;
      if (!res || !jobOwnedBy(job, subscriber.principal)) {
        subscribers.delete(subscriber);
        try { res?.end(); } catch {}
        continue;
      }
      try {
        res.write(data);
        res.flushHeaders?.();
        delivered = true;
      } catch {
        subscribers.delete(subscriber);
        try { res.end(); } catch {}
        continue;
      }
      if (terminal) {
        subscribers.delete(subscriber);
        try { res.end(); } catch {}
      }
    }
    if (delivered && Number.isFinite(job.firstTokenMs) && job.firstTokenMs >= 0 && !job.firstTokenNotified) job.firstTokenNotified = true;
    delete job.streamDelta;
    if (!subscribers.size) jobSubscribers.delete(job.id);
  }

  function subscribeJob(req, res, store) {
    const id = getJobIdFromUrl(req);
    const job = findOwnedJob(store, id, req.authPrincipal);
    safeLog('[subscribeJob]', { id, found: !!job, path: redactUrl(req.url) });
    if (!job) {
      res.writeHead(200, { ...SECURITY_HEADERS, ...JOB_SSE_HEADERS });
      res.write(`event: update\ndata: ${JSON.stringify({ status: 'error', error: { message: JOB_NOT_FOUND_MESSAGE } })}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      ...JOB_SSE_HEADERS,
    });
    res.write(`event: update\ndata: ${JSON.stringify(compactResumeSnapshot(job, req))}\n\n`);
    res.flushHeaders?.();
    if (job.status === 'done' || job.status === 'error') return res.end();
    if (!jobSubscribers.has(id)) jobSubscribers.set(id, new Set());
    const subscriber = { res, principal: req.authPrincipal, job };
    jobSubscribers.get(id).add(subscriber);
    req.on('close', () => {
      const set = jobSubscribers.get(id);
      if (!set) return;
      set.delete(subscriber);
      if (!set.size) jobSubscribers.delete(id);
    });
  }

  function abortJob(store, id, principal, message = '任务已停止') {
    const job = findOwnedJob(store, id, principal);
    if (!job) return null;
    if (job.status === 'done' || job.status === 'error') return job;
    requestJobCancellation(job, { message, reason: 'user_stop', code: 'JOB_STOPPED' });
    job.status = 'error';
    job.error = message;
    job.updatedAt = Date.now();
    notifyJob(job);
    return job;
  }

  function disposeJob(store, id, principal, message = '会话已删除，任务已清理') {
    const job = findOwnedJob(store, id, principal);
    if (!job) return null;
    if (job.status !== 'done' && job.status !== 'error') abortJob(store, id, principal, message);
    else {
      const subscribers = jobSubscribers.get(id);
      if (subscribers) {
        for (const subscriber of [...subscribers]) {
          if (subscriber?.job !== job) continue;
          subscribers.delete(subscriber);
          try { subscriber.res?.end(); } catch {}
        }
        if (!subscribers.size) jobSubscribers.delete(id);
      }
    }
    store.delete(id);
    return job;
  }

  return { notifyJob, subscribeJob, abortJob, disposeJob };
}

function closeJobSubscribers(jobSubscribers) {
  if (!jobSubscribers) return 0;
  let closed = 0;
  for (const subscribers of jobSubscribers.values()) {
    if (!subscribers) continue;
    for (const subscriber of [...subscribers]) {
      subscribers.delete(subscriber);
      try { subscriber?.res?.end?.(); } catch {}
      closed += 1;
    }
  }
  jobSubscribers.clear();
  return closed;
}

module.exports = { getJobIdFromUrl, publicJob, compactResumeSnapshot, createJobEvents, closeJobSubscribers };
