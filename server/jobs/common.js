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
  if (aborted || err?.name === 'AbortError') return '上游请求超时';
  const upstreamStatus = Number(err?.upstreamStatus || err?.statusCode || 0);
  if (upstreamStatus === 401) return '上游拒绝了该请求（HTTP 401）：当前 API Key 未被该 Endpoint 接受，请确认 Key 的权限、所属渠道和有效期';
  if (upstreamStatus === 403) return '上游拒绝了该请求（HTTP 403）：当前 API Key 或账号没有访问此模型/图片能力的权限';
  if (upstreamStatus === 429) return '上游请求过于频繁或额度已用尽（HTTP 429），请稍后重试或检查账户额度';
  const details = readUpstreamErrorDetails(err);
  const code = details.codes[0] || '';
  const message = String(err?.message || err || '').trim();
  if (/\b401\b|unauthorized|invalid api key|incorrect api key|authentication|authentication_error/i.test(message)) {
    return '上游拒绝了该请求（HTTP 401）：当前 API Key 未被该 Endpoint 接受，请确认 Key 的权限、所属渠道和有效期';
  }
  if (/\b403\b|forbidden|permission denied|insufficient[_ ]permissions?/i.test(message)) {
    return '上游拒绝了该请求（HTTP 403）：当前 API Key 或账号没有访问此模型/图片能力的权限';
  }
  if (/\b429\b|rate limit|quota|insufficient[_ ]quota/i.test(message)) {
    return '上游请求过于频繁或额度已用尽（HTTP 429），请稍后重试或检查账户额度';
  }
  if (code === 'ECONNRESET') return '连接上游接口失败（ECONNRESET）：上游或中间代理在传输中重置了连接。文本正常但带图片失败时，请检查 Docker 出站代理、WAF 或网关对大请求体的限制。';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `连接上游接口失败（${code}）：Docker 容器连接上游超时，请检查容器网络、出站代理和上游网关。`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `连接上游接口失败（${code}）：Docker 容器无法解析上游域名，请检查容器 DNS 配置。`;
  if (code === 'ECONNREFUSED') return '连接上游接口失败（ECONNREFUSED）：上游或容器出站代理拒绝连接，请检查代理地址、端口和容器网络。';
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(`${message} ${details.codes.join(' ')}`)) {
    return `连接上游接口失败${code ? `（${code}）` : ''}：Endpoint 地址不可达或网络连接被拒绝，请检查 Endpoint Base URL、端口和代理服务是否可用`;
  }
  if (/circuit breaker|skip candidate|raw request middleware/i.test(message)) {
    return '上游接口暂时不可用：请求被上游熔断或候选通道跳过，请稍后重试或检查 Endpoint 服务状态';
  }
  return `上游请求失败：${message || '未知错误'}`;
}

function findJobOr404(store, id, res) {
  const job = store.get(id);
  if (!job) sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
  return job;
}

module.exports = { CHAT_BODY_BYTES, CHAT_VISUAL_BODY_BYTES, IMAGE_BODY_BYTES, hasVisualChatAttachment, makeJobId, getJobIdFromUrl, publicJob, createJobEvents, extractProxyRequest, configuredUpstreamProxyUrl, upstreamDispatcher, fetchWithValidatedRedirects, readUpstreamErrorDetails, summarizeUpstreamRequest, createUpstreamFetch, safeParseJson, respondJobError, normalizeUpstreamErrorMessage, findJobOr404 };
