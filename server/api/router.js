'use strict';

const { createCoreRoutes } = require('./routes/core');
const { createJobRoutes } = require('./routes/jobs');
const { createUsageRoutes } = require('./routes/usage');
const { performance } = require('perf_hooks');
const { traceId } = require('../logging/logger');

function createRouter(deps) {
  const {
    appVersion,
    buildIdentity,
    readPublicConfig,
    readChangelog,
    readAnnouncements,
    send,
    sendJson,
    sendMethodNotAllowed,
    serveStatic,
    root,
    rootWithSep,
    proxy,
    proxyImage,
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
    feedbackReviewer,
    feedbackSender,
    // Logging
    accessLog,
    errorLog,
    serverLog,
    requestTrace,
    newTrace,
  } = deps;

  const { routeCoreApi } = createCoreRoutes({
    appVersion,
    buildIdentity,
    readPublicConfig,
    readChangelog,
    readAnnouncements,
    sendJson,
    sendMethodNotAllowed,
    proxyImage,
    registerChatStreamJob,
    requestTrace,
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
    feedbackReviewer,
    feedbackSender,
  });

  // Wrap res to capture the response status code for access logging
  function instrumentResponse(res) {
    const origWriteHead = res.writeHead.bind(res);
    let capturedStatus = 200;
    res.writeHead = function (code, ...args) {
      capturedStatus = code;
      return origWriteHead(code, ...args);
    };
    res.getCapturedStatus = () => capturedStatus;
    return res;
  }

  function classifyRoute(pathname) {
    if (!pathname) return 'unknown';
    if (pathname === '/api/chat-jobs' || pathname.startsWith('/api/chat-jobs/')) return 'chat-job';
    if (pathname === '/api/image-jobs' || pathname.startsWith('/api/image-jobs/')) return 'image-job';
    if (pathname === '/api/usage' || pathname.startsWith('/api/usage/')) return 'usage';
    if (pathname.startsWith('/api/')) return 'proxy';
    if (pathname.startsWith('/_core/') || pathname === '/api/core') return 'core';
    return 'static';
  }

  return async function route(req, res) {
    const startMs = performance.now();
    const reqTraceId = traceId();

    // Attach trace context so downstream handlers can correlate spans
    req._traceId = reqTraceId;
    req._rootTraceId = reqTraceId;
    req._routeStartMs = startMs;

    let pathname;
    try { pathname = new URL(req.url, 'http://chatui.local').pathname; }
    catch { return send(res, 400, 'Bad Request'); }
    req.pathname = pathname;

    instrumentResponse(res);

    if (req.method === 'OPTIONS') {
      const result = send(res, 204, '', {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      });
      accessLog?.log(req, res, { statusCode: 204, durationMs: performance.now() - startMs, route: 'options', traceId: reqTraceId });
      return result;
    }

    const coreResult = routeCoreApi(req, res);
    if (coreResult !== false) {
      res._routeTag = classifyRoute(pathname);
      // Wait for async handlers to finish before logging
      if (coreResult && typeof coreResult.then === 'function') {
        try { await coreResult; } catch { /* access log still runs below */ }
      }
      return coreResult;
    }

    let result;
    let routeTag = classifyRoute(pathname);

    if (pathname === '/api/chat-jobs' || pathname.startsWith('/api/chat-jobs/')) {
      result = await routeChatJobs(req, res);
    } else if (pathname === '/api/image-jobs' || pathname.startsWith('/api/image-jobs/')) {
      result = await routeImageJobs(req, res);
    } else if (pathname === '/api/usage' || pathname.startsWith('/api/usage/')) {
      result = await routeUsage(req, res);
    } else if (pathname.startsWith('/api/')) {
      if (req.method !== 'POST') {
        result = sendMethodNotAllowed(res);
      } else {
        result = await proxy(req, res);
      }
    } else if (!['GET', 'HEAD'].includes(req.method)) {
      result = send(res, 405, 'Method Not Allowed');
    } else {
      result = await serveStatic(req, res, { root, rootWithSep });
    }

    // Access log: record every request with timing and status
    const statusCode = res.getCapturedStatus ? res.getCapturedStatus() : (res.statusCode || 200);
    const durationMs = performance.now() - startMs;
    accessLog?.log(req, res, { statusCode, durationMs, route: routeTag, traceId: reqTraceId });

    return result;
  };
}

module.exports = { createRouter };
