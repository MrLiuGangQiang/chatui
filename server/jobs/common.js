const { SECURITY_HEADERS, sendJson } = require('../http/response');

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

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    data: job.data || null,
    error: job.error ? { message: job.error } : null,
  };
}

function createJobEvents({ jobSubscribers }) {
  function notifyJob(job) {
    const subscribers = jobSubscribers.get(job.id);
    if (!subscribers) return;
    const data = `event: update\ndata: ${JSON.stringify(publicJob(job))}\n\n`;
    for (const res of subscribers) {
      res.write(data);
      res.flushHeaders?.();
    }
    if (job.status === 'done' || job.status === 'error') {
      for (const res of subscribers) res.end();
      jobSubscribers.delete(job.id);
    }
  }

  function subscribeJob(req, res, store) {
    const id = getJobIdFromUrl(req);
    const job = store.get(id);
    if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: update\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
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

module.exports = { makeJobId, getJobIdFromUrl, publicJob, createJobEvents };
