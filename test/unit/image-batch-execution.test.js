'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const submitHelpers = require('../../client/app/submit-workflow.helpers');
const imageWorkflow = require('../../client/app/image-workflow');
const imageResultWorkflow = require('../../client/app/image-result-workflow');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

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

function testCompiledBatchParentSkipsSingleExecutionProjection() {
  const parent = {
    imagePlanCompiled: {
      kind: 'batch',
      items: [
        { route: { executionResources: { version: 'execution_resources.v2', operation: 'text_to_image', api: 'image_generation', relation: 'new', images: [], files: [], messages: [] } } },
        { route: { executionResources: { version: 'execution_resources.v2', operation: 'text_to_image', api: 'image_generation', relation: 'new', images: [], files: [], messages: [] } } },
      ],
    },
  };

  assert.throws(
    () => submitHelpers.projectRouteExecutionMedia(parent, {}),
    error => error?.code === 'EXECUTION_RESOURCE_PROJECTION_MISSING',
    'a batch envelope must remain invalid as a single execution projection',
  );
  assert.strictEqual(
    submitHelpers.projectRouteExecutionMediaForDispatch(parent, {}),
    null,
    'dispatch preflight must skip the non-executable batch parent and leave projection to its child routes',
  );
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
  const batchWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-batch-workflow.js'), 'utf8');
  assert.match(batchWorkflow, /startImageBatchJob\(\{/);
  assert.ok(batchWorkflow.includes('tasks: prepared.map(child => ('), 'every prepared child must be submitted in the single server batch request');
  assert.ok(batchWorkflow.includes('submitHelpers.saveImageBatchIndex?.(root.localStorage, sessionId, batchIndexRecord)'),
    'the durable batch index must still be persisted so refresh can rebuild the shared parent card');
  assert.ok(batchWorkflow.includes('storageCore.safeSetJsonStorage?.(root.localStorage, key, child.durableJob)'),
    'each child must keep a durable snapshot while the server parent job owns live progress');
  assert.ok(batchWorkflow.includes('onDurableHandoff?.(batchJobId'), 'the single server handoff must clear pending ownership');
  assert.ok(batchWorkflow.includes('mergeImageResultContexts(mergedContext, context)'),
    'server task results must merge in plan order instead of provider completion order');
  assert.ok(batchWorkflow.includes('clearImageBatchIndex?.(root.localStorage, sessionId)'),
    'terminal success must still clear the durable recovery records');
  assert.ok(imageWorkflow.includes('taskPreparation.prepareImageExecutionRequest('),
    'the single-image executor must reuse the shared image task preparation helper');
  assert.ok(!imageWorkflow.includes('batchChildKey') && !imageWorkflow.includes('batchAggregate'),
    'the single-image executor must no longer carry the browser-side batch fan-out branch');
}

function testSubmitWorkflowDelegatesBatchToServerEndpoint() {
  const submitWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const regenerateWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/regenerate-workflow.js'), 'utf8');
  const batchWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-batch-workflow.js'), 'utf8');
  const jobService = fs.readFileSync(path.join(__dirname, '../../client/services/job-service.js'), 'utf8');
  const composition = fs.readFileSync(path.join(__dirname, '../../client/services/composition.js'), 'utf8');

  assert.ok(submitWorkflow.includes('await sendImageBatch(sessionId,{items:compiledBatch.items.map'),
    'submit must delegate the whole compiled batch to the new server endpoint');
  assert.ok(!submitWorkflow.includes('Promise.allSettled(batchChildren)'),
    'submit must not fan out individual image jobs from the browser anymore');
  assert.ok(submitWorkflow.includes('batchParent,responseIndex,userMessageId:userMessageIdentity?.id||"",turnId:userMessageIdentity?.turnId||"",clarificationReplay'),
    'the shared parent card and clarification replay must pass into the server batch workflow');
  assert.ok(regenerateWorkflow.includes('submitWorkflow.onSubmit({preventDefault(){}},{promptOverride:s})'),
    'regenerate must reach the single server batch endpoint through the unified submit pipeline');
  assert.ok(!regenerateWorkflow.includes('sendImageBatch('),
    'regenerate must not call the batch endpoint independently anymore');
  assert.ok(jobService.includes("url: '/api/image-batches'"), 'the client job service must expose the single batch endpoint');
  assert.ok(jobService.includes('async function getImageBatchJob'), 'the client must poll the parent batch job');
  assert.ok(jobService.includes('async function disposeImageBatchJob'), 'the client must dispose the completed server parent batch');
  assert.ok(composition.includes('startImageBatchJob: options => jobService.startImageBatchJob'), 'the service composition must expose the batch start endpoint');
  assert.ok(composition.includes('getImageBatchJob: options => jobService.getImageBatchJob'), 'the service composition must expose batch status polling');
}

module.exports = [
  testCompiledBatchParentSkipsSingleExecutionProjection,
  testExecutableImageBatchAcceptsGenerationAndMediaChildren,
  testSerialCommitQueueSerializesConcurrentResultCommits,
  testImageWorkflowCarriesBatchCoordinationFlags,
  testSubmitWorkflowDelegatesBatchToServerEndpoint,
];
