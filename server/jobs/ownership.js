function isManagedRequest(req) {
  return req?.authRequired === true;
}

function ownerIdFromRequest(req) {
  return isManagedRequest(req) ? String(req?.principal?.id || '') : '';
}

function assignJobOwner(job, req) {
  if (!job || typeof job !== 'object') return job;
  job.ownerId = ownerIdFromRequest(req);
  return job;
}

function canAccessJob(job, req) {
  if (!isManagedRequest(req)) return true;
  const principalId = ownerIdFromRequest(req);
  return Boolean(principalId && String(job?.ownerId || '') === principalId);
}

function jobNotFoundPayload({ includeCode = false } = {}) {
  const error = { message: '\u4efb\u52a1\u4e0d\u5b58\u5728\u6216\u670d\u52a1\u5df2\u91cd\u542f' };
  if (includeCode) error.code = 'JOB_NOT_FOUND';
  return { error };
}

module.exports = {
  isManagedRequest,
  ownerIdFromRequest,
  assignJobOwner,
  canAccessJob,
  jobNotFoundPayload,
};
