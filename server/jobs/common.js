const { sendJson } = require('../http/response');
const { readBody, parseJson, payloadTooLargeError } = require('../http/body');
const { normalizeExtraHeaders } = require('../proxy/headers');
const { DEFAULT_UPSTREAM_BASE_URL } = require('../config');
const { Agent, ProxyAgent } = require('undici');
const { safeLog, redactUrl } = require('../logging/safe-log');
const { normalizeBaseUrl, assertResolvedUpstreamUrl, createPublicLookup, privateUpstreamAllowed } = require('../security/url-policy');
const { getJobIdFromUrl, publicJob, createJobEvents } = require('./events');
const fileInputs = require('../../shared/file-inputs');
const { findOwnedJob } = require('../security/job-ownership');
const { sendJobNotFound } = require('./http-contract');

const CHAT_BODY_BYTES = 2 * 1024 * 1024;
const CHAT_VISUAL_BODY_BYTES = 12 * 1024 * 1024;
const CHAT_FILE_BODY_BYTES = 72 * 1024 * 1024;
const MAX_FILE_INPUT_DECODED_BYTES = fileInputs.MAX_REQUEST_BYTES;
const MAX_FILE_DATA_MEDIA_TYPE_BYTES = 255;
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
  return `imgjob-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
}

function hasVisualChatAttachment(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasVisualChatAttachment(item, seen));
  const type = String(value.type || value.mimeType || value.media_type || '').toLowerCase();
  const imageUrl = value.image_url && typeof value.image_url === 'object' ? value.image_url.url : value.image_url;
  const urlPrefix = String(value.url || value.dataUrl || value.data_url || imageUrl || '').slice(0, 64).toLowerCase();
  if (type.startsWith('image/') || type === 'image_url' || type === 'input_image' || urlPrefix.startsWith('data:image/')) return true;
  return Object.values(value).some((item) => hasVisualChatAttachment(item, seen));
}

function fileInputError(message, code = 'INVALID_FILE_DATA', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isResponsesFileDataRequest(body, requestUrl = '') {
  const pathname = String(requestUrl || '').split('?')[0];
  if (/^\/api\/responses\/?$/.test(pathname)) return true;
  const isManagedChat = pathname.startsWith('/api/chat-jobs') || /^\/api\/chat-stream-jobs\/?$/.test(pathname);
  return isManagedChat && body?.api === 'responses';
}

function responsesInputFileDataParts(payload = {}) {
  if (!Array.isArray(payload?.input)) return [];
  const parts = [];
  for (const item of payload.input) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (!part || typeof part !== 'object' || part.type !== 'input_file') continue;
      if (Object.prototype.hasOwnProperty.call(part, 'file_data')) parts.push(part);
    }
  }
  return parts;
}

function inspectFileDataUri(value) {
  if (typeof value !== 'string' || value.length === 0 || value.slice(0, 5).toLowerCase() !== 'data:') {
    throw fileInputError('Responses input_file.file_data must be a base64 data URI');
  }
  const commaIndex = value.indexOf(',');
  if (commaIndex <= 5) throw fileInputError('Responses input_file.file_data must include a media type and base64 data');
  const metadata = value.slice(5, commaIndex);
  const suffix = ';base64';
  if (metadata.length > MAX_FILE_DATA_MEDIA_TYPE_BYTES + suffix.length) {
    throw fileInputError('Responses input_file.file_data has an invalid media type');
  }
  if (!metadata.toLowerCase().endsWith(suffix)) {
    throw fileInputError('Responses input_file.file_data must use base64 encoding');
  }
  const mediaType = metadata.slice(0, -suffix.length);
  const mimeToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  if (!mediaType || mediaType.length > MAX_FILE_DATA_MEDIA_TYPE_BYTES || !mimeToken.test(mediaType)) {
    throw fileInputError('Responses input_file.file_data has an invalid media type');
  }

  const encoded = value.slice(commaIndex + 1);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw fileInputError('Responses input_file.file_data contains invalid base64');
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const finalValue = alphabet.indexOf(encoded[encoded.length - padding - 1]);
  if ((padding === 2 && finalValue % 16 !== 0) || (padding === 1 && finalValue % 4 !== 0)) {
    throw fileInputError('Responses input_file.file_data contains non-canonical base64');
  }
  const decodedBytes = (encoded.length / 4) * 3 - padding;
  if (decodedBytes <= 0) throw fileInputError('Responses input_file.file_data must not be empty');
  return { decodedBytes, fileDataBytes: value.length, mediaType: mediaType.toLowerCase() };
}

function inspectResponsesFileData(body, { requestUrl = '', maxDecodedBytes = MAX_FILE_INPUT_DECODED_BYTES } = {}) {
  if (!isResponsesFileDataRequest(body, requestUrl)) return { count: 0, decodedBytes: 0, fileDataBytes: 0 };
  const parts = responsesInputFileDataParts(body?.payload);
  const parsedLimit = Number(maxDecodedBytes);
  const decodedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.floor(parsedLimit)
    : MAX_FILE_INPUT_DECODED_BYTES;
  let decodedBytes = 0;
  let fileDataBytes = 0;
  for (const part of parts) {
    const inspected = inspectFileDataUri(part.file_data);
    decodedBytes += inspected.decodedBytes;
    fileDataBytes += inspected.fileDataBytes;
    if (decodedBytes >= decodedLimit) {
      throw fileInputError(
        '本次上传的文件合计必须小于 10 MB',
        'FILE_INPUT_REQUEST_TOO_LARGE',
        413
      );
    }
  }
  return { count: parts.length, decodedBytes, fileDataBytes };
}

function validateChatRequestBody(body, { requestUrl = '', bodyBytes = 0, maxDecodedBytes } = {}) {
  const size = Math.max(0, Number(bodyBytes) || 0);
  const visual = hasVisualChatAttachment(body);
  const files = inspectResponsesFileData(body, { requestUrl, maxDecodedBytes });
  const nonFileLimit = visual ? CHAT_VISUAL_BODY_BYTES : CHAT_BODY_BYTES;
  if (files.count > 0) {
    // Only canonical file_data bytes receive the larger envelope. All other
    // JSON still has to fit the pre-existing plain or visual request tier.
    if (size > CHAT_FILE_BODY_BYTES || Math.max(0, size - files.fileDataBytes) > nonFileLimit) {
      throw payloadTooLargeError();
    }
    return { kind: 'file', limitBytes: CHAT_FILE_BODY_BYTES, visual, ...files };
  }
  if (size > nonFileLimit) throw payloadTooLargeError();
  return { kind: visual ? 'visual' : 'plain', limitBytes: nonFileLimit, visual, ...files };
}

async function extractProxyRequest(req, res) {
  let body;
  try {
    const isImageJob = String(req?.url || '').startsWith('/api/image-jobs');
    // A Responses file data URI expands by roughly 4/3 in JSON. Read against one
    // absolute ceiling, then enforce the narrower plain/image/file tier below.
    const rawBody = await readBody(req, { maxBytes: isImageJob ? IMAGE_BODY_BYTES : CHAT_FILE_BODY_BYTES });
    body = parseJson(rawBody);
    if (!isImageJob) {
      validateChatRequestBody(body, {
        requestUrl: req?.url,
        bodyBytes: Buffer.byteLength(rawBody, 'utf8'),
      });
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
  sendJson(res, err.statusCode || 500, {
    error: {
      message: err.message || String(err),
      ...(err?.code ? { code: err.code } : {}),
    },
  });
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

function findJobOr404(store, id, res, principal) {
  const job = findOwnedJob(store, id, principal);
  if (!job) sendJobNotFound(res);
  return job;
}

module.exports = { CHAT_BODY_BYTES, CHAT_VISUAL_BODY_BYTES, CHAT_FILE_BODY_BYTES, MAX_FILE_INPUT_DECODED_BYTES, IMAGE_BODY_BYTES, hasVisualChatAttachment, isResponsesFileDataRequest, responsesInputFileDataParts, inspectFileDataUri, inspectResponsesFileData, validateChatRequestBody, makeJobId, getJobIdFromUrl, publicJob, createJobEvents, extractProxyRequest, configuredUpstreamProxyUrl, upstreamDispatcher, fetchWithValidatedRedirects, readUpstreamErrorDetails, summarizeUpstreamRequest, createUpstreamFetch, safeParseJson, respondJobError, normalizeUpstreamErrorMessage, findJobOr404 };
