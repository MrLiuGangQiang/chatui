'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const imagePlanProtocol = require('../../shared/image-plan');
const compilerModule = require('../../client/services/route-image-plan-compiler');
const routeService = require('../../client/services/route-service');

function task(prompt, { taskType = 'generate', inputImages = [], quality, background, outputFormat } = {}) {
  const value = {
    task_type: taskType,
    prompt,
    input_images: inputImages,
  };
  if (quality !== undefined) value.quality = quality;
  if (background !== undefined) value.background = background;
  if (outputFormat !== undefined) value.output_format = outputFormat;
  return value;
}

function plan(tasks) {
  return { schema_version: imagePlanProtocol.IMAGE_PLAN_VERSION, tasks };
}

function createHarness({
  catalog = [],
  maxTasks = imagePlanProtocol.IMAGE_PLAN_MAX_TASKS,
  isMetaInstructionGoal = () => false,
  hasUnresolvedImageInstructionReference = () => false,
  compileLocalRoute = null,
} = {}) {
  const calls = [];
  const compile = compileLocalRoute || ((draft, options) => {
    calls.push({ draft, options });
    const dispatchContract = Object.freeze({
      version: 'dispatch_contract.v1',
      operation: draft.operation,
      arguments: draft.arguments,
      bindings: draft.bindings,
    });
    const executionResources = Object.freeze({
      version: 'execution_resources.v2',
      operation: draft.operation,
      bindings: draft.bindings,
    });
    return Object.freeze({
      api: `test:${draft.operation}`,
      mode: 'image',
      needClarification: false,
      dispatchContract,
      executionResources,
    });
  });
  const compiler = compilerModule.createRouteImagePlanCompiler({
    imagePlanVersion: imagePlanProtocol.IMAGE_PLAN_VERSION,
    imagePlanMaxTasks: maxTasks,
    assertImagePlan: imagePlanProtocol.assertImagePlan,
    imageOperations: new Set(['text_to_image', 'image_reference_gen', 'edit_image']),
    validRelations: new Set(['new', 'followup', 'continuation']),
    resourceTypeForCandidateKey: key => ({ i: 'image', f: 'file', m: 'message' }[String(key || '')[0]] || ''),
    bindingForCandidate: (candidate, role, key) => ({
      key,
      type: candidate.type,
      role,
      resource_id: candidate.resource_id,
      source: candidate.source,
    }),
    routeCompilationCandidateCatalog: () => catalog,
    isMetaInstructionGoal,
    hasUnresolvedImageInstructionReference,
    compileLocalRoute: compile,
  });
  return { compiler, calls };
}

function testImagePlanCompilerMapsGenerateWithoutImagesToTextToImage() {
  const { compiler, calls } = createHarness();
  const result = compiler.compileImagePlan(plan([task('A red fox in snow')]), { relation: 'new' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, 'single');
  assert.strictEqual(result.item.operation, 'text_to_image');
  assert.strictEqual(calls[0].draft.operation, 'text_to_image');
  assert.deepStrictEqual(calls[0].draft.bindings, []);
}

function testImagePlanCompilerMapsGenerateWithReferencesToReferenceGeneration() {
  const catalog = [{
    candidate_key: 'i1', type: 'image', source: 'current', resource_id: 'res:image:reference-1',
  }];
  const { compiler, calls } = createHarness({ catalog });
  const result = compiler.compileImagePlan(plan([task('Use the composition of the reference', {
    inputImages: [{ candidate_key: 'i1', role: 'reference' }],
  })]));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.item.operation, 'image_reference_gen');
  assert.strictEqual(calls[0].draft.operation, 'image_reference_gen');
  assert.deepStrictEqual(calls[0].draft.bindings, [{
    key: 'r1', type: 'image', role: 'reference', resource_id: 'res:image:reference-1', source: 'current',
  }]);
}

function testImagePlanCompilerMapsEditTasksToImageEditing() {
  const catalog = [{
    candidate_key: 'i1', type: 'image', source: 'history', resource_id: 'res:image:target-1',
  }];
  const { compiler, calls } = createHarness({ catalog });
  const result = compiler.compileImagePlan(plan([task('Replace the sky with a sunset', {
    taskType: 'edit',
    inputImages: [{ candidate_key: 'i1', role: 'target' }],
  })]), { relation: 'followup' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.item.operation, 'edit_image');
  assert.strictEqual(calls[0].draft.operation, 'edit_image');
  assert.strictEqual(calls[0].draft.relation, 'followup');
}

function testImagePlanCompilerResolvesImageAndFileOrdinalFallbacksAgainstTypedCatalogs() {
  const catalog = [
    { candidate_key: 'durable-image-a', type: 'image', source: 'history', resource_id: 'res:image:a' },
    { candidate_key: 'durable-file-a', type: 'file', source: 'history', resource_id: 'res:file:a' },
    { candidate_key: 'durable-image-b', type: 'image', source: 'history', resource_id: 'res:image:b' },
    { candidate_key: 'durable-file-b', type: 'file', source: 'history', resource_id: 'res:file:b' },
  ];
  const { compiler } = createHarness({ catalog });
  const bindings = compiler.imagePlanTaskBindings({
    input_images: [
      { candidate_key: 'i2', role: 'reference' },
      { candidate_key: 'f2', role: 'reference' },
    ],
  }, catalog);
  assert.deepStrictEqual(bindings.map(binding => [binding.type, binding.resource_id]), [
    ['image', 'res:image:b'],
    ['file', 'res:file:b'],
  ]);
}

function testImagePlanCompilerRejectsProductLimitBeforeProtocolCompilation() {
  const { compiler, calls } = createHarness({ maxTasks: 5 });
  const result = compiler.compileImagePlan(plan(Array.from({ length: 6 }, (_, index) => task(`Frame ${index + 1}`))));
  assert.deepStrictEqual({
    ok: result.ok,
    code: result.code,
    taskCount: result.taskCount,
    maxTasks: result.maxTasks,
  }, {
    ok: false,
    code: 'IMAGE_PLAN_OVER_LIMIT',
    taskCount: 6,
    maxTasks: 5,
  });
  assert.match(result.question, /5/);
  assert.strictEqual(calls.length, 0);
}

function testImagePlanCompilerFailsClosedForMetaOrUnresolvedChildPrompts() {
  for (const detector of ['meta', 'unresolved']) {
    const options = detector === 'meta'
      ? { isMetaInstructionGoal: prompt => prompt === 'unsafe child prompt' }
      : { hasUnresolvedImageInstructionReference: prompt => prompt === 'unsafe child prompt' };
    const { compiler, calls } = createHarness(options);
    const result = compiler.compileImagePlan(plan([task('unsafe child prompt')]));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'IMAGE_PLAN_TASK_META_INSTRUCTION');
    assert.strictEqual(calls.length, 0, `${detector} child prompt must not reach local compilation`);
  }
}

function testImagePlanCompilerPreservesSingleAndBatchShapesAndStructuredOverrides() {
  const { compiler, calls } = createHarness();
  const single = compiler.compileImagePlan(plan([task('One frame', {
    quality: 'high', background: 'transparent', outputFormat: 'png',
  })]), { overrides: { size: '1024x1024' } });
  const batch = compiler.compileImagePlan(plan([task('First frame'), task('Second frame')]));
  assert.strictEqual(single.kind, 'single');
  assert.strictEqual(single.dispatchContract, single.item.dispatchContract);
  assert.strictEqual(batch.kind, 'batch');
  assert.strictEqual(batch.items.length, 2);
  assert.deepStrictEqual(calls[0].options.overrides, {
    size: '1024x1024', quality: 'high', background: 'transparent', output_format: 'png',
  });
  assert.strictEqual(calls[0].options.parameterInput, '');
  assert.strictEqual(calls[0].options.semanticAuthority, imagePlanProtocol.IMAGE_PLAN_VERSION);
  assert.strictEqual(Object.isFrozen(batch.items[0].route), true);
}

function testImagePlanCompilerGatesOnlyReadyMultiImageRoutes() {
  const { compiler } = createHarness();
  assert.strictEqual(compiler.shouldRequestImagePlan({ taskShape: 'multi', operationType: 'text_to_image' }), true);
  assert.strictEqual(compiler.shouldRequestImagePlan({ taskShape: 'multi', intent: 'edit_image' }), true);
  assert.strictEqual(compiler.shouldRequestImagePlan({ taskShape: 'single', operationType: 'text_to_image' }), false);
  assert.strictEqual(compiler.shouldRequestImagePlan({ taskShape: 'multi', operationType: 'plain_chat' }), false);
  assert.strictEqual(compiler.shouldRequestImagePlan({ taskShape: 'multi', operationType: 'edit_image', needClarification: true }), false);
}

function testRouteServiceComposesImagePlanCompilerWithoutReembeddingImplementation() {
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-service.js'), 'utf8');
  const compilerSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-image-plan-compiler.js'), 'utf8');
  assert.doesNotMatch(routeSource, /function imagePlanTaskOperation\s*\(/);
  assert.doesNotMatch(routeSource, /function imagePlanTaskBindings\s*\(/);
  assert.doesNotMatch(routeSource, /function shouldRequestImagePlan\s*\(/);
  assert.doesNotMatch(routeSource, /function compileImagePlan\s*\(/);
  assert.match(routeSource, /createRouteImagePlanCompiler/);
  assert.match(compilerSource, /function imagePlanTaskOperation\s*\(/);
  assert.match(compilerSource, /function compileImagePlan\s*\(/);
  assert.doesNotMatch(compilerSource, /root\.ChatUIRouteImagePlanCompiler\s*=/,
    'the image-plan compiler must register privately instead of adding a browser global');
  assert.strictEqual(typeof routeService.shouldRequestImagePlan, 'function');
  assert.strictEqual(typeof routeService.compileImagePlan, 'function');
}

module.exports = [
  testImagePlanCompilerMapsGenerateWithoutImagesToTextToImage,
  testImagePlanCompilerMapsGenerateWithReferencesToReferenceGeneration,
  testImagePlanCompilerMapsEditTasksToImageEditing,
  testImagePlanCompilerResolvesImageAndFileOrdinalFallbacksAgainstTypedCatalogs,
  testImagePlanCompilerRejectsProductLimitBeforeProtocolCompilation,
  testImagePlanCompilerFailsClosedForMetaOrUnresolvedChildPrompts,
  testImagePlanCompilerPreservesSingleAndBatchShapesAndStructuredOverrides,
  testImagePlanCompilerGatesOnlyReadyMultiImageRoutes,
  testRouteServiceComposesImagePlanCompilerWithoutReembeddingImplementation,
];
