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
    if (typeof res.getCapturedStatus === 'function') return res;
    const origWriteHead = res.writeHead.bind(res);
    let capturedStatus = Number(res.statusCode) || 200;
    let wroteHead = false;
    res.writeHead = function (code, ...args) {
      wroteHead = true;
      capturedStatus = Number(code) || capturedStatus;
      res.statusCode = capturedStatus;
      return origWriteHead(code, ...args);
    };
    res.getCapturedStatus = () => wroteHead ? capturedStatus : Number(res.statusCode) || capturedStatus || 200;
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

    // Attach trace context so downstream handlers can correlate spans.
    req._traceId = reqTraceId;
    req._rootTraceId = reqTraceId;
    req._routeStartMs = startMs;

    instrumentResponse(res);
    let routeTag = 'unknown';
    let routeError = null;
    try {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://chatui.local').pathname;
      } catch {
        routeTag = 'bad-request';
        return send(res, 400, 'Bad Request');
      }
      req.pathname = pathname;
      routeTag = classifyRoute(pathname);

      if (req.method === 'OPTIONS') {
        routeTag = 'options';
        return send(res, 204, '', {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        });
      }

      const coreResult = routeCoreApi(req, res);
      if (coreResult !== false) {
        routeTag = String(res._routeTag || routeTag);
        res._routeTag = routeTag;
        return await coreResult;
      }

      if (pathname === '/api/chat-jobs' || pathname.startsWith('/api/chat-jobs/')) {
        return await routeChatJobs(req, res);
      }
      if (pathname === '/api/image-jobs' || pathname.startsWith('/api/image-jobs/')) {
        return await routeImageJobs(req, res);
      }
      if (pathname === '/api/usage' || pathname.startsWith('/api/usage/')) {
        return await routeUsage(req, res);
      }
      if (pathname.startsWith('/api/')) {
        return req.method !== 'POST' ? sendMethodNotAllowed(res) : await proxy(req, res);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'Method Not Allowed');
      return await serveStatic(req, res, { root, rootWithSep });
    } catch (error) {
      routeError = error;
      throw error;
    } finally {
      const capturedStatus = res.getCapturedStatus ? res.getCapturedStatus() : (res.statusCode || 200);
      const statusCode = routeError && Number(capturedStatus) < 400
        ? Number(routeError?.statusCode || routeError?.status) || 500
        : capturedStatus;
      const reportAccessLogFailure = error => {
        try {
          errorLog?.log?.(error, { source: 'access-log', route: routeTag, traceId: reqTraceId });
        } catch (loggingError) {
          console.error('[router] failed to report access-log failure', {
            name: String(loggingError?.name || 'Error'),
            code: String(loggingError?.code || 'ACCESS_LOG_ERROR_REPORT_FAILED'),
          });
        }
      };
      try {
        const logged = accessLog?.log(req, res, {
          statusCode,
          durationMs: performance.now() - startMs,
          route: routeTag,
          traceId: reqTraceId,
        });
        if (accessLog && accessLog.enabled !== false && logged === false) {
          const error = new Error('Access log write failed');
          error.code = 'ACCESS_LOG_WRITE_FAILED';
          reportAccessLogFailure(error);
        }
      } catch (error) {
        reportAccessLogFailure(error);
      }
    }
  };
}

module.exports = { createRouter };
