const { SECURITY_HEADERS, send, sendError } = require('../http/response');
const { performance } = require('perf_hooks');
const { StringDecoder } = require('string_decoder');
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
const { compactNonStreamingIntentBody } = require('./responses-output');
const { DEFAULT_CONTEXT_WINDOW_TOKENS, applyContextBudgetToOpenAiPayload } = require('../../shared/config/context-budget');
const executionProtocolValidator = require('../validators/dispatch-contract.validator');
const { JOB_ID_CONFLICT_MESSAGE, assertRequestPrincipal, bindJobOwner, jobOwnedBy } = require('../security/job-ownership');
const { JOB_RESPONSE_HEADERS } = require('../jobs/http-contract');
const { jobCancellationSignal, jobCanRun, preserveJobCancellation } = require('../jobs/cancellation');

function hasExecutionProtocolFields(body = {}) {
  return Object.prototype.hasOwnProperty.call(body, 'requestPurpose')
    || Object.prototype.hasOwnProperty.call(body, 'dispatchContract')
    || Object.prototype.hasOwnProperty.call(body, 'bindingEvidence');
}

function validateExecutionProtocolOrReject(body = {}, { targetPath = '', method = 'POST' } = {}) {
  // Every execution target must declare whether it is intent recognition or a
  // final execution. Leaving the fields out is not a compatibility mode: it
  // would allow an uncontracted request to reach a real provider.
  executionProtocolValidator.validateProxyExecutionRequest(body, { targetPath, method });
  return true;
}

const MAX_IMAGE_PROXY_BYTES = Math.max(1, Number(process.env.MAX_IMAGE_PROXY_BYTES || 25 * 1024 * 1024));

async function readResponseBufferWithLimit(response, maxBytes = MAX_IMAGE_PROXY_BYTES) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
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
    if (size > maxBytes) {
      const err = new Error('Image response is too large');
      err.statusCode = 413;
      err.code = 'IMAGE_RESPONSE_TOO_LARGE';
      throw err;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
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

function reqTraceContext(req) {
  return {
    parentTraceId: String(req?._traceId || ""),
    rootTraceId: String(req?._rootTraceId || ""),
  };
}

function createOpenAiProxy({ chatJobs, makeChatJob, notifyJob, updateChatJobFromStreamChunk, upstreamTimeoutMs, contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS, allowedProxyMethods, allowedProxyPaths, requestTrace, errorLog }) {
  async function proxy(req, res) {
  const targetPath = req.url.replace(/^\/api/, '').split('?')[0];
  if (!allowedProxyPaths.some(re => re.test(targetPath))) {
    return sendError(res, 403, '不允许代理该路径', 'PROXY_PATH_FORBIDDEN');
  }
  let proxyChatJob = null;
  let upstreamTimer = null;
  let limiterAcquired = false;
  let traceSpan = null;
  let upstreamStatus = 0;
  let traceContentType = '';
  const extracted = await extractProxyRequest(req, res);
  if (!extracted) return;
  const { body, baseUrl, apiKey, extraHeaders } = extracted;
  try {
    await limiter.acquire();
    limiterAcquired = true;
    const payload = body.payload || {};
    const query = body.query || {};
    const method = String(body.method || 'POST').toUpperCase();
    const proxyJobId = String(body.jobId || '').trim();

    try {
      validateExecutionProtocolOrReject(body, { targetPath, method });
    } catch (protocolError) {
      return sendError(
        res,
        Number(protocolError?.statusCode) || 400,
        protocolError?.message || 'Execution protocol invalid',
        protocolError?.code || 'EXECUTION_PROTOCOL_INVALID',
      );
    }

    if (!allowedProxyMethods.has(method)) return sendError(res, 405, '不支持的代理方法', 'PROXY_METHOD_NOT_ALLOWED');

    let upstreamPath = targetPath === '/openai/image_edit' ? '/images/edits' : targetPath;
    let outboundPayload = method === 'GET' ? payload : applyContextBudgetToOpenAiPayload(payload, { targetPath: upstreamPath, contextWindowTokens, summarizeOmitted: false });
    if (method !== 'GET' && upstreamPath === '/images/generations') {
      safeLog('[image-generation-proxy] upstream json', { model: outboundPayload.model || '', fields: Object.keys(outboundPayload) });
    }
    // Streaming is an explicit browser-to-upstream transport contract. Intent
    // recognition deliberately omits it so the route model always returns one
    // bounded JSON response instead of opening an SSE connection.
    const wantsStream = method !== 'GET' && outboundPayload && outboundPayload.stream === true;
    const isImageEdit = method !== 'GET' && upstreamPath === '/images/edits';
    const imageEditFiles = isImageEdit ? extractImageEditFiles(body) : [];
    const imageEditMasks = isImageEdit ? extractImageEditMasks(body) : [];
    if (targetPath === '/chat/completions' && proxyJobId && wantsStream) {
      let principal;
      try { principal = assertRequestPrincipal(req); }
      catch (error) { return sendError(res, error); }
      const existingJob = chatJobs.get(proxyJobId);
      if (existingJob && !jobOwnedBy(existingJob, principal)) {
        return sendError(res, 409, JOB_ID_CONFLICT_MESSAGE, 'JOB_ID_CONFLICT', null, JOB_RESPONSE_HEADERS);
      }
      proxyChatJob = existingJob || makeChatJob(proxyJobId, baseUrl, apiKey, outboundPayload, {
        stream: true, submissionId: body.submissionId,
      });
      if (!existingJob) bindJobOwner(proxyChatJob, principal);
      if (proxyChatJob.streamStarted) {
        return sendError(res, 409, '任务已在后台继续，请等待恢复连接', 'CHAT_JOB_ALREADY_STREAMING', null, JOB_RESPONSE_HEADERS);
      }
      proxyChatJob.updatedAt = Date.now();
      proxyChatJob.streamStarted = true;
      chatJobs.set(proxyJobId, proxyChatJob);
      notifyJob(proxyChatJob);
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
    traceSpan = requestTrace?.begin?.({
      ...reqTraceContext(req),
      source: 'proxy',
      kind: body.requestPurpose === 'intent_recognition'
        ? 'route_intent'
        : body.requestPurpose === 'intent_understanding'
          ? 'route_understanding'
          : ['/chat/completions', '/responses'].includes(upstreamPath) ? 'chat' : '',
      jobId: proxyJobId,
      submissionId: String(body.submissionId || ''),
      method,
      target: targetUrl,
      targetPath: upstreamPath,
      payload: outboundPayload,
      headerNames: Object.keys(extraHeaders || {}),
      queryKeys: Object.keys(query || {}),
      fileCount: imageEditFiles.length,
      maskCount: imageEditMasks.length,
      secrets: [apiKey],
    });
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
      ...(proxyChatJob ? { job: proxyChatJob, signal: jobCancellationSignal(proxyChatJob) } : {}),
    });
    upstreamTimer = timer;
    const upstream = await upstreamResponse;
    upstreamStatus = Number(upstream.status) || 0;

    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    traceContentType = contentType;
    const isEventStream = contentType.toLowerCase().includes('text/event-stream');

    if (['intent_recognition', 'intent_understanding'].includes(String(body?.requestPurpose || '')) && !wantsStream && isEventStream) {
      const responseText = await upstream.text();
      const error = new Error('Intent recognition upstream returned an unexpected streaming response');
      const traceDetails = { status: upstream.status, responseText, contentType };
      requestTrace?.fail?.(traceSpan, { ...traceDetails, error });
      sendError(res, 502, '意图识别上游错误地返回了流式响应；请将该接口配置为非流式 Responses。', 'INTENT_RESPONSE_STREAM_UNEXPECTED');
      return;
    }

    if (wantsStream || isEventStream) {
      const chatJob = proxyChatJob;
      const compactResponses = targetPath === '/responses' && wantsStream;
      const responsesNormalizer = compactResponses ? createResponsesCompactStreamNormalizer({ startedAt: upstreamStartedAt }) : null;
      res.writeHead(upstream.status, {
        ...SECURITY_HEADERS,
        'Content-Type': compactResponses ? 'text/event-stream; charset=utf-8' : contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, no-store, no-transform',
        Connection: 'keep-alive',
      });
      if (!upstream.body) {
        const traceDetails = { status: upstream.status, response: { streamed: true, emptyBody: true }, contentType };
        if (upstream.ok) requestTrace?.complete?.(traceSpan, traceDetails);
        else requestTrace?.fail?.(traceSpan, { ...traceDetails, error: new Error(`Upstream HTTP ${upstream.status}`) });
        return res.end();
      }
      let clientOpen = true;
      res.on('close', () => { clientOpen = false; controller.abort(); });
      const decoder = new StringDecoder('utf8');
      for await (const chunk of upstream.body) {
        if (chatJob && !jobCanRun(chatJob)) return;
        const buf = Buffer.from(chunk);
        const text = decoder.write(buf);
        if (chatJob) updateChatJobFromStreamChunk(chatJob, text);
        const outbound = responsesNormalizer ? responsesNormalizer.push(text) : buf;
        if (clientOpen && !res.destroyed && outbound && outbound.length) {
          try { res.write(outbound); } catch { clientOpen = false; }
        }
      }
      const decoderTail = decoder.end();
      if (decoderTail) {
        if (chatJob) updateChatJobFromStreamChunk(chatJob, decoderTail);
        if (responsesNormalizer && clientOpen && !res.destroyed) {
          const outbound = responsesNormalizer.push(decoderTail);
          if (outbound) {
            try { res.write(outbound); } catch { clientOpen = false; }
          }
        }
      }
      if (responsesNormalizer && clientOpen && !res.destroyed) {
        const tail = responsesNormalizer.end();
        if (tail) {
          try { res.write(tail); } catch { clientOpen = false; }
        }
      }
      if (chatJob && jobCanRun(chatJob)) {
        chatJob.status = 'done';
        chatJob.error = '';
        chatJob.updatedAt = Date.now();
        delete chatJob.buffer;
        notifyJob(chatJob);
      }
      const traceDetails = { status: upstream.status, response: chatJob?.data || { streamed: true }, contentType };
      if (upstream.ok) requestTrace?.complete?.(traceSpan, traceDetails);
      else requestTrace?.fail?.(traceSpan, { ...traceDetails, error: new Error(`Upstream HTTP ${upstream.status}`) });
      if (clientOpen && !res.destroyed) res.end();
      return;
    }

    const rawText = await upstream.text();
    const isNonStreamingIntent = upstream.ok
      && ['intent_recognition', 'intent_understanding'].includes(String(body?.requestPurpose || ''))
      && !wantsStream;
    const normalized = isNonStreamingIntent
      ? compactNonStreamingIntentBody(rawText)
      : { text: rawText, normalized: false };
    if (isNonStreamingIntent && !normalized.normalized) {
      const error = new Error('Intent recognition upstream response has no usable output text');
      requestTrace?.fail?.(traceSpan, {
        status: upstream.status,
        contentType,
        response: { intentOutput: 'missing' },
        error,
      });
      sendError(res, 502, '意图识别上游响应缺少可用的 output_text。', 'INTENT_RESPONSE_OUTPUT_MISSING');
      return;
    }
    const text = normalized.text;
    const traceDetails = { status: upstream.status, responseText: text, contentType,
      ...(normalized.normalized ? { responseNormalized: 'intent_output_text_only' } : {}) };
    if (upstream.ok) requestTrace?.complete?.(traceSpan, traceDetails);
    else requestTrace?.fail?.(traceSpan, { ...traceDetails, error: new Error(`Upstream HTTP ${upstream.status}`) });
    send(res, upstream.status, text, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    errorLog?.log(err, { source: 'proxy', traceId: traceSpan?.traceId || '' });
    const message = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
    requestTrace?.fail?.(traceSpan, { status: upstreamStatus, error: err, contentType: traceContentType });
    if (proxyChatJob) {
      if (!preserveJobCancellation(proxyChatJob) && proxyChatJob.status === 'running') {
        proxyChatJob.status = 'error';
        proxyChatJob.error = message;
      }
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
    if (limiterAcquired) limiter.release();
  }
}

  async function proxyImage(req, res) {
  let upstreamTimer = null;
  let traceSpan = null;
  let upstreamStatus = 0;
  const extracted = await extractProxyRequest(req, res);
  if (!extracted) return;
  const { body, baseUrl, apiKey, extraHeaders } = extracted;
  try {
    const imageUrl = new URL(String(body.url || '').trim());
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(imageUrl.protocol)) return sendError(res, 400, '非法图片地址', 'INVALID_IMAGE_URL');
    if (imageUrl.origin !== base.origin) return sendError(res, 403, '只允许代理同源图片地址', 'IMAGE_PROXY_ORIGIN_FORBIDDEN');

    traceSpan = requestTrace?.begin?.({
      ...reqTraceContext(req),
      source: 'image_proxy',
      method: 'GET',
      target: imageUrl.toString(),
      targetPath: '/image',
      payload: {},
      kind: 'image_download',
      headerNames: Object.keys(extraHeaders || {}),
      secrets: [apiKey],
    });
    const { response: upstreamResponse, controller, timer } = createUpstreamFetch(imageUrl.toString(), {
      method: 'GET',
      headers: { ...extraHeaders, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      upstreamTimeoutMs,
    });
    upstreamTimer = timer;
    const upstream = await upstreamResponse;
    upstreamStatus = Number(upstream.status) || 0;
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok) {
      const text = await upstream.text();
      requestTrace?.fail?.(traceSpan, { status: upstream.status, responseText: text, contentType, error: new Error(`Upstream HTTP ${upstream.status}`) });
      return sendError(res, upstream.status, text || '图片下载失败', 'IMAGE_DOWNLOAD_FAILED');
    }
    if (!contentType.startsWith('image/')) {
      requestTrace?.fail?.(traceSpan, { status: 415, response: { contentType }, contentType, error: new Error('UPSTREAM_NOT_IMAGE') });
      return sendError(res, 415, '上游返回的不是图片', 'UPSTREAM_NOT_IMAGE');
    }
    const buffer = await readResponseBufferWithLimit(upstream);
    requestTrace?.complete?.(traceSpan, { status: 200, response: { contentType, byteLength: buffer.length }, contentType });
    send(res, 200, buffer, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    errorLog?.log(err, { source: 'image_proxy', traceId: traceSpan?.traceId || '' });
    requestTrace?.fail?.(traceSpan, { status: upstreamStatus || err.statusCode || (aborted ? 504 : 500), error: err });
    sendError(res, err.statusCode || (aborted ? 504 : 500), aborted ? '图片下载超时' : (err.message || String(err)), aborted ? 'IMAGE_DOWNLOAD_TIMEOUT' : 'IMAGE_PROXY_FAILED');
  } finally {
    if (upstreamTimer) clearTimeout(upstreamTimer);
  }
}

  return { proxy, proxyImage };
}

module.exports = { createOpenAiProxy, withQueryParams, MAX_IMAGE_PROXY_BYTES, readResponseBufferWithLimit };
