const DEFAULT_TTL_MS = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000);
const DEFAULT_RUNNING_TTL_MS = Number(process.env.RUNNING_JOB_TTL_MS || process.env.UPSTREAM_TIMEOUT_MS || 10 * 60 * 1000) + 60 * 1000;
const DEFAULT_MAX_JOBS = Number(process.env.MAX_JOBS_PER_STORE || 200);

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
  set(id, job) { this.jobs.set(id, job); this.sweep(); return this; }
  delete(id) { return this.jobs.delete(id); }
  values() { this.sweep(); return this.jobs.values(); }

  sweep(now = Date.now()) {
    for (const [id, job] of this.jobs) {
      const age = now - Number(job.updatedAt || job.createdAt || now);
      if (job.status === 'running' && age > this.runningTtlMs) {
        try { job.controller?.abort(); } catch {}
        job.status = 'error';
        job.error = job.error || '任务运行超时，已自动清理';
        job.updatedAt = now;
      }
      if ((job.status === 'done' || job.status === 'error') && age > this.ttlMs) this.jobs.delete(id);
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
      this.jobs.delete(oldestId);
    }
  }
}

function createJobStores() {
  return {
    imageJobs: new JobStore('image'),
    chatJobs: new JobStore('chat'),
  };
}

function startJobSweeper(stores, intervalMs = Number(process.env.JOB_SWEEP_INTERVAL_MS || 5 * 60 * 1000)) {
  const timer = setInterval(() => stores.forEach(store => store.sweep()), intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { JobStore, createJobStores, startJobSweeper, DEFAULT_TTL_MS, DEFAULT_RUNNING_TTL_MS, DEFAULT_MAX_JOBS };
