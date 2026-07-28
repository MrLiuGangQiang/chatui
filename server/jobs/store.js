const { MAX_TIMER_MS, positiveInteger, timeoutMilliseconds } = require('../config/numbers');

const DEFAULT_TTL_MS = timeoutMilliseconds(process.env.JOB_TTL_MS, 60 * 60 * 1000);
const explicitRunningTtl = String(process.env.RUNNING_JOB_TTL_MS || '').trim();
const DEFAULT_RUNNING_TTL_MS = explicitRunningTtl
  ? timeoutMilliseconds(explicitRunningTtl, 11 * 60 * 1000)
  : Math.min(MAX_TIMER_MS, timeoutMilliseconds(process.env.UPSTREAM_TIMEOUT_MS, 10 * 60 * 1000) + 60 * 1000);
const DEFAULT_MAX_JOBS = positiveInteger(process.env.MAX_JOBS_PER_STORE, 200, { max: 100_000 });

class JobStore {
  constructor(name, { ttlMs = DEFAULT_TTL_MS, runningTtlMs = DEFAULT_RUNNING_TTL_MS, maxJobs = DEFAULT_MAX_JOBS, onTransition = null } = {}) {
    this.name = name;
    this.ttlMs = timeoutMilliseconds(ttlMs, DEFAULT_TTL_MS);
    this.runningTtlMs = timeoutMilliseconds(runningTtlMs, DEFAULT_RUNNING_TTL_MS);
    this.maxJobs = positiveInteger(maxJobs, DEFAULT_MAX_JOBS, { max: 100_000 });
    this.onTransition = typeof onTransition === 'function' ? onTransition : null;
    this.jobs = new Map();
  }

  get size() { return this.jobs.size; }
  get(id) { this.sweep(); return this.jobs.get(id); }
  has(id) { this.sweep(); return this.jobs.has(id); }
  setTransitionHandler(handler) { this.onTransition = typeof handler === 'function' ? handler : null; return this; }
  set(id, job) {
    this.sweep();
    if (!this.jobs.has(id)) {
      while (this.jobs.size >= this.maxJobs) {
        const oldestTerminalId = this.oldestTerminalJobId();
        if (!oldestTerminalId) {
          const err = new Error('任务队列已满，请等待现有任务完成后重试');
          err.statusCode = 503;
          err.code = 'JOB_STORE_FULL';
          throw err;
        }
        this.jobs.delete(oldestTerminalId);
      }
    }
    this.jobs.set(id, job);
    return this;
  }
  delete(id) { return this.jobs.delete(id); }
  values() { this.sweep(); return this.jobs.values(); }

  oldestTerminalJobId() {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'done' && job.status !== 'error') continue;
      const at = Number(job.updatedAt || job.createdAt || 0);
      if (at < oldestAt) { oldestAt = at; oldestId = id; }
    }
    return oldestId;
  }

  notifyTransition(job, reason) {
    if (!this.onTransition) return;
    try { this.onTransition(job, reason); } catch {}
  }

  sweep(now = Date.now()) {
    for (const [id, job] of this.jobs) {
      const age = now - Number(job.updatedAt || job.createdAt || now);
      if (job.status === 'running' && age > this.runningTtlMs) {
        try { job.controller?.abort(); } catch {}
        job.status = 'error';
        job.error = job.error || '任务运行超时，已自动清理';
        job.updatedAt = now;
        this.notifyTransition(job, 'running-timeout');
        // Retain the freshly transitioned terminal state for a full terminal
        // TTL so polling clients can observe the timeout result.
        continue;
      }
      if ((job.status === 'done' || job.status === 'error') && age > this.ttlMs) this.jobs.delete(id);
    }
    while (this.jobs.size > this.maxJobs) {
      const oldestId = this.oldestTerminalJobId();
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

function startJobSweeper(stores, intervalMs = timeoutMilliseconds(process.env.JOB_SWEEP_INTERVAL_MS, 5 * 60 * 1000)) {
  const safeInterval = timeoutMilliseconds(intervalMs, 5 * 60 * 1000);
  const timer = setInterval(() => stores.forEach(store => store.sweep()), safeInterval);
  timer.unref?.();
  return timer;
}

module.exports = { JobStore, createJobStores, startJobSweeper, DEFAULT_TTL_MS, DEFAULT_RUNNING_TTL_MS, DEFAULT_MAX_JOBS };
