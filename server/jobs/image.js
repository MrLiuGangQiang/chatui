const { sendJson } = require('../http/response');
const { makeJobId, getJobIdFromUrl, publicJob, extractProxyRequest, createUpstreamFetch, safeParseJson, respondJobError, normalizeUpstreamErrorMessage, findJobOr404 } = require('./common');
const { safeLog } = require('../logging/safe-log');
const { limiter, withLimiter } = require('../concurrency');
const executionProtocolValidator = require('../validators/dispatch-contract.validator');
const {
  executionConsumedError,
  executionIdempotencyConflictError,
  executionIdempotencyScope,
  deriveIdempotencyKey,
  contentFingerprint,
} = require('../validators/idempotency.validator');
const { assertProviderCapability } = require('../validators/provider-capability.validator');
const { assertJobOwnedBy, assertRequestPrincipal, bindJobOwner, jobOwnerScope } = require('../security/job-ownership');
const { JOB_RESPONSE_HEADERS } = require('./http-contract');
const { IMAGE_EDIT_TRANSPORT } = require('../config');
const {
  failJobIfRunning,
  jobCancellationSignal,
  jobCanRun,
  preserveJobCancellation,
  releaseJobIdempotency,
} = require('./cancellation');

const {
  buildImageEditMultipartBody,
  buildOpenAiImageEditPayload,
  dataFiles,
  imageFileToDataUrl,
  imageFilesOnly,
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

function validateImageRoleMap(payload = {}, imageFiles = []) {
  const encoded = payload?.image_role_map;
  const taggedFiles = imageFiles.filter(file => String(file?.routeRole || '').trim());
  if (encoded === undefined || encoded === null || encoded === '') {
    if (imageFiles.length > 1 && taggedFiles.length) {
      throw createImageJobValidationError('无法确定多张图片各自的用途，请重新上传后再试');
    }
    return;
  }
  let entries;
  try {
    entries = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
  } catch {
    throw createImageJobValidationError('参考图片的用途信息无效，请重新上传后再试');
  }
  if (!Array.isArray(entries) || entries.length !== imageFiles.length) {
    throw createImageJobValidationError('参考图片数量与用途说明不一致，请重新上传后再试');
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
      throw createImageJobValidationError('图片用途信息不一致，请重新上传图片后再试');
    }
    resourceKeys.add(resourceKey);
  });
}

function normalizeImageEditTransport(value = '') {
  return String(value || '').trim().toLowerCase() === 'responses' ? 'responses' : 'image_api';
}

// Only edit_image has a Responses implementation. Generation keeps the Image
// API path so a transport flag can never silently change generation behavior.
function resolveImageJobTransport(mode = '', requested = '') {
  if (String(mode || '') !== 'edit_image') return 'image_api';
  const explicit = String(requested || '').trim();
  return normalizeImageEditTransport(explicit || IMAGE_EDIT_TRANSPORT);
}

function buildResponsesImageEditRequest(job = {}, payload = {}) {
  const content = [{ type: 'input_text', text: String(payload.prompt || '') }];
  for (const file of imageFilesOnly(job.files || [])) {
    content.push({ type: 'input_image', image_url: imageFileToDataUrl(file) });
  }
  const tool = {
    type: 'image_generation',
    model: String(payload.model || '').trim(),
    action: 'edit',
  };
  const mask = dataFiles(job.masks || [])[0];
  if (mask) tool.input_image_mask = { image_url: imageFileToDataUrl(mask) };
  for (const field of ['size', 'quality', 'background', 'output_format', 'output_compression']) {
    const value = payload[field];
    if (value === undefined || value === null || value === '') continue;
    if (value === 'auto' && field !== 'background') continue;
    if (value === 'auto' && field === 'background') continue;
    tool[field] = value;
  }
  const body = {
    model: String(job.transportModel || payload.transport_model || '').trim() || String(payload.model || '').trim(),
    input: [{ role: 'user', content }],
    tools: [tool],
  };
  if (job.previousResponseId) body.previous_response_id = String(job.previousResponseId);
  return body;
}

// The Responses image tool reports one base64 result per image_generation_call
// output. Normalize it to the Image API shape the client already renders, and
// keep the response id so a later turn can continue the same edit chain.
function normalizeResponsesImageResult(data = {}) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const images = output
    .filter(item => item && item.type === 'image_generation_call' && typeof item.result === 'string' && item.result.trim())
    .map(item => ({ b64_json: item.result }));
  if (!images.length) {
    const error = new Error('\u4e0a\u6e38\u672a\u8fd4\u56de\u56fe\u7247\u7ed3\u679c\uff0c\u8bf7\u91cd\u8bd5');
    error.code = 'IMAGE_RESPONSES_RESULT_MISSING';
    throw error;
  }
  return {
    created: Number(data.created_at) || Math.floor(Date.now() / 1000),
    data: images,
    ...(data.id ? { response_id: String(data.id) } : {}),
  };
}

function prepareImageJobRequest(body = {}) {
  let payload = body.payload || {};
  const files = extractImageEditFiles(body);
  const imageFiles = files.filter(item => !isTaggedMaskFile(item));
  const masks = extractImageEditMasks(body);
  validateImageRoleMap(payload, imageFiles);
  if (masks.length > 1) {
    throw createImageJobValidationError('编辑图片时只能选择一张蒙版图，请只保留一张蒙版后重新发送');
  }
  validateImageFilePayloads([...imageFiles, ...masks]);
  const mode = resolveImageJobMode(body, imageFiles);
  if (mode === 'edit_image') payload = ensureImageEditPrompt(payload, body);
  if (mode === 'edit_image' && !imageFiles.length) {
    throw createImageJobValidationError('图片编辑任务缺少图片附件');
  }
  if (mode === 'edit_image' && !String(payload.prompt || '').trim()) {
    throw createImageJobValidationError('图片编辑任务缺少修改说明，请输入要如何修改图片');
  }
  return { mode, payload, files: imageFiles, masks };
}

function createImageJobFromRequestBody(jobId, body = {}, { baseUrl, apiKey, extraHeaders, prepared = null } = {}) {
  const { mode, payload, files, masks } = prepared || prepareImageJobRequest(body);
  const transport = resolveImageJobTransport(mode, body.transport || body.payload?.transport);
  return {
    id: jobId,
    status: 'running',
    mode,
    transport,
    transportModel: String(body.transportModel || '').trim(),
    previousResponseId: String(body.previousResponseId || '').trim(),
    requestPurpose: body.requestPurpose || '',
    submissionId: String(body.submissionId || ''),
    dispatchContract: body.dispatchContract || null,
    bindingEvidence: Array.isArray(body.bindingEvidence) ? body.bindingEvidence.map(item => ({ ...item })) : [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    targetUrl: transport === 'responses'
      ? joinUrl(baseUrl, '/responses')
      : imageJobTargetUrl(baseUrl, mode, payload),
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
  if (job.mode === 'edit_image' && job.transport === 'responses') {
    headers['Content-Type'] = 'application/json';
    const editPayload = stripImageEditFileFields(job.payload);
    const responsesBody = buildResponsesImageEditRequest(job, editPayload);
    safeLog('[image-edit] upstream responses', {
      model: responsesBody.model,
      imageModel: responsesBody.tools?.[0]?.model || '',
      images: job.files?.length || 0,
      masks: job.masks?.length || 0,
    });
    return { headers, body: JSON.stringify(responsesBody) };
  }
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
  if (!jobCanRun(job)) return job;
  job.status = 'done';
  job.data = data;
  job.error = '';
  job.durationMs = now - Number(job.serverStartAt || job.createdAt || now);
  return job;
}

function markImageJobFailed(job = {}, err) {
  if (preserveJobCancellation(job)) return job;
  if (job.status !== 'running') return job;
  job.status = 'error';
  job.error = formatImageJobError(err);
  return job;
}

async function runImageJob(job, { notifyJob, upstreamTimeoutMs, requestTrace, errorLog } = {}) {
  if (!jobCanRun(job)) return job;
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
  let cleanup = null;
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
      signal: jobCancellationSignal(job),
    });
    timer = upstreamRequest.timer;
    cleanup = upstreamRequest.cleanup;
    job.serverStartAt = Date.now();
    const upstream = await upstreamRequest.response;
    if (!jobCanRun(job)) return job;
    upstreamStatus = Number(upstream.status) || 0;
    const text = await upstream.text();
    if (!jobCanRun(job)) return job;
    const data = parseImageUpstreamResponse(upstream, text);
    markImageJobDone(job, job.transport === 'responses' ? normalizeResponsesImageResult(data) : data);
  } catch (err) {
    failure = err;
    if (!preserveJobCancellation(job)) {
      errorLog?.log(err, { source: 'image_job', traceId: traceSpan?.traceId || '' });
      markImageJobFailed(job, err);
    }
  } finally {
    if (cleanup) cleanup();
    else if (timer) clearTimeout(timer);
    delete job.controller;
    job.updatedAt = Date.now();
    if (job.status === 'done') {
      requestTrace?.complete?.(traceSpan, { status: upstreamStatus, response: job.data, durationMs: job.durationMs });
    } else {
      requestTrace?.fail?.(traceSpan, { status: upstreamStatus, error: failure || new Error(job.error) });
    }
    if (typeof notifyJob === 'function') notifyJob(job);
  }
  return job;
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
        const scope = executionIdempotencyScope(jobOwnerScope(principal), body.submissionId, jobId);
        const idem = idempotencyTable.check({ key, fingerprint, scope });
        if (idem.status === 'consumed') throw executionConsumedError(idem.result);
        idempotencyEntry = { key, fingerprint, scope };
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
      if (idempotencyEntry) {
        job.idempotencyKey = idempotencyEntry.key;
        job.idempotencyFingerprint = idempotencyEntry.fingerprint;
        job.idempotencyScope = idempotencyEntry.scope;
      }
      bindJobOwner(job, principal);
      imageJobs.set(job.id, job);
      if (idempotencyEntry && idempotencyTable) {
        idempotencyTable.consume({ ...idempotencyEntry, result: job.id });
      }
      job.parentTraceId = req._traceId || '';
      job.rootTraceId = req._rootTraceId || '';
      withLimiter(
        limiter,
        () => runImageJob(job, { notifyJob, upstreamTimeoutMs, requestTrace, errorLog }),
        { signal: jobCancellationSignal(job) },
      ).catch(err => {
        if (failJobIfRunning(job, err)) notifyJob?.(job);
      }).finally(() => {
        if (job.status === 'error') releaseJobIdempotency(job, idempotencyTable);
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
  buildResponsesImageEditRequest,
  normalizeResponsesImageResult,
  resolveImageJobTransport,
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
