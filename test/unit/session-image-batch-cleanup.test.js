'use strict';

const assert = require('assert');
const { createSessionResourceLifecycle } = require('../../client/app/session-resources');
const helpers = require('../../client/app/submit-workflow.helpers');
const jobs = require('../../client/services/job-service');

function makeStorage(entries) {
  const values = new Map(entries);
  return { get length() { return values.size; }, key: i => [...values.keys()][i],
    getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
}

async function testDeletingSessionRemovesBatchParentChildrenAndOnlyItsRecoveryKeys() {
  const a = { id: 'session-a', display: [] };
  const b = { id: 'session-a-extra', display: [] };
  const parent = 'imgbatch-parent123';
  const child = 'imgjob-child123';
  const orphan = 'imgjob-orphan123';
  const other = helpers.imageBatchChildKey(b.id, child);
  const storage = makeStorage([
    [helpers.imageBatchIndexKey(a.id), JSON.stringify({ schema_version:'image_batch.v1', batchId:parent, children:[{jobId:child,prompt:'a'}] })],
    [helpers.imageBatchChildKey(a.id, child), JSON.stringify({ id: child })],
    [helpers.imageBatchChildKey(a.id, orphan), JSON.stringify({ id: orphan })],
    [other, '{}'],
  ]);
  const run = { abortController: new AbortController(), jobIds: new Set(['image_batch:' + parent]) };
  const state = { sessions:[a,b], activeRuns: new Map([[a.id,run]]), resumingJobs: new Set(['image_batch:' + a.id,'image_batch:' + b.id]), followingImageJobs:new Set([child,orphan,'imgjob-other123']) };
  const disposed = [];
  const lifecycle = createSessionResourceLifecycle({ getState:()=>state, localStorage:storage,
    disposeManagedJob: async (kind,id)=>disposed.push([kind,id]), document:{} });
  await lifecycle.disposeSessions([a],[b]);
  assert.strictEqual(storage.getItem(helpers.imageBatchIndexKey(a.id)), null);
  assert.strictEqual(storage.getItem(helpers.imageBatchChildKey(a.id, child)), null);
  assert.strictEqual(storage.getItem(helpers.imageBatchChildKey(a.id, orphan)), null);
  assert.strictEqual(storage.getItem(other),'{}');
  assert(disposed.some(([kind,id])=>kind==='image_batch' && id===parent));
  assert(!state.resumingJobs.has('image_batch:' + a.id));
  assert(state.resumingJobs.has('image_batch:' + b.id));
  assert(!state.followingImageJobs.has(child));
  assert(!state.followingImageJobs.has(orphan));
  assert(state.followingImageJobs.has('imgjob-other123'));
  assert(run.abortController.signal.aborted);
  assert(lifecycle.isSessionDisposed(a.id));
}

async function testDeletingSessionFindsBatchChildrenDespiteDamagedIndex() {
  const key = helpers.imageBatchChildKey('a','imgjob-test12345');
  const storage = makeStorage([[helpers.imageBatchIndexKey('a'),'{broken'],[key,'{}']]);
  const lifecycle = createSessionResourceLifecycle({ getState:()=>({}), localStorage:storage, document:{} });
  await lifecycle.disposeSessions([{id:'a'}]);
  assert.strictEqual(storage.getItem(key),null);
}

async function testManagedBatchDisposeAndAbortUseParentEndpoints() {
  const requests = [];
  const fetchImpl = async (url,options)=>{ requests.push([url,options.method]);return {ok:true}; };
  await jobs.disposeManagedJob({kind:'image_batch',jobId:'imgbatch-test123',fetchImpl});
  await jobs.abortManagedJob({kind:'image_batch',jobId:'imgbatch-test123',fetchImpl});
  assert.deepStrictEqual(requests,[['/api/image-batches/imgbatch-test123','DELETE'],['/api/image-batches/imgbatch-test123/abort','POST']]);
}

module.exports = [testDeletingSessionRemovesBatchParentChildrenAndOnlyItsRecoveryKeys, testDeletingSessionFindsBatchChildrenDespiteDamagedIndex, testManagedBatchDisposeAndAbortUseParentEndpoints];
