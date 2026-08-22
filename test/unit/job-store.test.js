'use strict';

// JobStore regression coverage for two failure modes:
//  1. hot-path reads (SSE subscribe / polling / resume) used to pay a full
//     O(n) sweep on every get/has; terminal expiry is now lazy per-entry and
//     running-job retirement stays with the periodic sweeper;
//  2. evicting a still-running job (running TTL or the max-jobs bound) used
//     to leave SSE subscribers hanging with no terminal event; eviction now
//     ends the job in a terminal state and fires onEvict so the app layer can
//     notify subscribers.

const assert = require('assert');
const { JobStore, createJobStores } = require('../../server/jobs/store');
const { createJobEvents } = require('../../server/jobs/events');
const { bindJobOwner } = require('../../server/security/job-ownership');
const { makeTestPrincipal } = require('../helpers/request-principal-fixture');

function makeJob(id, status, updatedAt, extra = {}) {
  return { id, status, createdAt: updatedAt, updatedAt, ...extra };
}

function testTerminalExpiryIsLazyOnTargetedReads() {
  const store = new JobStore('test', { ttlMs: 1000, runningTtlMs: 60_000, maxJobs: 10 });
  const oldDone = makeJob('a', 'done', Date.now());
  const fresh = makeJob('b', 'done', Date.now());
  store.set('a', oldDone);
  store.set('b', fresh);
  // Age the first job past the TTL without triggering another sweep.
  oldDone.updatedAt = Date.now() - 5000;

  assert.strictEqual(store.size, 2);
  // Reading a different entry must not sweep the store (previously get()
  // swept everything, deleting 'a' as a side effect of reading 'b').
  assert.strictEqual(store.get('b'), fresh);
  assert.strictEqual(store.size, 2, 'reading a fresh entry must not sweep unrelated expired entries');
  // Reading the expired entry itself expires it lazily.
  assert.strictEqual(store.get('a'), undefined);
  assert.strictEqual(store.has('a'), false);
  assert.strictEqual(store.size, 1);
}

function testRunningJobRetirementStaysWithSweeper() {
  const store = new JobStore('test', { ttlMs: 60_000, runningTtlMs: 1000, maxJobs: 10 });
  let aborted = false;
  const running = makeJob('run', 'running', Date.now(), { controller: { abort() { aborted = true; } } });
  store.set('run', running);
  running.updatedAt = Date.now() - 5000;

  // Plain reads must not retire running jobs: retirement (and its subscriber
  // notification) belongs to the sweeper so it happens exactly once.
  assert.strictEqual(store.get('run'), running);
  assert.strictEqual(running.status, 'running');
  assert.strictEqual(aborted, false);

  store.sweep();
  assert.strictEqual(running.status, 'error');
  assert.strictEqual(aborted, true);
}

function testRunningTimeoutFiresOnEvict() {
  const evictions = [];
  const store = new JobStore('test', {
    ttlMs: 60_000,
    runningTtlMs: 1000,
    maxJobs: 10,
    onEvict: (job, reason, storeRef) => evictions.push({ id: job.id, reason, storeName: storeRef.name }),
  });
  const running = makeJob('run', 'running', Date.now(), { controller: { abort() {} } });
  store.set('run', running);
  running.updatedAt = Date.now() - 5000;

  store.sweep();
  assert.strictEqual(running.status, 'error');
  assert.ok(running.error, 'retired job must carry a terminal error message');
  assert.deepStrictEqual(evictions, [{ id: 'run', reason: 'running_ttl', storeName: 'test' }]);
}

function testMaxJobsEvictionNotifiesSseSubscribers() {
  const principal = makeTestPrincipal();
  const jobSubscribers = new Map();
  const { notifyJob } = createJobEvents({ jobSubscribers });
  const evictions = [];
  const store = new JobStore('test', {
    ttlMs: 60_000_000,
    runningTtlMs: 60_000_000,
    maxJobs: 1,
    onEvict: (job, reason) => { evictions.push(reason); notifyJob(job); },
  });

  let aborted = false;
  const running = makeJob('victim', 'running', Date.now() - 1000, { controller: { abort() { aborted = true; } } });
  bindJobOwner(running, principal);
  store.set('victim', running);

  const writes = [];
  let ended = false;
  const res = {
    write(chunk) { writes.push(String(chunk)); return true; },
    end() { ended = true; },
    flushHeaders() {},
  };
  jobSubscribers.set('victim', new Set([{ res, principal, job: running }]));

  // Inserting a second job exceeds maxJobs and evicts the oldest (running) one.
  store.set('newer', makeJob('newer', 'running', Date.now(), { controller: { abort() {} } }));

  assert.strictEqual(store.get('victim'), undefined, 'evicted job must leave the store');
  assert.strictEqual(store.size, 1);
  assert.strictEqual(aborted, true, 'evicted running job must be aborted');
  assert.strictEqual(running.status, 'error', 'evicted running job must end terminal, not hang as running');
  assert.ok(running.error, 'evicted running job must carry a terminal error message');
  assert.deepStrictEqual(evictions, ['max_jobs']);
  assert.strictEqual(ended, true, 'SSE subscriber must be ended on eviction');
  const payload = writes.join('');
  assert.ok(payload.includes('"status":"error"'), `subscriber must receive a terminal event, got: ${payload}`);
  assert.strictEqual(jobSubscribers.size, 0, 'subscriber registry must be cleaned up');
}

function testCreateJobStoresSharesOptions() {
  const onEvict = () => {};
  const stores = createJobStores({ onEvict });
  assert.strictEqual(stores.imageJobs.onEvict, onEvict);
  assert.strictEqual(stores.chatJobs.onEvict, onEvict);
  assert.strictEqual(stores.imageBatchJobs.onEvict, onEvict);
}

module.exports = [
  testTerminalExpiryIsLazyOnTargetedReads,
  testRunningJobRetirementStaysWithSweeper,
  testRunningTimeoutFiresOnEvict,
  testMaxJobsEvictionNotifiesSseSubscribers,
  testCreateJobStoresSharesOptions,
];