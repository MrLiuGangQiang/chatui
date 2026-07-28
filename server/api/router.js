const { createCoreRoutes } = require('./routes/core');
const { createJobRoutes } = require('./routes/jobs');
const { createUsageRoutes } = require('./routes/usage');
const { applyCorsRequestContext } = require('../http/cors');

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

  async function dispatch(req, res) {
    let pathname;
    try { pathname = new URL(req.url, 'http://chatui.local').pathname; }
    catch { return send(res, 400, 'Bad Request'); }
    req.pathname = pathname;
    const cors = applyCorsRequestContext(req, res);
    if (!cors.allowed) return sendJson(res, 403, { error: { message: 'Origin is not allowed', code: 'ORIGIN_FORBIDDEN' } });
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      });
    }

    const coreResult = routeCoreApi(req, res);
    if (coreResult !== false) return coreResult;

    if (pathname === '/api/chat-jobs' || pathname.startsWith('/api/chat-jobs/')) {
      return routeChatJobs(req, res);
    }

    if (pathname === '/api/image-jobs' || pathname.startsWith('/api/image-jobs/')) {
      return routeImageJobs(req, res);
    }

    if (pathname === '/api/usage' || pathname.startsWith('/api/usage/')) {
      return routeUsage(req, res);
    }

    if (pathname.startsWith('/api/')) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res);
      return proxy(req, res);
    }

    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'Method Not Allowed');

    return serveStatic(req, res, { root, rootWithSep });
  }

  return async function route(req, res) {
    try {
      return await dispatch(req, res);
    } catch (err) {
      console.error('[http] unhandled request failure:', err?.message || err);
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) return sendJson(res, 500, { error: { message: 'Internal Server Error', code: 'INTERNAL_ERROR' } });
      try { res.end(); } catch { res.destroy(); }
    }
  };
}

module.exports = { createRouter };
