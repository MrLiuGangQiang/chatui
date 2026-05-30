#!/usr/bin/env node
const assert = require('assert');
const { makeRun, getActiveRun, ensureActiveRun, addActiveRunJob, isRunStopped, bindFollowingRun } = require('../../client/app/runs');

const state = { activeRuns: new Map() };
assert.strictEqual(getActiveRun(state, 's1'), null);
const run = ensureActiveRun(state, 's1', id => ({ ...makeRun(id, () => 123456, () => 0.123456), abortController: {} }));
assert.ok(run.token.startsWith('run_'));
assert.strictEqual(getActiveRun(state, 's1'), run);
assert.strictEqual(addActiveRunJob(state, 's1', 'chat', 'job1'), true);
assert.deepStrictEqual([...run.jobIds], ['chat:job1']);
assert.strictEqual(isRunStopped(state, 's1'), false);
run.stopped = true;
assert.strictEqual(isRunStopped(state, 's1'), true);
const following = bindFollowingRun(state, 's2', 'job2', 'chat', id => ({ ...makeRun(id, () => 123457, () => 0.654321), abortController: {} }));
assert.strictEqual(getActiveRun(state, 's2'), following);
assert.deepStrictEqual([...following.jobIds], ['chat:job2']);
console.log('app runs ok');
