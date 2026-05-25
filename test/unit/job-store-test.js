#!/usr/bin/env node
const assert = require('assert');
const { JobStore, createJobStores } = require('../../server/jobs/store');

const stores = createJobStores();
assert.ok(stores.imageJobs instanceof JobStore, 'image job store is created through factory');
assert.ok(stores.chatJobs instanceof JobStore, 'chat job store is created through factory');
assert.strictEqual(stores.imageJobs.name, 'image');
assert.strictEqual(stores.chatJobs.name, 'chat');

const store = new JobStore('test', { ttlMs: 10, maxJobs: 2 });
store.set('done-old', { id: 'done-old', status: 'done', updatedAt: 1 });
store.set('running-old', { id: 'running-old', status: 'running', updatedAt: 1 });
store.sweep(100);
assert.strictEqual(store.has('done-old'), false, 'completed jobs expire by ttl');
assert.strictEqual(store.has('running-old'), true, 'running jobs are kept during ttl sweep');

store.set('done-1', { id: 'done-1', status: 'done', updatedAt: 101 });
store.set('done-2', { id: 'done-2', status: 'done', updatedAt: 102 });
store.set('done-3', { id: 'done-3', status: 'done', updatedAt: 103 });
store.sweep(104);
assert.ok(store.size <= 2, 'maxJobs removes oldest non-running jobs');
assert.strictEqual(store.has('running-old'), true, 'maxJobs does not remove running jobs first');

console.log('job store ok');
