const { sendJson } = require('../http/response');
const { makeJobId, getJobIdFromUrl, publicJob, extractProxyRequest, createUpstreamFetch, safeParseJson, respondJobError, normalizeUpstreamErrorMessage, findJobOr404 } = require('./common');
const { safeLog } = require('../logging/safe-log');
const { limiter, withLimiter } = require('../concurrency');

const {
  buildImageEditMultipartBody,
  buildOpenAiImageEditPayload,
  ensureImageEditPrompt,
  extractImageEditFiles,
  extractImageEditMasks,
  imageJobTargetPath,
  imageJobTargetUrl,
  isTaggedMaskFile,
  joinUrl,
  stripImageEditFileFields,
  validateImageFilePayloads,
} = require('../services/image-edit-payload.service');

function resolveImageJobMode(body = {}, imageFiles = []) {
  return body.mode === 'edit_image' || imageFiles.length ? 'edit_image' : 'image';
}

function createImageJobValidationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function prepareImageJobRequest(body = {}) {
  let payload = body.payload || {};
  const files = extractImageEditFiles(body);
  const imageFiles = files.filter(item => !isTaggedMaskFile(item));
  const masks = extractImageEditMasks(body);
  validateImageFilePayloads([...imageFiles, ...masks]);
  const mode = resolveImageJobMode(body, imageFiles);
  if (mode === 'edit_image') payload = ensureImageEditPrompt(payload, body);
  if (mode === 'edit_image' && !imageFiles.length) {
    throw createImageJobValidationError('图片编辑任务缺少图片附件');
  }
  if (mode === 'edit_image' && !String(payload.prompt || '').trim()) {
    throw createImageJobValidationError('图片编辑任务缺少 prompt，请输入要如何修改图片');
  }
  return { mode, payload, files: imageFiles, masks };
}

function createImageJobFromRequestBody(jobId, body = {}, { baseUrl, apiKey, extraHeaders } = {}) {
  const { mode, payload, files, masks } = prepareImageJobRequest(body);
  return {
    id: jobId,
    status: 'running',
    mode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    targetUrl: imageJobTargetUrl(baseUrl, mode, payload),
    apiKey,
    extraHeaders,
    payload,
    files,
    masks,
    data: null,
    error: '',
    durationMs: null,
  };
}

function imageUpstreamBaseHeaders(job = {}) {
  return { ...(job.extraHeaders || {}), ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}) };
}

function buildImageUpstreamRequest(job = {}) {
  const headers = imageUpstreamBaseHeaders(job);
  if (job.mode === 'edit_image') {
    const editPayload = stripImageEditFileFields(job.payload);
    const editBody = buildImageEditMultipartBody(editPayload, job.files, { masks: job.masks });
    safeLog('[image-edit] upstream multipart', { model: editPayload.model || '', fields: Object.keys(editPayload).filter(key => String(key || '').toLowerCase() !== 'n'), images: job.files?.length || 0, masks: job.masks?.length || 0 });
    Object.assign(headers, editBody.headers || {});
    return { headers, body: editBody.body };
  }
  headers['Content-Type'] = 'application/json';
  const generationPayload = stripImageEditFileFields(job.payload);
  safeLog('[image-generation] upstream json', { model: generationPayload.model || '', fields: Object.keys(generationPayload) });
  return { headers, body: JSON.stringify(generationPayload || {}) };
}

function createUpstreamHttpError(upstream = {}, data = null, text = '') {
  const message = data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`;
  const err = new Error(message);
  err.upstreamStatus = Number(upstream.status) || 0;
  err.upstreamCode = data?.error?.code || data?.code || '';
  return err;
}

function parseImageUpstreamResponse(upstream = {}, text = '') {
  const data = safeParseJson(text);
  if (!upstream.ok) throw createUpstreamHttpError(upstream, data, text);
  return data;
}

function formatImageJobError(err) {
  return normalizeUpstreamErrorMessage(err);
}

function markImageJobDone(job = {}, data, now = Date.now()) {
  job.status = 'done';
  job.data = data;
  job.durationMs = now - Number(job.serverStartAt || job.createdAt || now);
  return job;
}

function markImageJobFailed(job = {}, err) {
  job.status = 'error';
  job.error = formatImageJobError(err);
  return job;
}

async function runImageJob(job, { notifyJob, upstreamTimeoutMs } = {}) {
  const { headers, body } = buildImageUpstreamRequest(job);
  const { response: upstreamResponse, controller, timer } = createUpstreamFetch(job.targetUrl, {
    method: 'POST',
    headers,
    body,
    job,
    upstreamTimeoutMs,
  });
  try {
    job.serverStartAt = Date.now();
    const upstream = await upstreamResponse;
    const text = await upstream.text();
    const data = parseImageUpstreamResponse(upstream, text);
    markImageJobDone(job, data);
  } catch (err) {
    markImageJobFailed(job, err);
  } finally {
    clearTimeout(timer);
    delete job.controller;
    job.updatedAt = Date.now();
    if (typeof notifyJob === 'function') notifyJob(job);
  }
}

function createImageJobHandlers({ imageJobs, notifyJob, upstreamTimeoutMs }) {
  async function startImageJob(req, res) {
    const extracted = await extractProxyRequest(req, res);
    if (!extracted) return;
    const { body, baseUrl, apiKey, extraHeaders } = extracted;
    try {
      const jobId = makeJobId(body.jobId);
      if (imageJobs.has(jobId)) return sendJson(res, 200, publicJob(imageJobs.get(jobId)), { 'Access-Control-Allow-Origin': '*' });
      const job = createImageJobFromRequestBody(jobId, body, { baseUrl, apiKey, extraHeaders });
      imageJobs.set(job.id, job);
      withLimiter(limiter, () => runImageJob(job, { notifyJob, upstreamTimeoutMs })).catch(err => {
        job.status = 'error';
        job.error = err.message || String(err);
        job.updatedAt = Date.now();
      });
      sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
    } catch (err) {
      respondJobError(res, err);
    }
  }

  function getImageJob(req, res) {
    const id = getJobIdFromUrl(req);
    const job = findJobOr404(imageJobs, id, res);
    if (!job) return;
    sendJson(res, 200, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
  }

  return { startImageJob, getImageJob };
}

module.exports = {
  buildImageUpstreamRequest,
  createImageJobHandlers,
  createImageJobFromRequestBody,
  createImageJobValidationError,
  createUpstreamHttpError,
  formatImageJobError,
  imageUpstreamBaseHeaders,
  markImageJobDone,
  markImageJobFailed,
  parseImageUpstreamResponse,
  prepareImageJobRequest,
  resolveImageJobMode,
  runImageJob,
  buildImageEditMultipartBody,
  extractImageEditFiles,
  extractImageEditMasks,
  imageJobTargetPath,
  imageJobTargetUrl,
  stripImageEditFileFields,
  ensureImageEditPrompt,
  buildOpenAiImageEditPayload,
  joinUrl,
};
