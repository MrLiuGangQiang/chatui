// Simple concurrency limiter — prevents upstream request floods
class ConcurrencyLimiter {
  constructor(max, { maxQueue = Infinity } = {}) {
    this.max = Math.max(1, Number(max) || 50);
    this.maxQueue = Number.isFinite(Number(maxQueue)) ? Math.max(0, Number(maxQueue)) : Infinity;
    this.running = 0;
    this.queue = [];
  }

  acquire() {
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
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.running = Math.max(0, this.running - 1);
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }

  get pending() { return this.queue.length; }
  get active() { return this.running; }
}

const MAX_UPSTREAM_CONCURRENCY = Number(process.env.MAX_UPSTREAM_CONCURRENCY || 30);
const MAX_UPSTREAM_QUEUE = Number(process.env.MAX_UPSTREAM_QUEUE || 100);
const MAX_EXTRACT_CONCURRENCY = Number(process.env.MAX_EXTRACT_CONCURRENCY || 3);
const MAX_EXTRACT_QUEUE = Number(process.env.MAX_EXTRACT_QUEUE || 20);
const limiter = new ConcurrencyLimiter(MAX_UPSTREAM_CONCURRENCY, { maxQueue: MAX_UPSTREAM_QUEUE });
const extractLimiter = new ConcurrencyLimiter(MAX_EXTRACT_CONCURRENCY, { maxQueue: MAX_EXTRACT_QUEUE });

async function withLimiter(currentLimiter, fn) {
  await currentLimiter.acquire();
  try { return await fn(); }
  finally { currentLimiter.release(); }
}

module.exports = { limiter, extractLimiter, withLimiter, ConcurrencyLimiter };
