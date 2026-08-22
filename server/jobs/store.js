const DEFAULT_TTL_MS = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000);
const DEFAULT_RUNNING_TTL_MS = Number(process.env.RUNNING_JOB_TTL_MS || process.env.UPSTREAM_TIMEOUT_MS || 10 * 60 * 1000) + 60 * 1000;
const DEFAULT_MAX_JOBS = Number(process.env.MAX_JOBS_PER_STORE || 200);

class JobStore {
  constructor(name, { ttlMs = DEFAULT_TTL_MS, runningTtlMs = DEFAULT_RUNNING_TTL_MS, maxJobs = DEFAULT_MAX_JOBS, onEvict = null } = {}) {
    this.name = name;
    this.ttlMs = ttlMs;
    this.runningTtlMs = runningTtlMs;
    this.maxJobs = maxJobs;
    this.onEvict = typeof onEvict === 'function' ? onEvict : null;
    this.jobs = new Map();
  }

  get size() { return this.jobs.size; }

  // Reads are hot (SSE subscribe, polling, resume), so they must not pay a
  // full-store sweep. Only the looked-up terminal entry is expired lazily;
  // running-job timeouts stay with the periodic sweeper exactly as before
  // (an untouched store was already only swept on the sweeper interval).
  isTerminalExpired(job, now = Date.now()) {
    if (!job || (job.status !== 'done' && job.status !== 'error')) return false;
    const age = now - Number(job.updatedAt || job.createdAt || now);
    return age > this.ttlMs;
  }

  get(id) {
    const job = this.jobs.get(id);
    if (job && this.isTerminalExpired(job)) {
      this.jobs.delete(id);
      return undefined;
    }
    return job;
  }

  has(id) { return this.get(id) !== undefined; }
  set(id, job) { this.jobs.set(id, job); this.sweep(); return this; }
  delete(id) { return this.jobs.delete(id); }
  values() { this.sweep(); return this.jobs.values(); }

  // A job that leaves the store while still running must end in a terminal
  // state and notify its SSE subscribers. Otherwise the eviction below (or a
  // running-timeout without an onExpire hook) silently abandons subscribers
  // until the client falls back to polling and rediscovers the job is gone.
  retireRunningJob(job, reason, now) {
    if (typeof job.onExpire === 'function') {
      try { job.onExpire(job); } catch {}
    }
    try { job.controller?.abort(); } catch {}
    if (job.status === 'running') {
      job.status = 'error';
      job.error = job.error || (reason === 'max_jobs' ? '任务数超出上限，已自动清理最早的任务' : '任务运行超时，已自动清理');
    }
    job.updatedAt = now;
    if (this.onEvict) {
      try { this.onEvict(job, reason, this); } catch {}
    }
  }

  sweep(now = Date.now()) {
    for (const [id, job] of this.jobs) {
      const age = now - Number(job.updatedAt || job.createdAt || now);
      if (job.status === 'running' && age > this.runningTtlMs) {
        this.retireRunningJob(job, 'running_ttl', now);
      }
      if ((job.status === 'done' || job.status === 'error') && now - Number(job.updatedAt || job.createdAt || now) > this.ttlMs) this.jobs.delete(id);
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
      }
      if (!oldestId) break;
      const evictedJob = this.jobs.get(oldestId);
      if (evictedJob?.status === 'running') {
        this.retireRunningJob(evictedJob, 'max_jobs', now);
      }
      this.jobs.delete(oldestId);
    }
  }
}

function createJobStores(options = {}) {
  return {
    imageJobs: new JobStore('image', options),
    chatJobs: new JobStore('chat', options),
    imageBatchJobs: new JobStore('image_batch', options),
  };
}

function startJobSweeper(stores, intervalMs = Number(process.env.JOB_SWEEP_INTERVAL_MS || 5 * 60 * 1000)) {
  const timer = setInterval(() => stores.forEach(store => store.sweep()), intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { JobStore, createJobStores, startJobSweeper, DEFAULT_TTL_MS, DEFAULT_RUNNING_TTL_MS, DEFAULT_MAX_JOBS };