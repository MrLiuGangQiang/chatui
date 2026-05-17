const http = require('http');
const { APP_VERSION, ROOT, ROOT_WITH_SEP, UPSTREAM_TIMEOUT_MS, ALLOWED_PROXY_METHODS, ALLOWED_PROXY_PATHS } = require('./config');
const { JobStore, startJobSweeper } = require('./jobs/store');
const { extractFileText } = require('./extract');
const { serveStatic } = require('./http/static');
const { send, sendJson, sendMethodNotAllowed } = require('./http/response');
const { createJobHandlers } = require('./jobs/chat-image');
const { createOpenAiProxy } = require('./proxy/openai');
const { createRouter } = require('./api/router');

function createApp() {
  const imageJobs = new JobStore('image');
  const chatJobs = new JobStore('chat');
  const jobSubscribers = new Map();
  const sweeper = startJobSweeper([imageJobs, chatJobs]);
  const jobHandlers = createJobHandlers({ imageJobs, chatJobs, jobSubscribers, upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS });
  const {
    makeChatJob,
    abortJob,
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
    allowedProxyMethods: ALLOWED_PROXY_METHODS,
    allowedProxyPaths: ALLOWED_PROXY_PATHS,
  });
  const route = createRouter({
    appVersion: APP_VERSION,
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
    publicJob,
    subscribeJob,
    startImageJob,
    getImageJob,
    registerChatStreamJob,
    startChatJob,
    getChatJob,
  });
  const server = http.createServer(route);
  server.on('close', () => clearInterval(sweeper));
  return { server, stores: { imageJobs, chatJobs }, sweeper };
}

module.exports = { createApp };
