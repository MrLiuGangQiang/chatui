const { sendJson } = require('../http/response');
const { readBody, parseJson } = require('../http/body');
const { normalizeExtraHeaders } = require('../proxy/headers');
const { DEFAULT_UPSTREAM_BASE_URL } = require('../config');
const { Agent } = require('undici');
const { normalizeBaseUrl, assertResolvedUpstreamUrl, createPublicLookup, privateUpstreamAllowed } = require('../security/url-policy');
const { getJobIdFromUrl, publicJob, createJobEvents } = require('./events');

const CHAT_BODY_BYTES = 2 * 1024 * 1024;
const CHAT_VISUAL_BODY_BYTES = 12 * 1024 * 1024;
const IMAGE_BODY_BYTES = 50 * 1024 * 1024;
const PUBLIC_UPSTREAM_DISPATCHER = new Agent({ connect: { lookup: createPublicLookup({ allowPrivate: false }) } });

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
    if (!allowPrivate) requestOptions.dispatcher = PUBLIC_UPSTREAM_DISPATCHER;
    const response = await fetchImpl(currentUrl, requestOptions);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects === maxRedirects) throw new Error('上游重定向次数过多');
    currentUrl = new URL(location, currentUrl);
  }
  throw new Error('上游重定向次数过多');
}

function createUpstreamFetch(url, { method, headers, body, job, upstreamTimeoutMs }) {
  const controller = new AbortController();
  if (job) job.controller = controller;
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
  const response = fetchWithValidatedRedirects(url, { method, headers, body, signal: controller.signal });
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
  if (aborted || err?.name === 'AbortError') return '上游请求超时';
  const message = String(err?.message || err || '').trim();
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(message)) {
    return '连接上游接口失败：Endpoint 地址不可达或网络连接被拒绝，请检查 Endpoint Base URL、端口和代理服务是否可用';
  }
  if (/circuit breaker|skip candidate|raw request middleware/i.test(message)) {
    return '上游接口暂时不可用：请求被上游熔断或候选通道跳过，请稍后重试或检查 Endpoint 服务状态';
  }
  return `连接上游接口失败：${message || '未知错误'}`;
}

function findJobOr404(store, id, res) {
  const job = store.get(id);
  if (!job) sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
  return job;
}

module.exports = { CHAT_BODY_BYTES, CHAT_VISUAL_BODY_BYTES, IMAGE_BODY_BYTES, hasVisualChatAttachment, makeJobId, getJobIdFromUrl, publicJob, createJobEvents, extractProxyRequest, fetchWithValidatedRedirects, createUpstreamFetch, safeParseJson, respondJobError, normalizeUpstreamErrorMessage, findJobOr404 };
