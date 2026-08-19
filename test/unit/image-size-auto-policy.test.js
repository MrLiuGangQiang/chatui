'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const capabilityRegistry = require('../../shared/capability-registry');
const dispatchContract = require('../../shared/dispatch-contract');
const imagePlan = require('../../shared/image-plan');
const routeService = require('../../client/services/route-service');
const imageGenerationService = require('../../client/services/image-generation-service');
const imageExecution = require('../../client/core/image-execution');
const imageTaskPreparation = require('../../client/app/image-task-preparation');
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
  const input = '重新设计住宅平面图：参考 1536×1024 横向示意和 1024x1024 方形标注，房屋后面不设置卧室。';
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

function testImageRequestPayloadOmitsSizeAndQualityDefaults() {
  const payload = imageGenerationService.buildImageRequestPayload({
    model: 'gpt-image-2',
    prompt: '一只橘色猫',
  });
  assert.deepStrictEqual(payload, { model: 'gpt-image-2', prompt: '一只橘色猫' });

  const autoPayload = imageGenerationService.buildImageRequestPayload({
    model: 'gpt-image-2',
    prompt: '一只橘色猫',
    size: 'auto',
    quality: 'auto',
    background: 'auto',
    output_format: 'auto',
  });
  assert.deepStrictEqual(autoPayload, { model: 'gpt-image-2', prompt: '一只橘色猫' });

  const plannedAuto = imageGenerationService.buildGptImage2TaskPayload({
    model: 'gpt-image-2',
    task: { prompt: '一座横向的房子', size: 'auto', quality: 'auto' },
  });
  assert.deepStrictEqual(plannedAuto, { model: 'gpt-image-2', prompt: '一座横向的房子' });
}

function testImageRequestPayloadForwardsSelectedSizeAndExplicitQuality() {
  const payload = imageGenerationService.buildImageRequestPayload({
    model: 'gpt-image-2',
    prompt: '一只橘色猫',
    size: '1536x1024',
    quality: 'high',
  });
  assert.deepStrictEqual(payload, {
    model: 'gpt-image-2',
    prompt: '一只橘色猫',
    size: '1536x1024',
    quality: 'high',
  });

  const plannedPayload = imageGenerationService.buildGptImage2TaskPayload({
    model: 'gpt-image-2',
    task: { prompt: '一座横向的房子', size: '1024x1536' },
  });
  assert.strictEqual(plannedPayload.size, '1024x1536');
}

async function prepareGeneration(config) {
  const contract = dispatchContract.compileDispatchContract({
    operation: 'text_to_image',
    relation: 'new',
    input: '生成一只橘色猫',
    prompt: '生成一只橘色猫',
    bindings: [],
    constraints: [],
  });
  const executionMedia = {
    version: 'execution_resources.v2',
    operation: 'text_to_image',
    api: 'image_generation',
    images: [],
    files: [],
    imageInputs: [],
    masks: [],
    targets: [],
    references: [],
  };
  const policy = imageExecution.createImageExecutionPolicy({ dispatchContract });
  const workflow = imageTaskPreparation.createImageTaskPreparation({
    imageExecutionPolicy: policy,
    buildImageRoleGuide: imageExecution.buildImageRoleGuide,
    buildImageRoleMap: imageExecution.buildImageRoleMap,
    persistImageAttachmentRefs: async list => list,
    imageFilesToJobPayload: async list => list,
    restoreImageAttachmentsFromContext: async () => [],
    normalizeImageContextForStorage: value => value,
    makeImageItemId: (reference, index) => `img_${reference}_${index}`,
    getEffectiveImageStylePrompt: () => '',
    buildImagePromptWithStylePrompt: prompt => prompt,
    makeClientImageJobId: () => 'imgjob-size-policy',
  });
  return workflow.prepareImageExecutionRequest({
    contract,
    executionMedia,
    sessionId: 'session-size-policy',
    config: { imageModel: 'gpt-image-1', imageSize: config.imageSize },
    promptFallback: '生成一只橘色猫',
  });
}

async function testExecutionOmitsSizeByDefaultAndForwardsSelectedSize() {
  const auto = await prepareGeneration({ imageSize: 'auto' });
  assert.strictEqual(Object.hasOwn(auto.payload, 'size'), false, 'unselected size must not be sent to the generation/edit API');
  assert.strictEqual(Object.hasOwn(auto.payload, 'quality'), false, 'unselected quality must not be sent to the generation/edit API');
  assert.strictEqual(auto.dispatchContract.arguments.size, 'auto');

  const selected = await prepareGeneration({ imageSize: '1024x1536' });
  assert.strictEqual(selected.payload.size, '1024x1536', 'a size selected in the settings page must reach the generation/edit payload');
  assert.strictEqual(selected.dispatchContract.arguments.size, '1024x1536');
  assert.strictEqual(Object.hasOwn(selected.payload, 'quality'), false);
}

function testImageSizeSettingIsRestoredInUiConfigAndExecution() {
  const storage = createStorage({
    config: JSON.stringify({ imageSize: '1536x1024', imageModel: 'image-model' }),
  });
  const elements = new Map([
    ['baseUrl', { value: 'https://gateway.example/v1', readOnly: false }],
    ['apiKey', { value: '' }],
    ['chatModel', { value: '' }],
    ['routeModel', { value: '' }],
    ['imageModel', { value: '' }],
    ['imageSize', { value: '' }],
    ['systemPrompt', { value: '' }],
    ['imageStylePrompt', { value: '' }],
  ]);
  const workflow = configModule.createConfigWorkflow({
    state: { models: [], modelMeta: {}, sessions: [], activeSessionId: '' },
    getElement: id => elements.get(id),
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
  assert.strictEqual(elements.get('imageSize').value, '1536x1024', 'loadConfig must restore the saved image size into the settings select');
  assert.strictEqual(workflow.getConfig().imageSize, '1536x1024', 'getConfig must expose the restored image size setting');
  workflow.saveConfig(true);
  assert.strictEqual(JSON.parse(storage.getItem('config')).imageSize, '1536x1024', 'saveConfig must persist the selected image size');
  assert.strictEqual(configModule.defaults.imageSize, 'auto', 'the default image size must stay provider auto');

  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  const bootstrapSource = fs.readFileSync(path.resolve(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const selectSource = fs.readFileSync(path.resolve(__dirname, '../../client/app/custom-select-workflow.js'), 'utf8');
  assert.match(indexHtml, /id="imageSize"/);
  assert.match(indexHtml, /<option value="1024x1024">1024 × 1024<\/option>/);
  assert.match(indexHtml, /<option value="1024x1536">1024 × 1536<\/option>/);
  assert.match(indexHtml, /<option value="1536x1024">1536 × 1024<\/option>/);
  assert.match(bootstrapSource, /"imageSize"/);
  assert.match(selectSource, /'imageSize'/);
}

module.exports = [
  testDimensionsNeverBecomeExecutionArgumentsOrClarificationChoices,
  testImagePlannerHasNoSizeFieldOrSizeInstruction,
  testImageRequestPayloadOmitsSizeAndQualityDefaults,
  testImageRequestPayloadForwardsSelectedSizeAndExplicitQuality,
  testExecutionOmitsSizeByDefaultAndForwardsSelectedSize,
  testImageSizeSettingIsRestoredInUiConfigAndExecution,
];
