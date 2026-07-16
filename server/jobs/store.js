const { assertRuntimeConfig } = require('../config/runtime-config');

const legacyRuntimeConfig = assertRuntimeConfig();

function releaseJobAdmission(job) {
  try { job?.releaseAdmission?.(); } catch {}
}
const DEFAULT_TTL_MS = legacyRuntimeConfig.jobTtlMs;
const DEFAULT_RUNNING_TTL_MS = legacyRuntimeConfig.runningJobTtlMs;
const DEFAULT_MAX_JOBS = legacyRuntimeConfig.maxJobsPerStore;

class JobStore {
  constructor(name, { ttlMs = DEFAULT_TTL_MS, runningTtlMs = DEFAULT_RUNNING_TTL_MS, maxJobs = DEFAULT_MAX_JOBS } = {}) {
    this.name = name;
    this.ttlMs = ttlMs;
    this.runningTtlMs = runningTtlMs;
    this.maxJobs = maxJobs;
    this.jobs = new Map();
  }

  get size() { return this.jobs.size; }
  get(id) { this.sweep(); return this.jobs.get(id); }
  has(id) { this.sweep(); return this.jobs.has(id); }
  set(id, job) {
    const previous = this.jobs.get(id);
    if (previous && previous !== job) releaseJobAdmission(previous);
    this.jobs.set(id, job);
    this.sweep();
    return this;
  }
  delete(id) {
    const job = this.jobs.get(id);
    releaseJobAdmission(job);
    return this.jobs.delete(id);
  }
  values() { this.sweep(); return this.jobs.values(); }

  dispose() {
    for (const job of this.jobs.values()) {
      try { job?.controller?.abort(); } catch {}
      releaseJobAdmission(job);
    }
    this.jobs.clear();
  }

  sweep(now = Date.now()) {
    for (const [id, job] of this.jobs) {
      if (job.status === 'done' || job.status === 'error') releaseJobAdmission(job);
      const age = now - Number(job.updatedAt || job.createdAt || now);
      if (job.status === 'running' && age > this.runningTtlMs) {
        try { job.controller?.abort(); } catch {}
        job.status = 'error';
        job.error = job.error || '????????????';
        job.updatedAt = now;
        releaseJobAdmission(job);
      }
      if ((job.status === 'done' || job.status === 'error') && age > this.ttlMs) this.delete(id);
    }
    while (this.jobs.size > this.maxJobs) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, job] of this.jobs) {
        const at = Number(job.updatedAt || job.createdAt || 0);
        if (at < oldestAt && job.status !== 'running') { oldestAt = at; oldestId = id; }
      }
      if (!oldestId) {
        for (const [id, job] of this.jobs) {
          const at = Number(job.updatedAt || job.createdAt || 0);
          if (at < oldestAt) { oldestAt = at; oldestId = id; }
        }
        if (oldestId) {
          const job = this.jobs.get(oldestId);
          try { job?.controller?.abort(); } catch {}
        }
      }
      if (!oldestId) break;
      this.delete(oldestId);
    }
  }
}

function createJobStores({ ttlMs, runningTtlMs, maxJobs } = {}) {
  const options = { ttlMs, runningTtlMs, maxJobs };
  return {
    imageJobs: new JobStore('image', options),
    chatJobs: new JobStore('chat', options),
  };
}

function startJobSweeper(stores, intervalMs = legacyRuntimeConfig.jobSweepIntervalMs) {
  const timer = setInterval(() => stores.forEach(store => store.sweep()), intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { JobStore, createJobStores, startJobSweeper, releaseJobAdmission, DEFAULT_TTL_MS, DEFAULT_RUNNING_TTL_MS, DEFAULT_MAX_JOBS };
