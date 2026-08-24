// Simple concurrency limiter — prevents upstream request floods
function abortErrorForSignal(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Operation cancelled while waiting for an upstream slot');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

class ConcurrencyLimiter {
  constructor(max, { maxQueue = Infinity } = {}) {
    this.max = Math.max(1, Number(max) || 50);
    this.maxQueue = Number.isFinite(Number(maxQueue)) ? Math.max(0, Number(maxQueue)) : Infinity;
    this.running = 0;
    this.queue = [];
  }

  acquire({ signal = null } = {}) {
    if (signal?.aborted) return Promise.reject(abortErrorForSignal(signal));
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      const err = new Error('请求过多，请稍后重试');
      err.statusCode = 429;
      err.code = 'TOO_MANY_REQUESTS';
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: null, settled: false };
      const cleanup = () => {
        if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
      };
      entry.cleanup = cleanup;
      entry.abort = () => {
        if (entry.settled) return;
        entry.settled = true;
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        cleanup();
        reject(abortErrorForSignal(signal));
      };
      if (signal) signal.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  release() {
    this.running = Math.max(0, this.running - 1);
    while (this.queue.length) {
      const next = this.queue.shift();
      if (!next || next.settled) continue;
      if (next.signal?.aborted) {
        next.abort();
        continue;
      }
      next.settled = true;
      next.cleanup?.();
      this.running++;
      next.resolve();
      break;
    }
  }

  get pending() { return this.queue.length; }
  get active() { return this.running; }
}

const MAX_UPSTREAM_CONCURRENCY = Number(process.env.MAX_UPSTREAM_CONCURRENCY || 30);
const MAX_UPSTREAM_QUEUE = Number(process.env.MAX_UPSTREAM_QUEUE || 100);
const limiter = new ConcurrencyLimiter(MAX_UPSTREAM_CONCURRENCY, { maxQueue: MAX_UPSTREAM_QUEUE });

async function withLimiter(currentLimiter, fn, { signal = null } = {}) {
  await currentLimiter.acquire({ signal });
  try {
    if (signal?.aborted) throw abortErrorForSignal(signal);
    return await fn();
  } finally {
    currentLimiter.release();
  }
}

module.exports = { limiter, withLimiter, ConcurrencyLimiter, abortErrorForSignal };
