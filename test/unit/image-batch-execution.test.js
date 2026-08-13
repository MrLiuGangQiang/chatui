'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const submitHelpers = require('../../client/app/submit-workflow.helpers');

function batchRoute(items) {
  return { imagePlanCompiled: { kind: 'batch', items } };
}

function generateItem(prompt) {
  return {
    api: 'image_generation',
    dispatchContract: { arguments: { prompt } },
    executionResources: { images: [], files: [] },
    route: {},
  };
}

function testExecutableImageBatchAcceptsGenerationAndMediaChildren() {
  const route = batchRoute([generateItem('猫'), generateItem('狗'), generateItem('鸟')]);
  const executable = submitHelpers.executableImageBatch(route);
  assert.ok(executable);
  assert.strictEqual(executable.unsupported, null);
  assert.strictEqual(executable.items.length, 3);

  assert.strictEqual(submitHelpers.executableImageBatch({}), null);
  assert.strictEqual(submitHelpers.executableImageBatch({ imagePlanCompiled: null }), null);
  assert.strictEqual(submitHelpers.executableImageBatch({ imagePlanCompiled: { kind: 'single' } }), null);
  assert.strictEqual(submitHelpers.executableImageBatch(batchRoute([generateItem('only')])), null,
    'a one-item plan must collapse through the single-image path');

  const editChild = { ...generateItem('改猫'), api: 'image_edit' };
  assert.strictEqual(submitHelpers.executableImageBatch(batchRoute([editChild, generateItem('狗')])).unsupported, null,
    'edit children must use the canonical per-child executor instead of being flattened');

  const mediaChild = { ...generateItem('参考图生图'), executionResources: { images: [{}], files: [] } };
  assert.strictEqual(submitHelpers.executableImageBatch(batchRoute([generateItem('猫'), mediaChild])).unsupported, null,
    'media-bearing children are executable when their per-child projection resolves');
}

async function testSerialCommitQueueSerializesConcurrentResultCommits() {
  const queue = submitHelpers.createSerialCommitQueue();
  const order = [];

  const releaseFirst = await queue.acquire();
  order.push('first-enter');
  let releaseSecond = null;
  const secondEntered = queue.acquire().then(release => { releaseSecond = release; order.push('second-enter'); });
  const thirdEntered = queue.acquire().then(release => { order.push('third-enter'); release(); });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(order, ['first-enter'], 'later commits must wait until the earlier release');
  releaseFirst();
  await secondEntered;
  assert.deepStrictEqual(order, ['first-enter', 'second-enter']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(order, ['first-enter', 'second-enter'], 'third commit must stay blocked until second releases');
  assert.strictEqual(typeof releaseSecond, 'function');
  releaseSecond();
  await thirdEntered;
  assert.deepStrictEqual(order, ['first-enter', 'second-enter', 'third-enter']);
}

function testImageWorkflowCarriesBatchCoordinationFlags() {
  const imageWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  assert.match(imageWorkflow, /t\.skipDurableSnapshot/);
  assert.match(imageWorkflow, /t\.deferBatchCompletion/);
  assert.match(imageWorkflow, /t\.acquireResultCommit/);
  assert.match(imageWorkflow, /batchResultRelease/);
  assert.ok(imageWorkflow.includes('batchResultRelease = await t.acquireResultCommit()'), 'child result commits must acquire the serial queue before mutating session messages');
  assert.ok(imageWorkflow.includes('batchResultRelease && (batchResultRelease(), batchResultRelease = null)'), 'child result commits must release the serial queue');
  assert.ok(imageWorkflow.includes('const statusText = value =>'), 'child rows must render a prefixed per-task status');
  assert.ok(imageWorkflow.includes('safeSetJsonStorage(root.localStorage, t.batchChildKey, job) ? job : null'),
    'successful batch snapshot persistence must return the saved job object to recoverability validation');
}

function testSubmitWorkflowFansOutBatchChildrenConcurrently() {
  const submitWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const imageWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  assert.match(submitWorkflow, /Promise\.allSettled\(batchChildren\)/);
  assert.ok(submitWorkflow.includes('compiledBatch.items.map((item,batchIndex)'), 'each planned task must become one child execution');
  assert.ok(submitWorkflow.includes('const batchParent=liveItem||appendSessionDisplayMessage'),
    'a multi-image request must allocate one parent assistant display item');
  assert.ok(!submitWorkflow.includes('const batchRows=[]'),
    'batch fan-out must not allocate one display row per child task');
  assert.ok(submitWorkflow.includes('liveItem:batchParent'),
    'all child executions must aggregate into the shared parent message');
  assert.ok(submitWorkflow.includes('batchAggregate,batchIndex'),
    'children keep internal ordinal/progress state without creating UI rows');
  assert.ok(submitWorkflow.includes('batchChildKey:submitHelpers.imageBatchChildKey(sessionId,childJobId)'), 'each batch child must persist under its own durable recovery key');
  assert.ok(submitWorkflow.includes('deferBatchCompletion:!0'), 'batch children must defer terminal sound/interface signals to the batch');
  assert.ok(submitWorkflow.includes('acquireResultCommit:acquireBatchResultCommit'), 'batch children must serialize session message commits');
  assert.ok(submitWorkflow.includes('statusPrefix:`任务 ${batchIndex+1}/${compiledBatch.items.length}`'), 'each child row must carry its task ordinal prefix');
  assert.ok(submitWorkflow.includes('sendImage(childPrompt,'), 'batch dispatch must reuse the canonical single-image executor');
  assert.ok(submitWorkflow.includes('loadingNode:batchIndex===0?assistantNode:null'),
    'non-leading children must be display-only instead of receiving inert pseudo-DOM nodes');
  assert.ok(imageWorkflow.includes('if (d?.dataset && c)'),
    'image execution must only bind display identity on real message nodes with a dataset');
  assert.ok(imageWorkflow.includes('mergeImageResultContexts(priorBatchImageContext, childResultImageContext)'),
    'each child result must merge into the parent image context instead of replacing it');
  assert.ok(imageWorkflow.includes('if (isBatchChild) {'),
    'batch completion must update the shared parent message rather than append child messages');
  assert.ok(imageWorkflow.includes('statuses.map((status, index)'),
    'the shared parent message must expose one progress line per internal child task');
  assert.ok(imageWorkflow.includes("status || '等待开始'"),
    'each child progress line must preserve an explicit waiting state');
}

module.exports = [
  testExecutableImageBatchAcceptsGenerationAndMediaChildren,
  testSerialCommitQueueSerializesConcurrentResultCommits,
  testImageWorkflowCarriesBatchCoordinationFlags,
  testSubmitWorkflowFansOutBatchChildrenConcurrently,
];
