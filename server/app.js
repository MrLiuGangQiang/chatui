const http = require('http');
const { APP_VERSION, ROOT, ROOT_WITH_SEP, UPSTREAM_TIMEOUT_MS, CONTEXT_WINDOW_TOKENS, ALLOWED_PROXY_METHODS, ALLOWED_PROXY_PATHS, readPublicConfig, runtimeConfig } = require('./config');
const { createJobStores, startJobSweeper } = require('./jobs/store');
const { createExtractFileText } = require('./extract');
const { createConcurrencyServices } = require('./concurrency');
const { createUpstreamRequestService } = require('./jobs/common');
const { serveStatic } = require('./http/static');
const { send, sendJson, sendMethodNotAllowed } = require('./http/response');
const { createJobHandlers } = require('./jobs/chat-image');
const { createOpenAiProxy } = require('./proxy/openai');
const { createRouter } = require('./api/router');
const { createPostgresConfig, createPostgresPool } = require('./db/postgres');
const { createUsageStatsRepository } = require('./usage/stats-repository');
const { createDingTalkFeedbackSender } = require('./services/dingtalk-feedback.service');
const { createUsageAccessValidator } = require('./services/usage-access.service');
const { createCorsPolicy } = require('./http/cors');
const { createRequestHandler } = require('./http/request-handler');
const { createAuthPolicy } = require('./security/auth');
const { createPrincipalJobAdmission } = require('./jobs/admission');

function createApp(options = {}) {
  const config = options.runtimeConfig || runtimeConfig;
  const postgresConfig = options.postgresConfig || createPostgresConfig();
  const postgresPool = options.postgresPool === undefined ? createPostgresPool(postgresConfig) : options.postgresPool;
  const usageStats = options.usageStats === undefined ? (postgresPool ? createUsageStatsRepository(postgresPool) : null) : options.usageStats;
  const feedbackSender = options.feedbackSender || createDingTalkFeedbackSender({
    accessToken: config.dingtalkFeedbackAccessToken,
    secret: config.dingtalkFeedbackSecret,
  });
  const usageAccessValidator = options.usageAccessValidator || createUsageAccessValidator();
  const jobAdmission = options.jobAdmission || createPrincipalJobAdmission(config);
  const concurrency = options.concurrencyServices || createConcurrencyServices(config);
  const upstreamRequests = options.upstreamRequests || createUpstreamRequestService({ runtimeConfig: config });
  const { imageJobs, chatJobs } = options.stores || createJobStores({
    ttlMs: config.jobTtlMs,
    runningTtlMs: config.runningJobTtlMs,
    maxJobs: config.maxJobsPerStore,
  });
  const jobSubscribers = options.jobSubscribers || new Map();
  const sweeper = options.sweeper || startJobSweeper([imageJobs, chatJobs], config.jobSweepIntervalMs);
  const extractFileText = options.extractFileText || createExtractFileText({
    extractLimiter: concurrency.extractLimiter,
    limits: {
      text: config.maxExtractTextBytes,
      pdf: config.maxExtractPdfBytes,
      office: config.maxExtractOfficeBytes,
    },
  });
  const jobHandlers = createJobHandlers({
    imageJobs,
    chatJobs,
    jobSubscribers,
    upstreamTimeoutMs: config.upstreamTimeoutMs || UPSTREAM_TIMEOUT_MS,
    contextWindowTokens: config.contextWindowTokens || CONTEXT_WINDOW_TOKENS,
    jobAdmission,
    upstreamLimiter: concurrency.upstreamLimiter,
    fetchUpstream: upstreamRequests.createUpstreamFetch,
  });
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
  const { proxy, proxyImage } = createOpenAiProxy({
    chatJobs,
    makeChatJob,
    notifyJob,
    updateChatJobFromStreamChunk,
    upstreamTimeoutMs: config.upstreamTimeoutMs || UPSTREAM_TIMEOUT_MS,
    contextWindowTokens: config.contextWindowTokens || CONTEXT_WINDOW_TOKENS,
    allowedProxyMethods: ALLOWED_PROXY_METHODS,
    allowedProxyPaths: ALLOWED_PROXY_PATHS,
    jobAdmission,
    upstreamLimiter: concurrency.upstreamLimiter,
    fetchUpstream: upstreamRequests.createUpstreamFetch,
  });
  const route = createRouter({
    appVersion: APP_VERSION,
    readPublicConfig,
    send,
    sendJson,
    sendMethodNotAllowed,
    serveStatic,
    root: ROOT,
    rootWithSep: ROOT_WITH_SEP,
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
  });
  const corsPolicy = createCorsPolicy({ origins: options.corsOrigins || config.corsOrigins });
  const authPolicy = options.authPolicy || createAuthPolicy(config);
  const requestHandler = createRequestHandler(route, { corsPolicy, authPolicy, onError: options.onRequestError });
  const server = http.createServer(requestHandler);
  let disposePromise = null;

  function dispose() {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      clearInterval(sweeper);
      imageJobs.dispose?.();
      chatJobs.dispose?.();
      jobAdmission.dispose?.();
      if (!options.concurrencyServices) concurrency.dispose?.();
      if (!options.upstreamRequests) await upstreamRequests.dispose?.();
      if (options.postgresPool === undefined) await postgresPool?.end?.();
    })();
    return disposePromise;
  }

  server.once('close', () => {
    void dispose().catch(err => console.error('[app] failed to release runtime resources:', err));
  });

  return {
    server,
    stores: { imageJobs, chatJobs },
    sweeper,
    runtime: Object.freeze({ config, concurrency, upstreamRequests, jobAdmission }),
    dispose,
  };
}

module.exports = { createApp };
