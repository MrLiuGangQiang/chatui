const { parseJobRoute } = require('../../jobs/job-url');

function createJobRouteHandler({ basePath, store, sendJson, sendMethodNotAllowed, abortJob, disposeJob, publicJob, subscribeJob, startJob, getJob }) {
  function abortJobByUrl(req, res, id) {
    const job = abortJob(store, id);
    if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
    return sendJson(res, 200, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
  }

  function disposeJobByUrl(req, res, id) {
    const job = disposeJob(store, id);
    return sendJson(res, 200, { disposed: true, existed: !!job }, { 'Access-Control-Allow-Origin': '*' });
  }

  return function routeJob(req, res) {
    const parsed = parseJobRoute(req.url, basePath);
    if (!parsed.matched) return false;
    if (!parsed.valid) return sendJson(res, 400, { error: { message: '任务地址无效', code: 'INVALID_JOB_URL' } });
    req.jobId = parsed.id;
    if (parsed.action === 'start') {
      if (req.method !== 'POST') return sendMethodNotAllowed(res);
      return startJob(req, res);
    }
    if (parsed.action === 'abort') {
      if (req.method !== 'POST') return sendMethodNotAllowed(res);
      return abortJobByUrl(req, res, parsed.id);
    }
    if (parsed.action === 'events') {
      if (req.method !== 'GET') return sendMethodNotAllowed(res);
      return subscribeJob(req, res, store);
    }
    if (req.method === 'DELETE') return disposeJobByUrl(req, res, parsed.id);
    if (req.method !== 'GET') return sendMethodNotAllowed(res);
    return getJob(req, res);
  };
}

function createJobRoutes({ sendJson, sendMethodNotAllowed, imageJobs, chatJobs, abortJob, disposeJob, publicJob, subscribeJob, startImageJob, getImageJob, startChatJob, getChatJob }) {
  const routeChatJobs = createJobRouteHandler({
    basePath: '/api/chat-jobs',
    store: chatJobs,
    sendJson,
    sendMethodNotAllowed,
    abortJob,
    disposeJob,
    publicJob,
    subscribeJob,
    startJob: startChatJob,
    getJob: getChatJob,
  });

  const routeImageJobs = createJobRouteHandler({
    basePath: '/api/image-jobs',
    store: imageJobs,
    sendJson,
    sendMethodNotAllowed,
    abortJob,
    disposeJob,
    publicJob,
    subscribeJob,
    startJob: startImageJob,
    getJob: getImageJob,
  });

  return { routeChatJobs, routeImageJobs };
}

module.exports = { createJobRoutes, createJobRouteHandler };
