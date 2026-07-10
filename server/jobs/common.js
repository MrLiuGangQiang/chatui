const { sendJson } = require('../http/response');
const { readBody, parseJson } = require('../http/body');
const { normalizeExtraHeaders } = require('../proxy/headers');
const { DEFAULT_UPSTREAM_BASE_URL } = require('../config');
const { Agent, ProxyAgent } = require('undici');
const { safeLog, redactUrl } = require('../logging/safe-log');
const { normalizeBaseUrl, assertResolvedUpstreamUrl, createPublicLookup, privateUpstreamAllowed } = require('../security/url-policy');
const { getJobIdFromUrl, publicJob, createJobEvents } = require('./events');

const CHAT_BODY_BYTES = 2 * 1024 * 1024;
const CHAT_VISUAL_BODY_BYTES = 12 * 1024 * 1024;
const IMAGE_BODY_BYTES = 50 * 1024 * 1024;
const PUBLIC_UPSTREAM_DISPATCHER = new Agent({ connect: { lookup: createPublicLookup({ allowPrivate: false }) } });
let proxyDispatcher = null;
let proxyDispatcherUrl = '';

function configuredUpstreamProxyUrl() {
  return String(
    process.env.CHATUI_UPSTREAM_PROXY ||
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || ''
  ).trim();
}

function upstreamDispatcher({ allowPrivate = false } = {}) {
  // Private upstreams are opt-in and continue to use the direct connection path.
  // A configured proxy is only used for public endpoints that have already passed
  // the URL policy check below.
  const proxyUrl = allowPrivate ? '' : configuredUpstreamProxyUrl();
  if (!proxyUrl) return PUBLIC_UPSTREAM_DISPATCHER;
  if (proxyDispatcher && proxyDispatcherUrl === proxyUrl) return proxyDispatcher;
  try {
    const parsed = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('only HTTP(S) proxy URLs are supported');
    proxyDispatcher = new ProxyAgent({ uri: parsed.toString() });
    proxyDispatcherUrl = proxyUrl;
    safeLog('[upstream-proxy] enabled', { protocol: parsed.protocol, host: parsed.host }, { always: true });
    return proxyDispatcher;
  } catch (err) {
    safeLog('[upstream-proxy] ignored invalid configuration', { message: err?.message || String(err) }, { always: true });
    return PUBLIC_UPSTREAM_DISPATCHER;
  }
}

function makeJobId(value = '') {
  const supplied = String(value || '').trim();
  if (/^(imgjob|chatjob)-[a-z0-9-]{8,80}$/i.test(supplied)) return supplied;
  return `imgjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function hasVisualChatAttachment(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasVisualChatAttachment(item, seen));
  const type = String(value.type || value.mimeType || value.media_type || '').toLowerCase();
  const url = String(value.url || value.dataUrl || value.data_url || '').toLowerCase();
  if (type.startsWith('image/') || type === 'image_url' || url.startsWith('data:image/')) return true;
  return Object.values(value).some((item) => hasVisualChatAttachment(item, seen));
}

async function extractProxyRequest(req, res) {
  let body;
  try {
    const isImageJob = String(req?.url || '').startsWith('/api/image-jobs');
    // Read visual chat requests with a bounded larger ceiling, then reject oversized plain chat below.
    // This lets upload and quoted-image requests use the identical chat payload contract.
    body = parseJson(await readBody(req, { maxBytes: isImageJob ? IMAGE_BODY_BYTES : CHAT_VISUAL_BODY_BYTES }));
    if (!isImageJob && !hasVisualChatAttachment(body) && Buffer.byteLength(JSON.stringify(body), 'utf8') > CHAT_BODY_BYTES) {
      const err = new Error('请求体过大');
      err.statusCode = 413;
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: { message: err.message || String(err), code: err.code || 'INVALID_REQUEST_BODY' } });
    return null;
  }
  // The browser sends the configured endpoint with every request.  Keep a
  // server-side default only for legacy clients that do not send baseUrl.
  // Previously this was overwritten with a fixed gateway, which made image
  // jobs use a different upstream from the one configured by the user.
  const baseUrl = normalizeBaseUrl(body.baseUrl || DEFAULT_UPSTREAM_BASE_URL);
  const apiKey = String(body.apiKey || '').trim();
  const extraHeaders = normalizeExtraHeaders(body.headers || body.extraHeaders);
  if (!baseUrl) {
    sendJson(res, 400, { error: { message: '缺少或非法 baseUrl', code: 'INVALID_BASE_URL' } });
    return null;
  }
  return { body, baseUrl, apiKey, extraHeaders };
}

async function fetchWithValidatedRedirects(url, options, { allowPrivate = privateUpstreamAllowed(), maxRedirects = 5, fetchImpl = fetch } = {}) {
  let currentUrl = new URL(String(url));
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    if (!await assertResolvedUpstreamUrl(currentUrl, { allowPrivate })) {
      const err = new Error('上游地址解析到非公网网络或无法解析');
      err.statusCode = 400;
      err.code = 'INVALID_UPSTREAM_ADDRESS';
      throw err;
    }
    const requestOptions = { ...options, redirect: 'manual' };
    if (!allowPrivate) requestOptions.dispatcher = upstreamDispatcher({ allowPrivate });
    const response = await fetchImpl(currentUrl, requestOptions);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects === maxRedirects) throw new Error('上游重定向次数过多');
    currentUrl = new URL(location, currentUrl);
  }
  throw new Error('上游重定向次数过多');
}

function readUpstreamErrorDetails(err) {
  const chain = [];
  const seen = new Set();
  let current = err;
  while (current && typeof current === 'object' && !seen.has(current) && chain.length < 6) {
    seen.add(current);
    const code = String(current.code || current.cause?.code || '').trim();
    const message = String(current.message || '').trim();
    if (code || message) chain.push({ name: String(current.name || 'Error'), ...(code ? { code } : {}), ...(message ? { message } : {}) });
    current = current.cause;
  }
  const codes = [...new Set(chain.map(item => item.code).filter(Boolean))];
  return { codes, chain };
}

function summarizeUpstreamRequest(url, { method, body, job } = {}) {
  let target = redactUrl(url);
  try {
    const parsed = new URL(String(url));
    target = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {}
  const byteLength = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : Number(body?.byteLength || body?.size || 0);
  const imageParts = Array.isArray(job?.payload?.messages)
    ? job.payload.messages.reduce((count, message) => count + (Array.isArray(message?.content)
      ? message.content.filter(part => part?.type === 'image_url' || part?.image_url).length
      : 0), 0)
    : 0;
  return {
    target,
    method: String(method || 'GET').toUpperCase(),
    outboundBytes: Number.isFinite(byteLength) ? byteLength : 0,
    ...(imageParts ? { imageParts } : {}),
  };
}

function createUpstreamFetch(url, { method, headers, body, job, upstreamTimeoutMs }) {
  const controller = new AbortController();
  if (job) job.controller = controller;
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
  const request = summarizeUpstreamRequest(url, { method, body, job });
  const response = fetchWithValidatedRedirects(url, { method, headers, body, signal: controller.signal })
    .catch(err => {
      safeLog('[upstream-request] failed', { ...request, ...readUpstreamErrorDetails(err) }, { always: true });
      throw err;
    });
  return { response, controller, timer };
}

function safeParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function respondJobError(res, err) {
  sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
}

function normalizeUpstreamErrorMessage(err, { aborted = false } = {}) {
  if (aborted || err?.name === 'AbortError') return '\u4e0a\u6e38\u8bf7\u6c42\u8d85\u65f6';
  const details = readUpstreamErrorDetails(err);
  const code = details.codes[0] || '';
  const message = String(err?.message || err || '').trim();
  if (code === 'ECONNRESET') return '\u8fde\u63a5\u4e0a\u6e38\u63a5\u53e3\u5931\u8d25\uff08ECONNRESET\uff09\uff1a\u4e0a\u6e38\u6216\u4e2d\u95f4\u4ee3\u7406\u5728\u4f20\u8f93\u4e2d\u91cd\u7f6e\u4e86\u8fde\u63a5\u3002\u6587\u672c\u6b63\u5e38\u4f46\u5e26\u56fe\u7247\u5931\u8d25\u65f6\uff0c\u8bf7\u68c0\u67e5 Docker \u51fa\u7ad9\u4ee3\u7406\u3001WAF \u6216\u7f51\u5173\u5bf9\u5927\u8bf7\u6c42\u4f53\u7684\u9650\u5236\u3002';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `\u8fde\u63a5\u4e0a\u6e38\u63a5\u53e3\u5931\u8d25\uff08${code}\uff09\uff1aDocker \u5bb9\u5668\u8fde\u63a5\u4e0a\u6e38\u8d85\u65f6\uff0c\u8bf7\u68c0\u67e5\u5bb9\u5668\u7f51\u7edc\u3001\u51fa\u7ad9\u4ee3\u7406\u548c\u4e0a\u6e38\u7f51\u5173\u3002`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `\u8fde\u63a5\u4e0a\u6e38\u63a5\u53e3\u5931\u8d25\uff08${code}\uff09\uff1aDocker \u5bb9\u5668\u65e0\u6cd5\u89e3\u6790\u4e0a\u6e38\u57df\u540d\uff0c\u8bf7\u68c0\u67e5\u5bb9\u5668 DNS \u914d\u7f6e\u3002`;
  if (code === 'ECONNREFUSED') return '\u8fde\u63a5\u4e0a\u6e38\u63a5\u53e3\u5931\u8d25\uff08ECONNREFUSED\uff09\uff1a\u4e0a\u6e38\u6216\u5bb9\u5668\u51fa\u7ad9\u4ee3\u7406\u62d2\u7edd\u8fde\u63a5\uff0c\u8bf7\u68c0\u67e5\u4ee3\u7406\u5730\u5740\u3001\u7aef\u53e3\u548c\u5bb9\u5668\u7f51\u7edc\u3002';
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(`${message} ${details.codes.join(' ')}`)) {
    return `\u8fde\u63a5\u4e0a\u6e38\u63a5\u53e3\u5931\u8d25${code ? `\uff08${code}\uff09` : ''}\uff1aEndpoint \u5730\u5740\u4e0d\u53ef\u8fbe\u6216\u7f51\u7edc\u8fde\u63a5\u88ab\u62d2\u7edd\uff0c\u8bf7\u68c0\u67e5 Endpoint Base URL\u3001\u7aef\u53e3\u548c\u4ee3\u7406\u670d\u52a1\u662f\u5426\u53ef\u7528`;
  }
  if (/circuit breaker|skip candidate|raw request middleware/i.test(message)) {
    return '\u4e0a\u6e38\u63a5\u53e3\u6682\u65f6\u4e0d\u53ef\u7528\uff1a\u8bf7\u6c42\u88ab\u4e0a\u6e38\u7194\u65ad\u6216\u5019\u9009\u901a\u9053\u8df3\u8fc7\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u6216\u68c0\u67e5 Endpoint \u670d\u52a1\u72b6\u6001';
  }
  return `\u8fde\u63a5\u4e0a\u6e38\u63a5\u53e3\u5931\u8d25\uff1a${message || '\u672a\u77e5\u9519\u8bef'}`;
}

function findJobOr404(store, id, res) {
  const job = store.get(id);
  if (!job) sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
  return job;
}

module.exports = { CHAT_BODY_BYTES, CHAT_VISUAL_BODY_BYTES, IMAGE_BODY_BYTES, hasVisualChatAttachment, makeJobId, getJobIdFromUrl, publicJob, createJobEvents, extractProxyRequest, configuredUpstreamProxyUrl, upstreamDispatcher, fetchWithValidatedRedirects, readUpstreamErrorDetails, summarizeUpstreamRequest, createUpstreamFetch, safeParseJson, respondJobError, normalizeUpstreamErrorMessage, findJobOr404 };
