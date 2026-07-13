const { createCoreRoutes } = require('./routes/core');
const { createJobRoutes } = require('./routes/jobs');
const { createUsageRoutes } = require('./routes/usage');

function createRouter(deps) {
  const {
    appVersion,
    readPublicConfig,
    send,
    sendJson,
    sendMethodNotAllowed,
    serveStatic,
    root,
    rootWithSep,
    proxy,
    proxyImage,
    extractFileText,
    imageJobs,
    chatJobs,
    abortJob,
    disposeJob,
    publicJob,
    subscribeJob,
    startImageJob,
    getImageJob,
    registerChatStreamJob,
    startChatJob,
    getChatJob,
    usageStats,
    usageAccessValidator,
    feedbackSender,
  } = deps;

  const { routeCoreApi } = createCoreRoutes({
    appVersion,
    readPublicConfig,
    sendJson,
    sendMethodNotAllowed,
    proxyImage,
    extractFileText,
    registerChatStreamJob,
  });

  const { routeChatJobs, routeImageJobs } = createJobRoutes({
    sendJson,
    sendMethodNotAllowed,
    imageJobs,
    chatJobs,
    abortJob,
    disposeJob,
    publicJob,
    subscribeJob,
    startImageJob,
    getImageJob,
    startChatJob,
    getChatJob,
  });

  const { routeUsage } = createUsageRoutes({
    send,
    sendJson,
    sendMethodNotAllowed,
    usageStats,
    usageAccessValidator,
    feedbackSender,
  });

  return async function route(req, res) {
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      });
    }

    const coreResult = routeCoreApi(req, res);
    if (coreResult !== false) return coreResult;

    if (req.url === '/api/chat-jobs' || req.url.startsWith('/api/chat-jobs/')) {
      return routeChatJobs(req, res);
    }

    if (req.url === '/api/image-jobs' || req.url.startsWith('/api/image-jobs/')) {
      return routeImageJobs(req, res);
    }

    if (req.url === '/api/usage' || req.url.startsWith('/api/usage/')) {
      return routeUsage(req, res);
    }

    if (req.url.startsWith('/api/')) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res);
      return proxy(req, res);
    }

    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'Method Not Allowed');

    return serveStatic(req, res, { root, rootWithSep });
  };
}

module.exports = { createRouter };
