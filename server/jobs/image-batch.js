'use strict';

const { sendJson } = require('../http/response');
const {
  makeJobId,
  getJobIdFromUrl,
  extractProxyRequest,
  respondJobError,
} = require('./common');
const { limiter, withLimiter } = require('../concurrency');
const {
  executionConsumedError,
  deriveIdempotencyKey,
  contentFingerprint,
} = require('../validators/idempotency.validator');
const { assertProviderCapability } = require('../validators/provider-capability.validator');
const {
  assertJobOwnedBy,
  assertRequestPrincipal,
  bindJobOwner,
  findOwnedJob,
  jobOwnedBy,
} = require('../security/job-ownership');
const {
  JOB_NOT_FOUND_MESSAGE,
  JOB_RESPONSE_HEADERS,
  JOB_SSE_HEADERS,
} = require('./http-contract');
const {
  createImageJobFromRequestBody,
  prepareImageJobRequest,
  runImageJob,
} = require('./image');
const executionProtocolValidator = require('../validators/dispatch-contract.validator');
const imageBatchExecution = require('../../shared/image-batch-execution');

function makeBatchJobId(value = '') {
  const supplied = String(value || '').trim();
  if (/^imgbatch-[a-z0-9-]{8,80}$/i.test(supplied)) return supplied;
  return `imgbatch-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function batchContractConflictError() {
  const error = new Error('已有批量任务绑定到不同的执行合同');
  error.code = 'IMAGE_BATCH_CONTRACT_MISMATCH';
  error.statusCode = 409;
  return error;
}

function childOwnershipConflictError() {
  const error = new Error('子任务标识已被其他批量任务占用');
  error.code = 'IMAGE_BATCH_CHILD_CONFLICT';
  error.statusCode = 409;
  return error;
}

function publicImageBatchJob(job = {}) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    data: {
      tasks: Array.isArray(job.tasks)
        ? job.tasks.map(task => ({
            id: task.id,
            status: task.status,
            data: task.data || null,
            error: task.error ? { message: task.error } : null,
          }))
        : [],
    },
    error: job.error ? { message: job.error } : null,
    metrics: null,
  };
}

function createImageBatchJobHandlers({
  imageJobs,
  imageBatchJobs,
  jobSubscribers,
  upstreamTimeoutMs,
  requestTrace,
  errorLog,
  idempotencyTable = null,
  providerCapabilities = null,
  notifyJob = () => {},
  runImageJobImpl = runImageJob,
}) {
  function parentTerminal(parent) {
    const tasks = Array.isArray(parent.tasks) ? parent.tasks : [];
    if (!tasks.length || !tasks.every(task => task.status === 'done' || task.status === 'error')) return;
    const failed = tasks.filter(task => task.status === 'error');
    if (failed.length) {
      parent.status = 'error';
      const firstError = failed.find(task => task.error)?.error;
      parent.error = failed.length === tasks.length
        ? '多图任务全部失败'
        : `多图任务完成，但 ${failed.length}/${tasks.length} 个子任务失败`;
      if (firstError) parent.error += `：${firstError}`;
    } else {
      parent.status = 'done';
      parent.error = '';
    }
  }

  function notifyImageBatchJob(parent) {
    const subscribers = jobSubscribers.get(parent.id);
    if (!subscribers) return;
    const data = `event: update\ndata: ${JSON.stringify(publicImageBatchJob(parent))}\n\n`;
    const terminal = parent.status === 'done' || parent.status === 'error';
    for (const subscriber of [...subscribers]) {
      if (subscriber?.job !== parent) continue;
      const res = subscriber.res;
      if (!res || !jobOwnedBy(parent, subscriber.principal)) {
        subscribers.delete(subscriber);
        try { res?.end(); } catch {}
        continue;
      }
      try {
        res.write(data);
        res.flushHeaders?.();
      } catch {
        subscribers.delete(subscriber);
        try { res.end(); } catch {}
        continue;
      }
      if (terminal) {
        subscribers.delete(subscriber);
        try { res.end(); } catch {}
      }
    }
    if (!subscribers.size) jobSubscribers.delete(parent.id);
  }

  function expireImageBatchJob(parent) {
    if (!parent || parent.status === 'done' || parent.status === 'error') return;
    for (const task of parent.tasks || []) {
      if (task.status === 'running') {
        task.status = 'error';
        task.error = '任务运行超时，已自动清理';
      }
    }
    for (const childId of parent.childIds || []) {
      const child = imageJobs.get(childId);
      if (!child || child.status !== 'running') continue;
      try { child.controller?.abort?.(); } catch {}
      child.status = 'error';
      child.error = '任务运行超时，已自动清理';
      child.updatedAt = Date.now();
      notifyJob(child);
    }
    parent.status = 'error';
    parent.error = '任务运行超时，已自动清理';
    parent.updatedAt = Date.now();
    notifyImageBatchJob(parent);
  }

  function updateParentFromChild(parent, child) {
    if (!parent || parent.status === 'done' || parent.status === 'error') return;
    const task = (parent.tasks || []).find(item => item.id === child.id);
    if (task) {
      task.status = child.status;
      task.data = child.data || null;
      task.error = child.error ? String(child.error) : null;
    }
    parent.updatedAt = Date.now();
    parentTerminal(parent);
    notifyImageBatchJob(parent);
  }

  function subscribeImageBatchJob(req, res) {
    const id = getJobIdFromUrl(req);
    const parent = findOwnedJob(imageBatchJobs, id, req.authPrincipal);
    if (!parent) {
      res.writeHead(200, JOB_SSE_HEADERS);
      res.write(`event: update\ndata: ${JSON.stringify({ status: 'error', error: { message: JOB_NOT_FOUND_MESSAGE } })}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, JOB_SSE_HEADERS);
    res.write(`event: update\ndata: ${JSON.stringify(publicImageBatchJob(parent))}\n\n`);
    res.flushHeaders?.();
    if (parent.status === 'done' || parent.status === 'error') return res.end();
    if (!jobSubscribers.has(parent.id)) jobSubscribers.set(parent.id, new Set());
    const subscriber = { res, principal: req.authPrincipal, job: parent };
    jobSubscribers.get(parent.id).add(subscriber);
    req.on('close', () => {
      const set = jobSubscribers.get(parent.id);
      if (!set) return;
      set.delete(subscriber);
      if (!set.size) jobSubscribers.delete(parent.id);
    });
  }

  function abortImageBatchJob(store, id, principal) {
    const parent = findOwnedJob(store, id, principal);
    if (!parent) return null;
    if (parent.status === 'done' || parent.status === 'error') return parent;
    parent.status = 'error';
    parent.error = '任务已停止';
    parent.updatedAt = Date.now();
    for (const task of parent.tasks || []) {
      if (task.status === 'running') {
        task.status = 'error';
        task.error = '任务已停止';
      }
    }
    for (const childId of parent.childIds || []) {
      const child = imageJobs.get(childId);
      if (!child || child.status !== 'running') continue;
      try { child.controller?.abort?.(); } catch {}
      child.status = 'error';
      child.error = '任务已停止';
      child.updatedAt = Date.now();
      notifyJob(child);
    }
    notifyImageBatchJob(parent);
    return parent;
  }

  function disposeImageBatchJob(store, id, principal) {
    const parent = findOwnedJob(store, id, principal);
    if (!parent) return null;
    if (parent.status !== 'done' && parent.status !== 'error') {
      abortImageBatchJob(store, id, principal);
    } else {
      const subscribers = jobSubscribers.get(id);
      if (subscribers) {
        for (const subscriber of [...subscribers]) {
          if (subscriber?.job !== parent) continue;
          subscribers.delete(subscriber);
          try { subscriber.res?.end(); } catch {}
        }
        if (!subscribers.size) jobSubscribers.delete(id);
      }
    }
    for (const childId of parent.childIds || []) {
      imageJobs.delete(childId);
    }
    store.delete(id);
    return parent;
  }

  function validateChildTask(task, principal, batchId) {
    const prepared = prepareImageJobRequest(task);
    const validation = executionProtocolValidator.validateManagedImageRequest(task, {
      payload: prepared.payload,
      mode: prepared.mode,
      files: prepared.files,
      masks: prepared.masks,
    });
    if (providerCapabilities && validation.dispatchContract) {
      assertProviderCapability({
        operation: validation.dispatchContract.operation || '',
        bindings: Array.isArray(validation.dispatchContract.bindings)
          ? validation.dispatchContract.bindings
          : [],
        argumentsValue: validation.dispatchContract.arguments || {},
        provider: providerCapabilities,
      });
    }
    const childJobId = makeJobId(task.jobId);
    const existingChild = imageJobs.get(childJobId);
    if (existingChild) {
      assertJobOwnedBy(existingChild, principal);
      throw childOwnershipConflictError();
    }
    return { prepared, validation, childJobId };
  }

  async function startImageBatchJob(req, res) {
    const extracted = await extractProxyRequest(req, res);
    if (!extracted) return;
    const { body, baseUrl, apiKey, extraHeaders } = extracted;
    try {
      const contract = {
        schema_version: body.schema_version,
        batchId: body.batchId,
        submissionId: body.submissionId || '',
        tasks: Array.isArray(body.tasks) ? body.tasks : [],
      };
      imageBatchExecution.assertImageBatchExecution(contract);
      const principal = assertRequestPrincipal(req);
      const batchId = makeBatchJobId(contract.batchId);
      const existing = imageBatchJobs.get(batchId);
      if (existing) {
        assertJobOwnedBy(existing, principal);
        const plan = imageBatchExecution.imageBatchIdempotencyPlan(contract);
        if (existing.contentFingerprint !== contentFingerprint(plan)) {
          throw batchContractConflictError();
        }
        return sendJson(res, 200, publicImageBatchJob(existing), JOB_RESPONSE_HEADERS);
      }

      const preparedTasks = contract.tasks.map(task => validateChildTask(task, principal, batchId));
      const plan = imageBatchExecution.imageBatchIdempotencyPlan(contract);
      const fingerprint = contentFingerprint(plan);
      if (idempotencyTable) {
        const idempotency = idempotencyTable.check({
          key: deriveIdempotencyKey(plan),
          fingerprint,
        });
        if (idempotency.status === 'consumed') throw executionConsumedError(idempotency.result);
      }

      const parent = {
        id: batchId,
        kind: 'image_batch',
        status: 'running',
        submissionId: contract.submissionId,
        contentFingerprint: fingerprint,
        tasks: [],
        childIds: [],
        error: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentTraceId: req._traceId || '',
        rootTraceId: req._rootTraceId || '',
      };
      parent.onExpire = () => expireImageBatchJob(parent);

      const children = preparedTasks.map(item => {
        const child = createImageJobFromRequestBody(item.childJobId, {
          requestPurpose: item.validation.requestPurpose,
          dispatchContract: item.validation.dispatchContract,
          bindingEvidence: item.validation.bindingEvidence,
          mode: item.prepared.mode,
          payload: item.prepared.payload,
          files: item.prepared.files,
          masks: item.prepared.masks,
          submissionId: contract.submissionId,
        }, { baseUrl, apiKey, extraHeaders, prepared: item.prepared });
        child.parentBatchId = batchId;
        child.parentTraceId = req._traceId || '';
        child.rootTraceId = req._rootTraceId || '';
        return child;
      });
      parent.tasks = children.map(child => ({
        id: child.id,
        status: child.status,
        data: null,
        error: null,
      }));
      parent.childIds = children.map(child => child.id);

      bindJobOwner(parent, principal);
      imageBatchJobs.set(parent.id, parent);
      children.forEach(child => {
        bindJobOwner(child, principal);
        imageJobs.set(child.id, child);
      });
      if (idempotencyTable) {
        idempotencyTable.consume({ key: deriveIdempotencyKey(plan), fingerprint, result: parent.id });
      }

      for (const child of children) {
        const childNotify = job => {
          updateParentFromChild(parent, job);
          notifyJob(job);
        };
        withLimiter(limiter, () => runImageJobImpl(child, {
          notifyJob: childNotify,
          upstreamTimeoutMs,
          requestTrace,
          errorLog,
        })).catch(error => {
          child.status = 'error';
          child.error = error.message || String(error);
          child.updatedAt = Date.now();
          childNotify(child);
        });
      }

      sendJson(res, 202, publicImageBatchJob(parent), JOB_RESPONSE_HEADERS);
    } catch (error) {
      respondJobError(res, error);
    }
  }

  function getImageBatchJob(req, res) {
    const id = getJobIdFromUrl(req);
    const parent = findOwnedJob(imageBatchJobs, id, req.authPrincipal);
    if (!parent) {
      return sendJson(res, 404, { error: { message: JOB_NOT_FOUND_MESSAGE } }, JOB_RESPONSE_HEADERS);
    }
    sendJson(res, 200, publicImageBatchJob(parent), JOB_RESPONSE_HEADERS);
  }

  return {
    startImageBatchJob,
    getImageBatchJob,
    subscribeImageBatchJob,
    abortImageBatchJob,
    disposeImageBatchJob,
    publicImageBatchJob,
    makeBatchJobId,
  };
}

module.exports = { createImageBatchJobHandlers, publicImageBatchJob, makeBatchJobId };
