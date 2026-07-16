const { responseHeaders, send, sendError } = require('../http/response');
const { performance } = require('perf_hooks');
const { extractProxyRequest, createUpstreamFetch } = require('../jobs/common');
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
const { assignJobOwner, canAccessJob, jobNotFoundPayload } = require('../jobs/ownership');
const { reserveManagedJob, releaseManagedJob } = require('../jobs/admission');

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

function createOpenAiProxy({ chatJobs, makeChatJob, notifyJob, updateChatJobFromStreamChunk, upstreamTimeoutMs, contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS, allowedProxyMethods, allowedProxyPaths, jobAdmission, upstreamLimiter = limiter, fetchUpstream = createUpstreamFetch }) {
  async function proxy(req, res) {
  const targetPath = req.url.replace(/^\/api/, '').split('?')[0];
  if (!allowedProxyPaths.some(re => re.test(targetPath))) {
    return sendError(res, 403, '不允许代理该路径', 'PROXY_PATH_FORBIDDEN');
  }
  let proxyChatJob = null;
  let upstreamTimer = null;
  let limiterAcquired = false;
  const extracted = await extractProxyRequest(req, res);
  if (!extracted) return;
  const { body, baseUrl, apiKey, extraHeaders } = extracted;
  try {
    await upstreamLimiter.acquire();
    limiterAcquired = true;
    const payload = body.payload || {};
    const query = body.query || {};
    const method = String(body.method || 'POST').toUpperCase();
    const proxyJobId = String(body.jobId || '').trim();

    if (!allowedProxyMethods.has(method)) return sendError(res, 405, '不支持的代理方法', 'PROXY_METHOD_NOT_ALLOWED');

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
      const existingJob = chatJobs.get(proxyJobId);
      if (existingJob && !canAccessJob(existingJob, req)) return sendError(res, 404, jobNotFoundPayload({ includeCode: req.authRequired === true }).error.message, 'JOB_NOT_FOUND');
      proxyChatJob = existingJob || makeChatJob(proxyJobId, baseUrl, apiKey, outboundPayload, { stream: true });
      if (!existingJob) {
        assignJobOwner(proxyChatJob, req);
        reserveManagedJob(proxyChatJob, req, jobAdmission);
      }
      if (proxyChatJob.streamStarted) proxyChatJob = null;
      else {
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
    const { response: upstreamResponse, controller, timer } = fetchUpstream(targetUrl.toString(), {
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
    upstreamTimer = timer;
    const upstream = await upstreamResponse;

    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const isEventStream = contentType.toLowerCase().includes('text/event-stream');

    if (wantsStream || isEventStream) {
      const chatJob = proxyChatJob;
      if (!chatJob && targetPath === '/chat/completions' && proxyJobId) {
        // 已有后台流式 job 接管时，当前页面直接通过 SSE 恢复，避免重复请求/重复输出。
        return sendError(res, 409, '任务已在后台继续，请等待恢复连接', 'CHAT_JOB_ALREADY_STREAMING', null, { 'Access-Control-Allow-Origin': '*' });
      }
      const compactResponses = targetPath === '/responses' && wantsStream;
      const responsesNormalizer = compactResponses ? createResponsesCompactStreamNormalizer({ startedAt: upstreamStartedAt }) : null;
      res.writeHead(upstream.status, responseHeaders(res, {
        'Content-Type': compactResponses ? 'text/event-stream; charset=utf-8' : contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      }));
      if (!upstream.body) return res.end();
      let clientOpen = true;
      res.on('close', () => { clientOpen = false; controller.abort(); });
      for await (const chunk of upstream.body) {
        const buf = Buffer.from(chunk);
        const text = buf.toString('utf8');
        if (chatJob) updateChatJobFromStreamChunk(chatJob, text);
        const outbound = responsesNormalizer ? responsesNormalizer.push(text) : buf;
        if (clientOpen && !res.destroyed && outbound && outbound.length) {
          try { res.write(outbound); } catch { clientOpen = false; }
        }
      }
      if (responsesNormalizer && clientOpen && !res.destroyed) {
        const tail = responsesNormalizer.end();
        if (tail) {
          try { res.write(tail); } catch { clientOpen = false; }
        }
      }
      if (chatJob) {
        chatJob.status = 'done';
        chatJob.updatedAt = Date.now();
        delete chatJob.buffer;
        notifyJob(chatJob);
      }
      if (clientOpen && !res.destroyed) res.end();
      return;
    }

    const text = await upstream.text();
    send(res, upstream.status, text, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    const message = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
    if (proxyChatJob) {
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
    if (upstreamTimer) clearTimeout(upstreamTimer);
    if (limiterAcquired) upstreamLimiter.release();
    if (proxyChatJob) releaseManagedJob(proxyChatJob, jobAdmission);
  }
}

  async function proxyImage(req, res) {
  let upstreamTimer = null;
  const extracted = await extractProxyRequest(req, res);
  if (!extracted) return;
  const { body, baseUrl, apiKey, extraHeaders } = extracted;
  try {
    const imageUrl = new URL(String(body.url || '').trim());
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(imageUrl.protocol)) return sendError(res, 400, '非法图片地址', 'INVALID_IMAGE_URL');
    if (imageUrl.origin !== base.origin) return sendError(res, 403, '只允许代理同源图片地址', 'IMAGE_PROXY_ORIGIN_FORBIDDEN');

    const { response: upstreamResponse, controller, timer } = fetchUpstream(imageUrl.toString(), {
      method: 'GET',
      headers: { ...extraHeaders, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      upstreamTimeoutMs,
    });
    upstreamTimer = timer;
    const upstream = await upstreamResponse;
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok) {
      const text = await upstream.text();
      return sendError(res, upstream.status, text || '图片下载失败', 'IMAGE_DOWNLOAD_FAILED');
    }
    if (!contentType.startsWith('image/')) {
      return sendError(res, 415, '上游返回的不是图片', 'UPSTREAM_NOT_IMAGE');
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    send(res, 200, buffer, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    sendError(res, err.statusCode || (aborted ? 504 : 500), aborted ? '图片下载超时' : (err.message || String(err)), aborted ? 'IMAGE_DOWNLOAD_TIMEOUT' : 'IMAGE_PROXY_FAILED');
  } finally {
    if (upstreamTimer) clearTimeout(upstreamTimer);
  }
}

  return { proxy, proxyImage };
}

module.exports = { createOpenAiProxy, withQueryParams };
