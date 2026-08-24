'use strict';

const JOB_CANCELLATION = Symbol('chatui.job.cancellation');

function cancellationError(message = '任务已停止', code = 'JOB_CANCELLED') {
  const error = new Error(String(message || '任务已停止'));
  error.name = 'AbortError';
  error.code = String(code || 'JOB_CANCELLED');
  error.cancelled = true;
  return error;
}

function ensureJobCancellation(job) {
  if (!job || typeof job !== 'object') return null;
  if (!job[JOB_CANCELLATION]) {
    Object.defineProperty(job, JOB_CANCELLATION, {
      value: {
        controller: new AbortController(),
        requested: false,
        message: '',
        code: '',
        reason: '',
        error: null,
      },
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  return job[JOB_CANCELLATION];
}

function jobCancellationSignal(job) {
  return ensureJobCancellation(job)?.controller.signal || null;
}

function requestJobCancellation(job, {
  message = '任务已停止',
  code = 'JOB_CANCELLED',
  reason = 'cancelled',
} = {}) {
  const state = ensureJobCancellation(job);
  if (!state) return null;
  if (!state.requested) {
    state.requested = true;
    state.message = String(message || '任务已停止');
    state.code = String(code || 'JOB_CANCELLED');
    state.reason = String(reason || 'cancelled');
    state.error = cancellationError(state.message, state.code);
  }
  if (!state.controller.signal.aborted) state.controller.abort(state.error);
  try { job.controller?.abort?.(state.error); } catch {}
  return state;
}

function isJobCancellationRequested(job) {
  const state = ensureJobCancellation(job);
  return !!state?.requested || !!state?.controller.signal.aborted;
}

function jobCancellationMessage(job, fallback = '任务已停止') {
  return String(ensureJobCancellation(job)?.message || fallback || '任务已停止');
}

function jobCanRun(job) {
  return !!job && job.status === 'running' && !isJobCancellationRequested(job);
}

function preserveJobCancellation(job, fallback = '任务已停止') {
  if (!isJobCancellationRequested(job)) return false;
  job.status = 'error';
  job.error = jobCancellationMessage(job, fallback);
  return true;
}

function failJobIfRunning(job, error) {
  if (!job || preserveJobCancellation(job)) return false;
  if (job.status !== 'running') return false;
  job.status = 'error';
  job.error = error?.message || String(error || '任务失败');
  job.updatedAt = Date.now();
  return true;
}

function releaseJobIdempotency(job, idempotencyTable) {
  if (!job || !idempotencyTable || typeof idempotencyTable.release !== 'function') return false;
  const key = String(job.idempotencyKey || '').trim();
  const fingerprint = String(job.idempotencyFingerprint || '').trim();
  if (!key) return false;
  return idempotencyTable.release({
    key,
    fingerprint,
    scope: String(job.idempotencyScope || ''),
    result: String(job.id || ''),
  });
}

module.exports = {
  JOB_CANCELLATION,
  cancellationError,
  ensureJobCancellation,
  failJobIfRunning,
  isJobCancellationRequested,
  jobCancellationMessage,
  jobCancellationSignal,
  jobCanRun,
  preserveJobCancellation,
  requestJobCancellation,
  releaseJobIdempotency,
};
