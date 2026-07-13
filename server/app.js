const http = require('http');
const { APP_VERSION, ROOT, ROOT_WITH_SEP, UPSTREAM_TIMEOUT_MS, CONTEXT_WINDOW_TOKENS, ALLOWED_PROXY_METHODS, ALLOWED_PROXY_PATHS, readPublicConfig } = require('./config');
const { createJobStores, startJobSweeper } = require('./jobs/store');
const { extractFileText } = require('./extract');
const { serveStatic } = require('./http/static');
const { send, sendJson, sendMethodNotAllowed } = require('./http/response');
const { createJobHandlers } = require('./jobs/chat-image');
const { createOpenAiProxy } = require('./proxy/openai');
const { createRouter } = require('./api/router');
const { createPostgresConfig, createPostgresPool } = require('./db/postgres');
const { createUsageStatsRepository } = require('./usage/stats-repository');
const { createDingTalkFeedbackSender } = require('./services/dingtalk-feedback.service');
const { createUsageAccessValidator } = require('./services/usage-access.service');

function createApp() {
  const postgresConfig = createPostgresConfig();
  const postgresPool = createPostgresPool(postgresConfig);
  const usageStats = postgresPool ? createUsageStatsRepository(postgresPool) : null;
  const feedbackSender = createDingTalkFeedbackSender();
  const usageAccessValidator = createUsageAccessValidator();
  const { imageJobs, chatJobs } = createJobStores();
  const jobSubscribers = new Map();
  const sweeper = startJobSweeper([imageJobs, chatJobs]);
  const jobHandlers = createJobHandlers({ imageJobs, chatJobs, jobSubscribers, upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS, contextWindowTokens: CONTEXT_WINDOW_TOKENS });
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
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    contextWindowTokens: CONTEXT_WINDOW_TOKENS,
    allowedProxyMethods: ALLOWED_PROXY_METHODS,
    allowedProxyPaths: ALLOWED_PROXY_PATHS,
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
  const server = http.createServer(route);
  server.on('close', () => {
    clearInterval(sweeper);
    postgresPool?.end?.().catch(err => console.error('[postgres] failed to close pool:', err));
  });
  return { server, stores: { imageJobs, chatJobs }, sweeper };
}

module.exports = { createApp };
