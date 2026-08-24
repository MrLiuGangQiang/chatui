const http = require('http');
const { APP_VERSION, BUILD_IDENTITY, ROOT, ROOT_WITH_SEP, UPSTREAM_TIMEOUT_MS, CONTEXT_WINDOW_TOKENS, PROVIDER_CAPABILITIES, ALLOWED_PROXY_METHODS, ALLOWED_PROXY_PATHS, readPublicConfig } = require('./config');
const { createJobStores, startJobSweeper } = require('./jobs/store');
const { createIdempotencyTable } = require('./validators/idempotency.validator');
const { serveStatic } = require('./http/static');
const { send, sendJson, sendMethodNotAllowed } = require('./http/response');
const { createJobHandlers } = require('./jobs/chat-image');
const { closeJobSubscribers } = require('./jobs/events');
const { createImageBatchJobHandlers } = require('./jobs/image-batch');
const { createOpenAiProxy } = require('./proxy/openai');
const { createRouter } = require('./api/router');
const { createPostgresConfig, createPostgresPool } = require('./db/postgres');
const { createUsageStatsRepository } = require('./usage/stats-repository');
const { createDingTalkFeedbackSender } = require('./services/dingtalk-feedback.service');
const { createFeedbackReviewer } = require('./services/feedback-review.service');
const { createUsageAccessValidator } = require('./services/usage-access.service');
const { readReleaseNotes } = require('./services/release-notes.service');
const { readAnnouncements } = require('./services/announcements.service');
const { createLoggers } = require('./logging');
const { createRequestPrincipalService } = require('./security/request-principal');

function createApp() {
  const loggers = createLoggers({ root: ROOT });
  const { accessLog, errorLog, serverLog, requestTrace, newTrace } = loggers;
  const requestPrincipal = createRequestPrincipalService();
  const postgresConfig = createPostgresConfig();
  const postgresPool = createPostgresPool(postgresConfig);
  const usageStats = postgresPool ? createUsageStatsRepository(postgresPool) : null;
  const feedbackSender = createDingTalkFeedbackSender();
  const feedbackReviewer = createFeedbackReviewer();
  const usageAccessValidator = createUsageAccessValidator();
  const jobSubscribers = new Map();
  // Late-bound so the job stores can be created before the job handlers that
  // own notifyJob. A store evicting a still-running job (TTL timeout or the
  // max-jobs bound) must surface a terminal state to its SSE subscribers;
  // without this the subscription hangs until client-side polling
  // rediscovers the job is gone.
  const jobEviction = { notify: null };
  const handleJobEvicted = (job, reason, store) => {
    const evictionError = new Error(`job evicted from ${store?.name || 'unknown'} store: ${reason}`);
    evictionError.code = 'JOB_EVICTED';
    errorLog.log(evictionError, { source: 'job-store', jobId: String(job?.id || ''), reason: String(reason || '') });
    try { jobEviction.notify?.(job); } catch {}
  };
  const { imageJobs, chatJobs, imageBatchJobs } = createJobStores({ onEvict: handleJobEvicted });
  const sweeper = startJobSweeper([imageJobs, chatJobs, imageBatchJobs]);
  const idempotencyTable = createIdempotencyTable();
  const jobHandlers = createJobHandlers({ imageJobs, chatJobs, jobSubscribers, upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS, contextWindowTokens: CONTEXT_WINDOW_TOKENS, requestTrace, errorLog, idempotencyTable, providerCapabilities: PROVIDER_CAPABILITIES });
  const {
    makeChatJob,
    abortJob,
    disposeJob,
    publicJob,
    notifyJob,
    subscribeJob,
    startImageJob,
    getImageJob,
    registerChatStreamJob,
    startChatJob,
    getChatJob,
    updateChatJobFromStreamChunk,
  } = jobHandlers;
  jobEviction.notify = notifyJob;
  const imageBatchHandlers = createImageBatchJobHandlers({
    imageJobs,
    imageBatchJobs,
    jobSubscribers,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    requestTrace,
    errorLog,
    idempotencyTable,
    providerCapabilities: PROVIDER_CAPABILITIES,
    notifyJob,
  });
  const {
    startImageBatchJob,
    getImageBatchJob,
    subscribeImageBatchJob,
    abortImageBatchJob,
    disposeImageBatchJob,
    publicImageBatchJob,
  } = imageBatchHandlers;
  const { proxy, proxyImage } = createOpenAiProxy({
    chatJobs,
    makeChatJob,
    notifyJob,
    updateChatJobFromStreamChunk,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    contextWindowTokens: CONTEXT_WINDOW_TOKENS,
    allowedProxyMethods: ALLOWED_PROXY_METHODS,
    allowedProxyPaths: ALLOWED_PROXY_PATHS,
    requestTrace,
    errorLog,
  });
  const route = createRouter({
    appVersion: APP_VERSION,
    buildIdentity: BUILD_IDENTITY,
    readPublicConfig,
    // Logging
    accessLog,
    errorLog,
    serverLog,
    requestTrace,
    newTrace,
    requestPrincipal,
    readChangelog: () => readReleaseNotes({ root: ROOT }),
    readAnnouncements: () => readAnnouncements({ root: ROOT }),
    send,
    sendJson,
    sendMethodNotAllowed,
    serveStatic,
    root: ROOT,
    rootWithSep: ROOT_WITH_SEP,
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
    imageBatchJobs,
    startImageBatchJob,
    getImageBatchJob,
    publicImageBatchJob,
    subscribeImageBatchJob,
    abortImageBatchJob,
    disposeImageBatchJob,
    usageStats,
    usageAccessValidator,
    feedbackReviewer,
    feedbackSender,
  });
  const server = http.createServer(route);

  // Long-lived SSE subscriptions would otherwise keep server.close() waiting
  // until the upstream job finishes. End them before delegating to Node's
  // close so local restarts and container graceful shutdown are prompt.
  const originalClose = server.close.bind(server);
  let closeLogsPromise = null;
  function closeLogsOnce() {
    if (!closeLogsPromise) closeLogsPromise = Promise.resolve().then(() => loggers.close());
    return closeLogsPromise;
  }
  server.close = function closeServer(callback) {
    closeJobSubscribers(jobSubscribers);
    return originalClose(error => {
      closeLogsOnce().then(
        () => callback?.(error),
        loggingError => {
          console.error('[logging] graceful close failed:', loggingError?.message || loggingError);
          callback?.(error || loggingError);
        },
      );
    });
  };

  serverLog.started({ host: '0.0.0.0', port: 8765 });

  server.on('close', () => {
    serverLog.stopped({ reason: 'server.close' });
    clearInterval(sweeper);
    postgresPool?.end?.().catch(err => {
      console.error('[postgres] failed to close pool:', err);
      errorLog.log(err, { source: 'postgres' });
    });
  });
  return { server, stores: { imageJobs, chatJobs, imageBatchJobs }, sweeper, requestTrace, accessLog, errorLog, serverLog, flushLogs: loggers.flush, closeLogs: closeLogsOnce };
}

module.exports = { createApp };
