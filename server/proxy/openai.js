const { SECURITY_HEADERS, applyResponseHeaders, send, sendError } = require('../http/response');
const { performance } = require('perf_hooks');
const { StringDecoder } = require('string_decoder');
const { extractProxyRequest, createUpstreamFetch, readUpstreamTextWithLimit, createUpstreamByteCounter, normalizeUpstreamErrorMessage } = require('../jobs/common');
const { limiter } = require('../concurrency');
const { safeLog } = require('../logging/safe-log');
const {
  extractImageEditFiles,
  extractImageEditMasks,
  stripImageEditFileFields,
  buildImageEditMultipartBody,
} = require('../jobs/image');
const { createResponsesCompactStreamNormalizer } = require('./responses-stream');
const { DEFAULT_CONTEXT_WINDOW_TOKENS, applyContextBudgetToOpenAiPayload } = require('../../shared/config/context-budget');
const { positiveInteger } = require('../config/numbers');

const MAX_IMAGE_PROXY_BYTES = positiveInteger(process.env.MAX_IMAGE_PROXY_BYTES, 25 * 1024 * 1024, { max: 512 * 1024 * 1024 });
const GET_PROXY_PATHS = new Set(['/models']);

async function readResponseBufferWithLimit(response, maxBytes = MAX_IMAGE_PROXY_BYTES) {
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : MAX_IMAGE_PROXY_BYTES;
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > limit) {
    try { await response.body?.cancel?.(); } catch {}
    const err = new Error('Image response is too large');
    err.statusCode = 413;
    err.code = 'IMAGE_RESPONSE_TOO_LARGE';
    throw err;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      try { await response.body?.cancel?.(); } catch {}
      const err = new Error('Image response is too large');
      err.statusCode = 413;
      err.code = 'IMAGE_RESPONSE_TOO_LARGE';
      throw err;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function writeResponseChunk(res, chunk) {
  if (!chunk || !chunk.length || res.destroyed || res.writableEnded) return Promise.resolve(false);
  try {
    if (res.write(chunk)) return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onClose);
    };
    const onDrain = () => { cleanup(); resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onClose);
  });
}

function requestConnectionClosed(req) {
  // IncomingMessage may be marked destroyed after a normally completed body
  // has been consumed. Treat it as an abort only when the request was not
  // complete; the response close flag remains authoritative after that point.
  return req?.aborted === true || (req?.destroyed === true && req?.complete !== true);
}

function withQueryParams(rawUrl, params) {
  const url = new URL(rawUrl);
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [key, value] of Object.entries(params)) {
      if (!key || value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        value.forEach(item => item !== undefined && item !== null && url.searchParams.append(key, String(item)));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function createOpenAiProxy({ chatJobs, makeChatJob, notifyJob, updateChatJobFromStreamChunk, upstreamTimeoutMs, contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS, allowedProxyMethods, allowedProxyPaths, requestLimiter = limiter }) {
  async function proxy(req, res) {
  const targetPath = req.url.replace(/^\/api/, '').split('?')[0];
  if (!allowedProxyPaths.some(re => re.test(targetPath))) {
    return sendError(res, 403, '不允许代理该路径', 'PROXY_PATH_FORBIDDEN');
  }
  let proxyChatJob = null;
  let upstreamTimer = null;
  let upstreamController = null;
  let limiterAcquired = false;
  let clientOpen = true;
  const abortOnClientClose = () => { clientOpen = false; upstreamController?.abort(); };
  res.once('close', abortOnClientClose);
  const extracted = await extractProxyRequest(req, res);
  if (!extracted) {
    res.removeListener('close', abortOnClientClose);
    return;
  }
  const { body, baseUrl, apiKey, extraHeaders } = extracted;
  try {
    await requestLimiter.acquire();
    limiterAcquired = true;
    if (!clientOpen || requestConnectionClosed(req) || res.destroyed || res.writableEnded) return;
    const payload = body.payload || {};
    const query = body.query || {};
    const method = String(body.method || 'POST').toUpperCase();
    const proxyJobId = String(body.jobId || '').trim();

    if (!allowedProxyMethods.has(method)) return sendError(res, 405, '不支持的代理方法', 'PROXY_METHOD_NOT_ALLOWED');
    if (method === 'GET' && !GET_PROXY_PATHS.has(targetPath)) {
      return sendError(res, 405, '该代理路径不支持 GET', 'PROXY_METHOD_NOT_ALLOWED');
    }

    let upstreamPath = targetPath === '/openai/image_edit' ? '/images/edits' : targetPath;
    let outboundPayload = method === 'GET' ? payload : applyContextBudgetToOpenAiPayload(payload, { targetPath: upstreamPath, contextWindowTokens });
    if (method !== 'GET' && upstreamPath === '/images/generations') {
      safeLog('[image-generation-proxy] upstream json', { model: outboundPayload.model || '', fields: Object.keys(outboundPayload) });
    }
    const wantsStream = method !== 'GET' && outboundPayload && outboundPayload.stream === true;
    const isImageEdit = method !== 'GET' && upstreamPath === '/images/edits';
    const imageEditFiles = isImageEdit ? extractImageEditFiles(body) : [];
    const imageEditMasks = isImageEdit ? extractImageEditMasks(body) : [];
    if (targetPath === '/chat/completions' && proxyJobId && wantsStream) {
      proxyChatJob = chatJobs.get(proxyJobId) || makeChatJob(proxyJobId, baseUrl, apiKey, outboundPayload, { stream: true });
      if (proxyChatJob.streamStarted) {
        proxyChatJob = null;
        return sendError(res, 409, '任务已在后台继续，请等待恢复连接', 'CHAT_JOB_ALREADY_STREAMING', null, { 'Access-Control-Allow-Origin': '*' });
      } else {
        proxyChatJob.updatedAt = Date.now();
        proxyChatJob.streamStarted = true;
        chatJobs.set(proxyJobId, proxyChatJob);
        notifyJob(proxyChatJob);
      }
    }
    let upstreamBody = method === 'GET' ? undefined : JSON.stringify(outboundPayload);
    let upstreamContentHeaders = method === 'GET' ? {} : { 'Content-Type': 'application/json' };
    if (isImageEdit && imageEditFiles.length) {
      const editPayload = stripImageEditFileFields(outboundPayload);
      const editBody = buildImageEditMultipartBody(editPayload, imageEditFiles, { masks: imageEditMasks });
      safeLog('[image-edit-proxy] upstream multipart', { model: editPayload.model || '', fields: Object.keys(editPayload).filter(key => String(key || '').toLowerCase() !== 'n'), images: imageEditFiles.length, masks: imageEditMasks.length });
      upstreamBody = editBody.body;
      upstreamContentHeaders = editBody.headers || {};
    }
    const targetUrl = withQueryParams(`${baseUrl.replace(/\/+$/, '')}${upstreamPath}`, query);
    const upstreamStartedAt = performance.now();
    const { response: upstreamResponse, controller, timer } = createUpstreamFetch(targetUrl.toString(), {
      method,
      headers: {
        ...upstreamContentHeaders,
        ...(wantsStream ? { Accept: 'text/event-stream' } : {}),
        ...extraHeaders,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: method === 'GET' ? undefined : upstreamBody,
      upstreamTimeoutMs,
    });
    upstreamController = controller;
    upstreamTimer = timer;
    const upstream = await upstreamResponse;

    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const isEventStream = contentType.toLowerCase().includes('text/event-stream');

    if ((wantsStream || isEventStream) && !upstream.ok) {
      const errorText = await readUpstreamTextWithLimit(upstream);
      if (proxyChatJob) {
        const upstreamError = new Error(errorText || `上游返回 ${upstream.status}`);
        upstreamError.upstreamStatus = upstream.status;
        proxyChatJob.status = 'error';
        proxyChatJob.error = normalizeUpstreamErrorMessage(upstreamError);
        proxyChatJob.updatedAt = Date.now();
        notifyJob(proxyChatJob);
      }
      return send(res, upstream.status, errorText, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
    }

    if (wantsStream || isEventStream) {
      const chatJob = proxyChatJob;
      if (!upstream.body) throw Object.assign(new Error('上游没有返回流式响应体'), { statusCode: 502 });
      const compactResponses = targetPath === '/responses' && wantsStream;
      const responsesNormalizer = compactResponses ? createResponsesCompactStreamNormalizer({ startedAt: upstreamStartedAt }) : null;
      res.writeHead(upstream.status, applyResponseHeaders(res, {
        ...SECURITY_HEADERS,
        'Content-Type': compactResponses ? 'text/event-stream; charset=utf-8' : contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      }));
      const decoder = new StringDecoder('utf8');
      const byteCounter = createUpstreamByteCounter();
      for await (const chunk of upstream.body) {
        const buf = Buffer.from(chunk);
        byteCounter.add(buf);
        const text = decoder.write(buf);
        if (chatJob) updateChatJobFromStreamChunk(chatJob, text);
        const outbound = responsesNormalizer ? responsesNormalizer.push(text) : buf;
        if (clientOpen && !res.destroyed && outbound && outbound.length) {
          clientOpen = await writeResponseChunk(res, outbound);
          if (!clientOpen) controller.abort();
        }
      }
      const decoderTail = decoder.end();
      if (decoderTail) {
        if (chatJob) updateChatJobFromStreamChunk(chatJob, decoderTail);
        if (responsesNormalizer) {
          const outbound = responsesNormalizer.push(decoderTail);
          if (clientOpen && !res.destroyed && outbound) {
            clientOpen = await writeResponseChunk(res, outbound);
          }
        }
      }
      if (responsesNormalizer && clientOpen && !res.destroyed) {
        const tail = responsesNormalizer.end();
        if (tail) {
          clientOpen = await writeResponseChunk(res, tail);
        }
      }
      if (chatJob?.streamError) throw new Error(chatJob.streamError);
      if (chatJob) {
        if (chatJob.status === 'running') chatJob.status = 'done';
        chatJob.updatedAt = Date.now();
        delete chatJob.buffer;
        delete chatJob.streamError;
        notifyJob(chatJob);
      }
      if (clientOpen && !res.destroyed) res.end();
      return;
    }

    const text = await readUpstreamTextWithLimit(upstream);
    send(res, upstream.status, text, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    const message = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
    if (proxyChatJob?.status === 'running') {
      proxyChatJob.status = 'error';
      proxyChatJob.error = message;
      proxyChatJob.updatedAt = Date.now();
      notifyJob(proxyChatJob);
    }
    if (!res.headersSent && !res.destroyed) {
      sendError(res, err.statusCode || (aborted ? 504 : 502), message, aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_CONNECTION_FAILED');
    } else if (!res.destroyed) {
      res.end();
    }
  } finally {
    res.removeListener('close', abortOnClientClose);
    if (upstreamTimer) clearTimeout(upstreamTimer);
    if (limiterAcquired) requestLimiter.release();
  }
}

  async function proxyImage(req, res) {
  let upstreamTimer = null;
  let upstreamController = null;
  let limiterAcquired = false;
  let clientOpen = true;
  const abortOnClientClose = () => { clientOpen = false; upstreamController?.abort(); };
  res.once('close', abortOnClientClose);
  const extracted = await extractProxyRequest(req, res);
  if (!extracted) {
    res.removeListener('close', abortOnClientClose);
    return;
  }
  const { body, baseUrl, apiKey, extraHeaders } = extracted;
  try {
    await requestLimiter.acquire();
    limiterAcquired = true;
    if (!clientOpen || requestConnectionClosed(req) || res.destroyed || res.writableEnded) return;
    let imageUrl;
    let base;
    try {
      imageUrl = new URL(String(body.url || '').trim());
      base = new URL(baseUrl);
    } catch {
      return sendError(res, 400, '非法图片地址', 'INVALID_IMAGE_URL');
    }
    if (!['http:', 'https:'].includes(imageUrl.protocol)) return sendError(res, 400, '非法图片地址', 'INVALID_IMAGE_URL');
    if (imageUrl.origin !== base.origin) return sendError(res, 403, '只允许代理同源图片地址', 'IMAGE_PROXY_ORIGIN_FORBIDDEN');

    const { response: upstreamResponse, controller, timer } = createUpstreamFetch(imageUrl.toString(), {
      method: 'GET',
      headers: { ...extraHeaders, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      upstreamTimeoutMs,
    });
    upstreamController = controller;
    upstreamTimer = timer;
    const upstream = await upstreamResponse;
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok) {
      const text = await readUpstreamTextWithLimit(upstream);
      return sendError(res, upstream.status, text || '图片下载失败', 'IMAGE_DOWNLOAD_FAILED');
    }
    const normalizedContentType = contentType.split(';')[0].trim().toLowerCase();
    if (!new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']).has(normalizedContentType)) {
      try { await upstream.body?.cancel?.(); } catch {}
      return sendError(res, 415, '上游返回的不是受支持的安全位图格式', 'UPSTREAM_NOT_IMAGE');
    }
    const buffer = await readResponseBufferWithLimit(upstream);
    send(res, 200, buffer, {
      'Content-Type': normalizedContentType,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    if (!res.headersSent && !res.destroyed && !res.writableEnded) {
      sendError(res, err.statusCode || (aborted ? 504 : 500), aborted ? '图片下载超时' : (err.message || String(err)), aborted ? 'IMAGE_DOWNLOAD_TIMEOUT' : 'IMAGE_PROXY_FAILED');
    }
  } finally {
    res.removeListener('close', abortOnClientClose);
    if (upstreamTimer) clearTimeout(upstreamTimer);
    if (limiterAcquired) requestLimiter.release();
  }
}

  return { proxy, proxyImage };
}

module.exports = { createOpenAiProxy, withQueryParams, MAX_IMAGE_PROXY_BYTES, readResponseBufferWithLimit, writeResponseChunk };
