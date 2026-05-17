function createJobRoutes({ sendJson, sendMethodNotAllowed, imageJobs, chatJobs, abortJob, publicJob, subscribeJob, startImageJob, getImageJob, registerChatStreamJob, startChatJob, getChatJob }) {
  function abortJobByUrl(req, res, store) {
    const id = decodeURIComponent(req.url.split('?')[0].split('/').filter(Boolean).at(-2) || '');
    const job = abortJob(store, id);
    if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
    return sendJson(res, 200, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
  }

  function routeChatJobs(req, res) {
    if (req.url === '/api/chat-jobs') {
      if (req.method !== 'POST') return sendMethodNotAllowed(res);
      return startChatJob(req, res);
    }
    if (!req.url.startsWith('/api/chat-jobs/')) return false;
    if (req.method === 'POST' && req.url.endsWith('/abort')) return abortJobByUrl(req, res, chatJobs);
    if (req.method !== 'GET') return sendMethodNotAllowed(res);
    if (req.url.endsWith('/events')) return subscribeJob(req, res, chatJobs);
    return getChatJob(req, res);
  }

  function routeImageJobs(req, res) {
    if (req.url === '/api/image-jobs') {
      if (req.method !== 'POST') return sendMethodNotAllowed(res);
      return startImageJob(req, res);
    }
    if (!req.url.startsWith('/api/image-jobs/')) return false;
    if (req.method === 'POST' && req.url.endsWith('/abort')) return abortJobByUrl(req, res, imageJobs);
    if (req.method !== 'GET') return sendMethodNotAllowed(res);
    if (req.url.endsWith('/events')) return subscribeJob(req, res, imageJobs);
    return getImageJob(req, res);
  }

  return { routeChatJobs, routeImageJobs };
}

module.exports = { createJobRoutes };
