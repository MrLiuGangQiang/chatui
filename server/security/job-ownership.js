'use strict';

const crypto = require('crypto');
const { principalOwnerKey } = require('./request-principal');

const JOB_ID_CONFLICT_MESSAGE = '任务标识不可用，请重新提交';

const JOB_OWNER_KEY = Symbol('chatui.job.owner');

function ownershipError(message, code, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function sameKey(left, right) {
  return Buffer.isBuffer(left)
    && Buffer.isBuffer(right)
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

function assertRequestPrincipal(req) {
  const principal = req?.authPrincipal;
  if (!principalOwnerKey(principal)) {
    throw ownershipError('Request principal is unavailable', 'REQUEST_PRINCIPAL_UNAVAILABLE');
  }
  return principal;
}

function bindJobOwner(job, principal) {
  if (!job || typeof job !== 'object') throw ownershipError('Job owner can only be bound to a job object', 'INVALID_JOB_OWNER_TARGET');
  const ownerKey = principalOwnerKey(principal);
  if (!ownerKey) throw ownershipError('Request principal is unavailable', 'REQUEST_PRINCIPAL_UNAVAILABLE');
  const existing = job[JOB_OWNER_KEY];
  if (existing) {
    if (!sameKey(existing, ownerKey)) throw ownershipError('Job owner is immutable', 'JOB_OWNER_IMMUTABLE', 409);
    return job;
  }
  Object.defineProperty(job, JOB_OWNER_KEY, {
    value: Buffer.from(ownerKey),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return job;
}

function jobOwnedBy(job, principal) {
  return sameKey(job?.[JOB_OWNER_KEY], principalOwnerKey(principal));
}

function findOwnedJob(store, id, principal) {
  const job = store?.get?.(id);
  return jobOwnedBy(job, principal) ? job : null;
}

function jobIdConflictError() {
  return ownershipError(JOB_ID_CONFLICT_MESSAGE, 'JOB_ID_CONFLICT', 409);
}

function assertJobOwnedBy(job, principal) {
  if (!jobOwnedBy(job, principal)) throw jobIdConflictError();
  return job;
}

module.exports = {
  JOB_ID_CONFLICT_MESSAGE,
  assertJobOwnedBy,
  assertRequestPrincipal,
  bindJobOwner,
  findOwnedJob,
  jobIdConflictError,
  jobOwnedBy,
};
