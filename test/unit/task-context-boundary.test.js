const assert = require('assert');

const routeContext = require('../../client/core/image-route-context');
const intentContract = require('../../client/core/intent-contract');
const routeService = require('../../client/services/route-service');
const promptComposer = require('../../client/services/prompt-composer-service');

const CAT = '\u753b\u4e00\u53ea\u732b';
const FISH = '\u753b\u4e00\u6761\u9c7c';

function resource(overrides = {}, index = 0) {
  return { key: `r${index + 1}`, type: 'image', source: 'current', role: 'reference', index: index + 1, id: '', reference_id: '', missing: false, ...overrides };
}

function imageContract({ relation = 'new', operation = 'text_to_image', resources = [], directive = null, confidence = 0.95 } = {}) {
  const patch = relation !== 'new' || operation === 'image_reference_gen';
  return {
    schema_version: 'task_contract.v3',
    operation,
    relation,
    resources: resources.map(resource),
    directive: directive || {
      mode: patch ? 'patch' : 'standalone',
      base_resource_keys: patch ? resources.map((_, index) => `r${index + 1}`) : [],
      unmentioned_policy: patch ? 'preserve' : 'allow_change',
      operations: patch ? [{ op: 'add', target: 'current request', value: 'apply the current request' }] : [],
      constraints: [],
    },
    clarification: { question: '', missing_resource_keys: [] },
    confidence,
    review_reasons: [],
    rationale: relation === 'new' ? 'fresh image task' : 'related image task',
  };
}

function historyContext() {
  return { last_generated_image: { reference_id: 'imgref_latest', prompt: CAT, count: 1 }, image_candidates: [{ index: 1, source_index: 1, source: 'history', reference_id: 'imgref_latest', image_id: 'img_1', prompt: CAT }] };
}

function testNewImageTaskUsesOnlyCurrentUserInput() {
  const task = imageContract();
  assert.strictEqual(task.relation, 'new');
  assert.strictEqual(task.directive.mode, 'standalone');
  assert.strictEqual(promptComposer.composeImageGeneratePrompt(task, historyContext(), FISH), FISH);
}

function testNewTaskRouteDoesNotFallbackToLastGeneratedPrompt() {
  const parsed = routeService.parseRouteResult(JSON.stringify(imageContract()), { input: FISH, attachments: [], context: historyContext() });
  assert.strictEqual(parsed.taskContract.relation, 'new');
  assert.strictEqual(parsed.contextualImagePrompt, FISH);
  assert.ok(!parsed.contextualImagePrompt.includes(CAT));
}

function testNewTaskContractRejectsHistoricalPatchContamination() {
  const contaminated = imageContract({
    resources: [{ source: 'history', role: 'reference', reference_id: 'imgref_latest' }],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [{ op: 'preserve', target: 'cat', value: '' }], constraints: [] },
  });
  assert.strictEqual(intentContract.hasExactContractShape(contaminated), false);
  assert.strictEqual(routeService.parseRouteResult(JSON.stringify(contaminated), { input: FISH, context: historyContext() }), null);
}

function testQuotedImageGenerationUsesExplicitBaseResource() {
  const quotedDescription = '\u4e00\u5e45\u8be6\u7ec6\u7684\u590f\u65e5\u6d77\u8fb9\u63d2\u753b\uff0c\u91d1\u8272\u5915\u9633\uff0c\u900f\u660e\u6d6a\u82b1\uff0c\u8fdc\u5904\u706f\u5854';
  const shortRequest = '\u57fa\u4e8e\u5f15\u7528\u6d88\u606f\u751f\u6210\u6c34\u5f69\u56fe\u7247';
  const context = { image_candidates: [{ index: 1, source: 'quoted', reference_id: 'imgref_quote', image_id: 'img_quote_1', prompt: quotedDescription }] };
  const raw = imageContract({
    relation: 'followup',
    operation: 'image_reference_gen',
    resources: [{ source: 'quoted', role: 'reference', id: 'img_quote_1', reference_id: 'imgref_quote' }],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [{ op: 'replace', target: 'style', value: 'watercolor' }], constraints: [] },
  });
  const composed = promptComposer.composeImageGeneratePrompt(raw, context, shortRequest);
  assert.ok(composed.includes(quotedDescription));
  assert.ok(composed.includes(shortRequest));
  assert.ok(composed.includes('watercolor'));
}

function testCorrectionTaskUsesHistoricalBaseAndStructuredChanges() {
  const input = '\u8fd9\u5f20\u56fe\u4e0d\u5bf9\uff0c\u91cd\u65b0\u751f\u6210';
  const raw = imageContract({
    relation: 'correction',
    resources: [{ source: 'history', role: 'reference', id: 'img_1', reference_id: 'imgref_latest' }],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [{ op: 'replace', target: 'incorrect result', value: 'regenerate correctly' }], constraints: [] },
  });
  const parsed = routeService.parseRouteResult(JSON.stringify(raw), { input, attachments: [], context: historyContext() });
  assert.strictEqual(parsed.taskContract.relation, 'correction');
  assert.ok(parsed.contextualImagePrompt.includes(CAT));
  assert.ok(parsed.contextualImagePrompt.includes(input));
}

function testRelationSurvivesCanonicalExecutionPlan() {
  const task = imageContract({ relation: 'followup', resources: [{ source: 'history', role: 'reference', id: 'img_1', reference_id: 'imgref_latest' }] });
  const executionPlan = intentContract.taskContractToExecutionPlan(task);
  assert.strictEqual(executionPlan.relation, 'followup');
  assert.ok(!('taskType' in executionPlan));
  assert.ok(!('operation' in executionPlan));
  assert.ok(!('routeToTaskContract' in intentContract));
  assert.ok(!('taskContractToRouteInput' in intentContract));
}

function testRoutePromptsDeclarePatchAndContextBoundary() {
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('task_contract.v3'));
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('relation=new'));
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('unmentioned_policy'));
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('历史覆盖一个完整的新请求'));
  assert.ok(routeService.INTENT_REVIEW_SYSTEM_PROMPT.includes('完整 task_contract.v3'));
}

module.exports = [
  testNewImageTaskUsesOnlyCurrentUserInput,
  testNewTaskRouteDoesNotFallbackToLastGeneratedPrompt,
  testNewTaskContractRejectsHistoricalPatchContamination,
  testQuotedImageGenerationUsesExplicitBaseResource,
  testCorrectionTaskUsesHistoricalBaseAndStructuredChanges,
  testRelationSurvivesCanonicalExecutionPlan,
  testRoutePromptsDeclarePatchAndContextBoundary,
];
