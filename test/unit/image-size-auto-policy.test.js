"use strict";

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const capabilityRegistry = require('../../shared/capability-registry');
const dispatchContract = require('../../shared/dispatch-contract');
const imagePlan = require('../../shared/image-plan');
const routeService = require('../../client/services/route-service');
const imageGenerationService = require('../../client/services/image-generation-service');
const configModule = require('../../client/app/config-workflow');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function testDimensionsNeverBecomeExecutionArgumentsOrClarificationChoices() {
  const input = '重新设计住宅平面图：参考 1536×1024 横向示意和 1024x1024 方形标注，堂屋后面不设置卧室。';
  const result = capabilityRegistry.resolveExecutionArguments({
    operation: 'text_to_image',
    input,
    defaults: { imageSize: '1024x1536' },
    overrides: { size: '1536x1024' },
  });

  assert.deepStrictEqual(result.arguments, {
    prompt: input,
    size: 'auto',
    quality: 'auto',
    background: 'auto',
    output_format: 'auto',
    count: 1,
  });
  assert.strictEqual(result.candidates.some(candidate => candidate.name === 'size'), false);
  assert.strictEqual(result.conflicts.some(conflict => conflict.name === 'size'), false);
  assert.deepStrictEqual(result.evidence.size, []);

  const contract = dispatchContract.compileDispatchContract({
    operation: 'text_to_image',
    relation: 'new',
    input,
    defaults: { size: '1024x1024' },
    overrides: { size: '1024x1536' },
    bindings: [],
  });
  assert.strictEqual(contract.arguments.size, 'auto');
  assert.strictEqual(dispatchContract.hasExactDispatchContract(contract), true);
}

function testImagePlannerHasNoSizeFieldOrSizeInstruction() {
  const task = {
    task_type: 'generate',
    prompt: '生成一张住宅平面图',
    input_images: [],
    quality: 'auto',
    background: 'auto',
    output_format: 'auto',
    count: 1,
  };
  const plan = { schema_version: 'image_plan.v1', tasks: [task] };
  const properties = imagePlan.IMAGE_PLAN_RESPONSE_FORMAT.json_schema.schema.properties.tasks.items.properties;

  assert.strictEqual(imagePlan.hasExactImagePlan(plan), true);
  assert.strictEqual(imagePlan.hasExactImagePlan({
    schema_version: 'image_plan.v1',
    tasks: [{ ...task, size: 'auto' }],
  }), false, 'the planner must not be able to override image size');
  assert.strictEqual(Object.hasOwn(properties, 'size'), false);
  assert.strictEqual(imagePlan.TASK_FIELDS.includes('size'), false);
  assert.strictEqual(routeService.IMAGE_PLAN_SYSTEM_PROMPT.includes('size/quality'), false);
}

function testImageRequestPayloadForcesProviderAutoSize() {
  const payload = imageGenerationService.buildImageRequestPayload({
    model: 'gpt-image-2',
    prompt: '一只橘色猫',
    size: '1536x1024',
    quality: 'high',
  });
  assert.deepStrictEqual(payload, {
    model: 'gpt-image-2',
    prompt: '一只橘色猫',
    size: 'auto',
    quality: 'high',
  });

  const plannedPayload = imageGenerationService.buildGptImage2TaskPayload({
    model: 'gpt-image-2',
    task: { prompt: '一座横向的房子', size: '1024x1536' },
  });
  assert.strictEqual(plannedPayload.size, 'auto');
}

function testImageSizeSettingIsRemovedAndOldConfigIsMigratedAway() {
  const storage = createStorage({
    config: JSON.stringify({ imageSize: '1536x1024', imageModel: 'image-model' }),
  });
  const elements = new Map([
    ['baseUrl', { value: 'https://gateway.example/v1', readOnly: false }],
    ['apiKey', { value: '' }],
    ['chatModel', { value: '' }],
    ['routeModel', { value: '' }],
    ['imageModel', { value: '' }],
    ['systemPrompt', { value: '' }],
    ['imageStylePrompt', { value: '' }],
  ]);
  const workflow = configModule.createConfigWorkflow({
    state: { models: [], modelMeta: {}, sessions: [], activeSessionId: '' },
    getElement: id => {
      assert.notStrictEqual(id, 'imageSize', 'removed UI settings must not be queried');
      return elements.get(id);
    },
    localStorage: storage,
    sessionStorage: storage,
    document: { body: { classList: { add() {}, remove() {} } } },
    window: { sessionStorage: storage, setTimeout },
    CONFIG_KEY: 'config',
    renderModelOptions() {},
    updateCustomSelect() {},
    enhanceConfigSelects() {},
    closeAllCustomSelects() {},
    saveSessionsMeta() {},
    toast() {},
  });

  workflow.loadConfig();
  assert.strictEqual(Object.hasOwn(workflow.getConfig(), 'imageSize'), false);
  assert.strictEqual(Object.hasOwn(JSON.parse(storage.getItem('config')), 'imageSize'), false);
  assert.strictEqual(Object.hasOwn(configModule.defaults, 'imageSize'), false);

  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  const bootstrapSource = fs.readFileSync(path.resolve(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const selectSource = fs.readFileSync(path.resolve(__dirname, '../../client/app/custom-select-workflow.js'), 'utf8');
  const routeWorkflowSource = fs.readFileSync(path.resolve(__dirname, '../../client/app/route-intent-workflow.js'), 'utf8');
  assert.doesNotMatch(indexHtml, /id="imageSize"/);
  assert.doesNotMatch(bootstrapSource, /"imageSize"/);
  assert.doesNotMatch(selectSource, /"imageSize"/);
  assert.doesNotMatch(routeWorkflowSource, /imageSize/);
}

module.exports = [
  testDimensionsNeverBecomeExecutionArgumentsOrClarificationChoices,
  testImagePlannerHasNoSizeFieldOrSizeInstruction,
  testImageRequestPayloadForcesProviderAutoSize,
  testImageSizeSettingIsRemovedAndOldConfigIsMigratedAway,
];
