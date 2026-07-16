const { isManagedRequest, ownerIdFromRequest } = require('../jobs/ownership');

function admissionError() {
  const err = new Error('当前账号的任务数量已达上限，请等待现有任务完成后再试');
  err.statusCode = 429;
  err.code = 'PRINCIPAL_JOB_LIMIT_EXCEEDED';
  return err;
}

class PrincipalJobAdmission {
  constructor({ maxJobsPerPrincipal = 0 } = {}) {
    this.maxJobsPerPrincipal = Math.max(0, Number(maxJobsPerPrincipal) || 0);
    this.jobsByPrincipal = new Map();
  }

  reserve(job, req) {
    if (!isManagedRequest(req) || !this.maxJobsPerPrincipal) return job;
    const principalId = ownerIdFromRequest(req);
    const jobId = String(job?.id || '');
    if (!principalId || !jobId) throw new TypeError('managed job admission requires a principal and job id');
    const jobs = this.jobsByPrincipal.get(principalId) || new Set();
    if (!jobs.has(jobId) && jobs.size >= this.maxJobsPerPrincipal) throw admissionError();
    jobs.add(jobId);
    this.jobsByPrincipal.set(principalId, jobs);
    job.admissionPrincipalId = principalId;
    job.releaseAdmission = () => this.release(job);
    return job;
  }

  release(job) {
    const principalId = String(job?.admissionPrincipalId || '');
    const jobId = String(job?.id || '');
    if (!principalId || !jobId) return false;
    const jobs = this.jobsByPrincipal.get(principalId);
    if (!jobs) return false;
    const removed = jobs.delete(jobId);
    if (!jobs.size) this.jobsByPrincipal.delete(principalId);
    delete job.admissionPrincipalId;
    delete job.releaseAdmission;
    return removed;
  }

  activeFor(principalId) {
    return this.jobsByPrincipal.get(String(principalId || ''))?.size || 0;
  }

  dispose() {
    this.jobsByPrincipal.clear();
  }
}

function createPrincipalJobAdmission(config = {}) {
  return new PrincipalJobAdmission({ maxJobsPerPrincipal: config.maxManagedJobsPerPrincipal });
}

function reserveManagedJob(job, req, admission) {
  return admission?.reserve ? admission.reserve(job, req) : job;
}

function releaseManagedJob(job, admission) {
  return admission?.release ? admission.release(job) : false;
}

module.exports = {
  PrincipalJobAdmission,
  admissionError,
  createPrincipalJobAdmission,
  reserveManagedJob,
  releaseManagedJob,
};
