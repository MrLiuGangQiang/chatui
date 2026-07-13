const { getJobIdFromUrl, isAbortJobUrl, isJobEventsUrl } = require('../../jobs/job-url');

function createJobRouteHandler({ basePath, store, sendJson, sendMethodNotAllowed, abortJob, disposeJob, publicJob, subscribeJob, startJob, getJob }) {
  function abortJobByUrl(req, res) {
    const id = getJobIdFromUrl(req);
    const job = abortJob(store, id);
    if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
    return sendJson(res, 200, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
  }

  function disposeJobByUrl(req, res) {
    const id = getJobIdFromUrl(req);
    const job = disposeJob(store, id);
    return sendJson(res, 200, { disposed: true, existed: !!job }, { 'Access-Control-Allow-Origin': '*' });
  }

  return function routeJob(req, res) {
    if (req.url === basePath) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res);
      return startJob(req, res);
    }
    if (!req.url.startsWith(`${basePath}/`)) return false;
    if (req.method === 'POST' && isAbortJobUrl(req.url)) return abortJobByUrl(req, res);
    if (req.method === 'DELETE' && !isAbortJobUrl(req.url) && !isJobEventsUrl(req.url)) return disposeJobByUrl(req, res);
    if (req.method !== 'GET') return sendMethodNotAllowed(res);
    if (isJobEventsUrl(req.url)) return subscribeJob(req, res, store);
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
