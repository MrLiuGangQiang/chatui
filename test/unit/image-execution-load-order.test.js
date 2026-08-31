'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const imageWorkflow = require('../../client/app/image-workflow');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_REGISTRY_SYMBOL = Symbol.for('chatui.module-registry.v1');

function runBrowserScript(sandbox, relativePath) {
  const filename = path.join(ROOT, relativePath);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
}

function createBrowserSandbox() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  runBrowserScript(sandbox, 'client/runtime/module-registry.js');
  return sandbox;
}

function emptyImageExecutionMedia(operation = 'text_to_image') {
  return {
    version: 'execution_resources.v2',
    operation,
    images: [],
    files: [],
    imageInputs: [],
    masks: [],
    targets: [],
    references: [],
  };
}

function testDispatchContractValidatorIsResolvedWhenRegisteredAfterImageExecutionLoads() {
  const sandbox = createBrowserSandbox();
  runBrowserScript(sandbox, 'client/core/image-execution.js');

  const modules = sandbox[MODULE_REGISTRY_SYMBOL];
  const policy = modules.get('imageExecution').createImageExecutionPolicy();
  runBrowserScript(sandbox, 'shared/capability-registry.js');
  runBrowserScript(sandbox, 'shared/dispatch-contract.js');

  const plan = makeDispatchContract({
    operation: 'text_to_image',
    prompt: 'draw a red fox',
  });
  const authorized = policy.requireCanonicalImageExecution(
    plan,
    emptyImageExecutionMedia('text_to_image'),
  );
  assert.strictEqual(authorized.api, 'image_generation');
  assert.strictEqual(authorized.operation, 'text_to_image');
}

function testImageExecutionFailsClosedBeforePlanValidatorAvailability() {
  const sandbox = createBrowserSandbox();
  runBrowserScript(sandbox, 'client/core/image-execution.js');

  const policy = sandbox[MODULE_REGISTRY_SYMBOL]
    .get('imageExecution')
    .createImageExecutionPolicy();
  const apparentPlan = {
    schema_version: 'dispatch_contract.v1',
    operation: 'text_to_image',
    api: 'image_generation',
  };

  assert.throws(
    () => policy.requireCanonicalImageExecution(apparentPlan, emptyImageExecutionMedia('text_to_image')),
    /validated dispatch_contract\.v1/,
  );
}

async function testImageWorkflowUsesCanonicalDispatchContract() {
  const stopAfterAuthorization = new Error('stop after canonical authorization');
  const workflow = imageWorkflow.createImageWorkflow({
    state: { activeSessionId: 'session-plan', sessions: [] },
    getConfig: () => ({ baseUrl: 'https://api.example.com/v1', imageModel: 'gpt-image-1' }),
    ensureActiveRun: () => { throw stopAfterAuthorization; },
  });
  const dispatchContract = makeDispatchContract({
    operation: 'text_to_image',
    prompt: 'draw a red fox',
  });

  await assert.rejects(
    workflow.sendImage('draw a red fox', {
      dispatchContract,
      executionMedia: emptyImageExecutionMedia('text_to_image'),
    }),
    error => error === stopAfterAuthorization,
  );
}

function testImageDispatchCallersForwardOnlyCanonicalDispatchContract() {
  const submitSource = fs.readFileSync(path.join(ROOT, 'client/app/submit-workflow.js'), 'utf8');
  const regenerateSource = fs.readFileSync(path.join(ROOT, 'client/app/regenerate-workflow.js'), 'utf8');
  const imageWorkflowSource = fs.readFileSync(path.join(ROOT, 'client/app/image-workflow.js'), 'utf8');

  assert.ok(
    submitSource.includes('executionMedia,dispatchContract:routeInfo.dispatchContract,clarificationReplay'),
    'ordinary image submit must forward the canonical execution plan without UI-only execution-preview fields',
  );
  assert.ok(
    regenerateSource.includes('executionMedia,dispatchContract:routeInfo.dispatchContract,routePrompt'),
    'explicit image regeneration must forward its canonical execution plan',
  );
  assert.ok(
    regenerateSource.includes('executionMedia,dispatchContract:p.dispatchContract,clarificationReplay'),
    'routed regeneration must forward its canonical execution plan',
  );
  assert.ok(
    imageWorkflowSource.includes('executionBindingEvidence = dispatchContract.bindingEvidenceFromMedia(t.executionMedia || {})'),
    'image dispatch must derive binding evidence from the canonical execution projection',
  );
  assert.strictEqual(
    (imageWorkflowSource.match(/bindingEvidence:\s*\[\]/g) || []).length,
    0,
    'image jobs must not replace canonical binding evidence with an empty array',
  );
}

module.exports = [
  testDispatchContractValidatorIsResolvedWhenRegisteredAfterImageExecutionLoads,
  testImageExecutionFailsClosedBeforePlanValidatorAvailability,
  testImageWorkflowUsesCanonicalDispatchContract,
  testImageDispatchCallersForwardOnlyCanonicalDispatchContract,
];
