const { assertRuntimeConfig } = require('./config/runtime-config');

// Bounded FIFO limiter for upstream and extraction work.  A limiter is owned by
// an application runtime; the module-level instances below remain only as a
// compatibility adapter for callers that use this module directly.
class ConcurrencyLimiter {
  constructor(max, { maxQueue = Infinity } = {}) {
    this.max = Math.max(1, Number(max) || 50);
    this.maxQueue = Number.isFinite(Number(maxQueue)) ? Math.max(0, Number(maxQueue)) : Infinity;
    this.running = 0;
    this.queue = [];
    this.closed = false;
  }

  acquire() {
    if (this.closed) return Promise.reject(this.#closedError());
    if (this.running < this.max) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      const err = new Error('Too many requests, please retry later.');
      err.statusCode = 429;
      err.code = 'TOO_MANY_REQUESTS';
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  release() {
    this.running = Math.max(0, this.running - 1);
    const next = this.queue.shift();
    if (next) {
      this.running += 1;
      next.resolve();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = this.#closedError();
    for (const queued of this.queue.splice(0)) queued.reject(error);
  }

  #closedError() {
    const err = new Error('Service is shutting down.');
    err.statusCode = 503;
    err.code = 'SERVICE_SHUTTING_DOWN';
    return err;
  }

  get pending() { return this.queue.length; }
  get active() { return this.running; }
}

function createConcurrencyServices(config = assertRuntimeConfig()) {
  const upstreamLimiter = new ConcurrencyLimiter(config.maxUpstreamConcurrency, { maxQueue: config.maxUpstreamQueue });
  const extractLimiter = new ConcurrencyLimiter(config.maxExtractConcurrency, { maxQueue: config.maxExtractQueue });
  return Object.freeze({
    upstreamLimiter,
    extractLimiter,
    dispose() {
      upstreamLimiter.close();
      extractLimiter.close();
    },
  });
}

async function withLimiter(currentLimiter, fn) {
  await currentLimiter.acquire();
  try { return await fn(); }
  finally { currentLimiter.release(); }
}

const legacyServices = createConcurrencyServices();
const limiter = legacyServices.upstreamLimiter;
const extractLimiter = legacyServices.extractLimiter;

module.exports = { limiter, extractLimiter, withLimiter, ConcurrencyLimiter, createConcurrencyServices };
