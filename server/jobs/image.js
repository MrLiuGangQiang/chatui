const { sendJson } = require('../http/response');
const { makeJobId, getJobIdFromUrl, publicJob, extractProxyRequest, createUpstreamFetch, safeParseJson, respondJobError, normalizeUpstreamErrorMessage, findJobOr404 } = require('./common');
const { safeLog } = require('../logging/safe-log');
const { limiter, withLimiter } = require('../concurrency');
const executionProtocolValidator = require('../validators/dispatch-contract.validator');
const { executionConsumedError, deriveIdempotencyKey, contentFingerprint } = require('../validators/idempotency.validator');
const { assertProviderCapability } = require('../validators/provider-capability.validator');
const { assertJobOwnedBy, assertRequestPrincipal, bindJobOwner } = require('../security/job-ownership');
const { JOB_RESPONSE_HEADERS } = require('./http-contract');

const {
  buildImageEditMultipartBody,
  buildOpenAiImageEditPayload,
  ensureImageEditPrompt,
  extractImageEditFiles,
  extractImageEditMasks,
  dedupeImageFiles,
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

function validateImageRoleMap(payload = {}, imageFiles = []) {
  const encoded = payload?.image_role_map;
  const taggedFiles = imageFiles.filter(file => String(file?.routeRole || '').trim());
  if (encoded === undefined || encoded === null || encoded === '') {
    if (imageFiles.length > 1 && taggedFiles.length) {
      throw createImageJobValidationError('多图任务缺少图片角色映射');
    }
    return;
  }
  let entries;
  try {
    entries = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
  } catch {
    throw createImageJobValidationError('图片参考图角色映射无效');
  }
  if (!Array.isArray(entries) || entries.length !== imageFiles.length) {
    throw createImageJobValidationError('图片参考图角色映射与附件数量不一致');
  }
  const allowedRoles = new Set(['target', 'reference', 'style_reference']);
  const resourceKeys = new Set();
  entries.forEach((entry, index) => {
    const file = imageFiles[index] || {};
    const role = String(entry?.role || '').trim();
    const resourceKey = String(entry?.resource_key || '').trim();
    if (!entry || typeof entry !== 'object'
        || Number(entry.position) !== index + 1
        || !allowedRoles.has(role)
        || role !== String(file.routeRole || '')
        || !resourceKey
        || resourceKeys.has(resourceKey)
        || resourceKey !== String(file.routeResourceKey || '')
        || String(entry.id || '') !== String(file.routeId || '')
        || String(entry.reference_id || '') !== String(file.routeReferenceId || '')) {
      throw createImageJobValidationError('图片角色映射与稳定资源绑定不一致');
    }
    resourceKeys.add(resourceKey);
  });
}

function prepareImageJobRequest(body = {}) {
  let payload = body.payload || {};
  const files = extractImageEditFiles(body);
  const imageFiles = files.filter(item => !isTaggedMaskFile(item));
  let masks = extractImageEditMasks(body);
  // A single edit accepts one mask. The same mask bytes may be represented in
  // more than one slot (tagged file plus masks array); collapse identical
  // masks before the cardinality check so a genuinely single-mask edit is
  // never rejected as 'at most one mask'.
  const deduplicatedMasks = dedupeImageFiles(masks);
  if (deduplicatedMasks.length !== masks.length) {
    safeLog?.('[image-job] collapsed duplicate mask attachments', {
      source: masks.length,
      distinct: deduplicatedMasks.length,
    });
    masks = deduplicatedMasks;
  }
  validateImageRoleMap(payload, imageFiles);
  if (masks.length > 1) {
    throw createImageJobValidationError('图片编辑任务最多支持一个 mask 附件');
  }
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

function createImageJobFromRequestBody(jobId, body = {}, { baseUrl, apiKey, extraHeaders, prepared = null } = {}) {
  const { mode, payload, files, masks } = prepared || prepareImageJobRequest(body);
  return {
    id: jobId,
    status: 'running',
    mode,
    requestPurpose: body.requestPurpose || '',
    submissionId: String(body.submissionId || ''),
    dispatchContract: body.dispatchContract || null,
    bindingEvidence: Array.isArray(body.bindingEvidence) ? body.bindingEvidence.map(item => ({ ...item })) : [],
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

async function runImageJob(job, { notifyJob, upstreamTimeoutMs, requestTrace, errorLog } = {}) {
  const traceSpan = requestTrace?.begin?.({
    parentTraceId: job.parentTraceId || '',
    rootTraceId: job.rootTraceId || '',
    source: 'image_job',
    jobId: job.id,
    submissionId: job.submissionId || '',
    method: 'POST',
    target: job.targetUrl,
    targetPath: imageJobTargetPath(job.mode, job.payload),
    payload: job.payload,
    headerNames: Object.keys(job.extraHeaders || {}),
    fileCount: job.files?.length || 0,
    maskCount: job.masks?.length || 0,
    secrets: [job.apiKey],
  });
  let timer = null;
  let upstreamStatus = 0;
  let failure = null;
  try {
    const { headers, body } = buildImageUpstreamRequest(job);
    const upstreamRequest = createUpstreamFetch(job.targetUrl, {
      method: 'POST',
      headers,
      body,
      job,
      upstreamTimeoutMs,
    });
    timer = upstreamRequest.timer;
    job.serverStartAt = Date.now();
    const upstream = await upstreamRequest.response;
    upstreamStatus = Number(upstream.status) || 0;
    const text = await upstream.text();
    const data = parseImageUpstreamResponse(upstream, text);
    markImageJobDone(job, data);
  } catch (err) {
    failure = err;
    errorLog?.log(err, { source: 'image_job', traceId: traceSpan?.traceId || '' });
    markImageJobFailed(job, err);
  } finally {
    if (timer) clearTimeout(timer);
    delete job.controller;
    job.updatedAt = Date.now();
    if (job.status === 'done') {
      requestTrace?.complete?.(traceSpan, { status: upstreamStatus, response: job.data, durationMs: job.durationMs });
    } else {
      requestTrace?.fail?.(traceSpan, { status: upstreamStatus, error: failure || new Error(job.error) });
    }
    if (typeof notifyJob === 'function') notifyJob(job);
  }
}

function createImageJobHandlers({ imageJobs, notifyJob, upstreamTimeoutMs, requestTrace, errorLog, idempotencyTable = null, providerCapabilities = null }) {
  async function startImageJob(req, res) {
    const extracted = await extractProxyRequest(req, res);
    if (!extracted) return;
    const { body, baseUrl, apiKey, extraHeaders } = extracted;
    let prepared = null;
    let jobId = String(body?.jobId || '');
    let validationStage = 'prepare_request';
    const traceExecution = (event, extra = {}) => requestTrace?.[event]?.({
      traceId: req._traceId || '',
      rootTraceId: req._rootTraceId || '',
      source: 'managed_image_execution',
      submissionId: String(body?.submissionId || ''),
      jobId,
      body,
      payload: prepared?.payload || body?.payload || {},
      mode: prepared?.mode || body?.mode || '',
      files: prepared?.files || [],
      masks: prepared?.masks || [],
      secrets: [apiKey],
      stage: validationStage,
      ...extra,
    });
    try {
      const principal = assertRequestPrincipal(req);
      jobId = makeJobId(body.jobId);
      const existingJob = imageJobs.get(jobId);
      if (existingJob) {
        validationStage = 'job_owner';
        assertJobOwnedBy(existingJob, principal);
      }
      prepared = prepareImageJobRequest(body);
      validationStage = 'execution_protocol';
      const validation = executionProtocolValidator.validateManagedImageRequest(
        { ...body, mode: prepared.mode, payload: prepared.payload },
        {
          payload: prepared.payload,
          mode: prepared.mode,
          files: prepared.files,
          masks: prepared.masks,
        },
      );
      const executionContract = {
        requestPurpose: validation.requestPurpose,
        dispatchContract: validation.dispatchContract,
        bindingEvidence: validation.bindingEvidence,
      };
      if (existingJob) {
        validationStage = 'job_contract';
        executionProtocolValidator.assertJobExecutionContract(existingJob, executionContract);
        traceExecution('executionAccepted', { reused: true });
        return sendJson(res, 200, publicJob(existingJob), JOB_RESPONSE_HEADERS);
      }
      // Design doc v2.7 10: idempotency dedup before creating a new Job.
      let idempotencyEntry = null;
      if (idempotencyTable && executionContract.dispatchContract) {
        const plan = executionContract.dispatchContract;
        const key = deriveIdempotencyKey(plan);
        const fingerprint = contentFingerprint(plan);
        const idem = idempotencyTable.check({ key, fingerprint });
        if (idem.status === 'consumed') {
          throw executionConsumedError(idem.result);
        }
        idempotencyEntry = { key, fingerprint };
      }
      // Design doc v2.7 7.1: provider capability gate before Job creation.
      if (providerCapabilities && executionContract.dispatchContract) {
        assertProviderCapability({
          operation: executionContract.dispatchContract.operation || '',
          bindings: Array.isArray(executionContract.dispatchContract.bindings)
            ? executionContract.dispatchContract.bindings
            : [],
          argumentsValue: executionContract.dispatchContract.arguments || {},
          provider: providerCapabilities,
        });
      }
      validationStage = 'accepted';
      traceExecution('executionAccepted');
      const job = createImageJobFromRequestBody(jobId, {
        ...body,
        requestPurpose: executionContract.requestPurpose,
        dispatchContract: executionContract.dispatchContract,
        bindingEvidence: executionContract.bindingEvidence,
      }, { baseUrl, apiKey, extraHeaders, prepared });
      bindJobOwner(job, principal);
      imageJobs.set(job.id, job);
      if (idempotencyEntry && idempotencyTable) {
        idempotencyTable.consume({ ...idempotencyEntry, result: job.id });
      }
      job.parentTraceId = req._traceId || '';
      job.rootTraceId = req._rootTraceId || '';
      withLimiter(limiter, () => runImageJob(job, { notifyJob, upstreamTimeoutMs, requestTrace, errorLog })).catch(err => {
        job.status = 'error';
        job.error = err.message || String(err);
        job.updatedAt = Date.now();
      });
      sendJson(res, 202, publicJob(job), JOB_RESPONSE_HEADERS);
    } catch (err) {
      traceExecution('executionRejected', { error: err });
      respondJobError(res, err);
    }
  }

  function getImageJob(req, res) {
    const id = getJobIdFromUrl(req);
    const job = findJobOr404(imageJobs, id, res, req.authPrincipal);
    if (!job) return;
    sendJson(res, 200, publicJob(job), JOB_RESPONSE_HEADERS);
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
  validateImageRoleMap,
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
