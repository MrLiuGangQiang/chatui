const assert = require('assert');

const routeContext = require('../../client/core/image-route-context');
const intentContract = require('../../client/core/intent-contract');
const routeService = require('../../client/services/route-service');
const promptComposer = require('../../client/services/prompt-composer-service');

const CAT = '\u753b\u4e00\u53ea\u732b';
const FISH = '\u753b\u4e00\u6761\u9c7c';

function imageContract({ taskType = 'new_task', currentIntent = FISH, contextToPreserve = '', finalInstruction = currentIntent, resources = [], confidence = 0.95 } = {}) {
  return {
    schema_version: 'task_contract.v2',
    intent: 'image.generate',
    task_type: taskType,
    execution: { api: 'image_generation', operation: 'text_to_image' },
    resources: resources.map((resource, index) => ({ id: '', reference_id: '', name: '', required: true, missing: false, index: index + 1, ...resource })),
    steps: [],
    prompt_plan: { current_user_intent: currentIntent, context_to_preserve: contextToPreserve, constraints: [], do_not_add: [], final_instruction: finalInstruction },
    clarification: { needed: false, question: '', missing_resources: [] },
    confidence,
    needs_review: false,
    reason: taskType === 'new_task' ? 'fresh image task' : 'related image task',
  };
}

function historyContext() {
  return { last_generated_image: { prompt: CAT, count: 1 } };
}

function testNewImageTaskUsesOnlyCurrentUserInput() {
  const task = intentContract.normalizeTaskContract(imageContract({ contextToPreserve: CAT, finalInstruction: `${CAT}\n${FISH}` }), { input: FISH });
  assert.strictEqual(task.prompt_plan.context_to_preserve, '');
  assert.strictEqual(promptComposer.composeImageGeneratePrompt(task, historyContext(), FISH), FISH);
}

function testNewTaskRouteDoesNotFallbackToLastGeneratedPrompt() {
  const parsed = routeService.parseRouteResult(JSON.stringify(imageContract()), routeContext.normalizeRoute, { input: FISH, attachments: [], context: historyContext() });
  assert.strictEqual(parsed.taskContract.task_type, 'new_task');
  assert.strictEqual(parsed.contextualImagePrompt, FISH);
  assert.ok(!parsed.contextualImagePrompt.includes(CAT));
}

function testNewTaskContractIgnoresContaminatedPromptPlanAndHistoryResources() {
  const parsed = routeService.parseRouteResult(JSON.stringify(imageContract({
    contextToPreserve: CAT,
    finalInstruction: `${CAT}\n${FISH}`,
    resources: [{ type: 'image', source: 'history', role: 'reference', index: 1, reference_id: 'imgref_cat' }],
    confidence: 0.96,
  })), routeContext.normalizeRoute, { input: FISH, attachments: [], context: historyContext() });

  assert.strictEqual(parsed.taskContract.task_type, 'new_task');
  assert.strictEqual(parsed.taskContract.prompt_plan.context_to_preserve, '');
  assert.deepStrictEqual(parsed.taskContract.resources, []);
  assert.strictEqual(parsed.contextualImagePrompt, FISH);
}

function testCorrectionTaskMayExplicitlyReusePreviousImageGoal() {
  const input = '\u8fd9\u5f20\u56fe\u4e0d\u5bf9\uff0c\u91cd\u65b0\u751f\u6210';
  const parsed = routeService.parseRouteResult(JSON.stringify(imageContract({ taskType: 'correction', currentIntent: input, contextToPreserve: CAT, finalInstruction: input, confidence: 0.93 })), routeContext.normalizeRoute, { input, attachments: [], context: historyContext() });

  assert.strictEqual(parsed.taskContract.task_type, 'correction');
  assert.ok(parsed.contextualImagePrompt.includes(CAT));
  assert.ok(parsed.contextualImagePrompt.includes(input));
}

function testTaskTypeSurvivesContractExecutionProjection() {
  const task = intentContract.normalizeTaskContract(imageContract({ taskType: 'followup', currentIntent: '\u518d\u753b\u4e00\u5f20' }));
  const executionRoute = intentContract.taskContractToExecutionRoute(task);
  const normalizedRoute = routeContext.normalizeRoute(executionRoute);

  assert.strictEqual(executionRoute.task_type, 'followup');
  assert.strictEqual(normalizedRoute.taskType, 'followup');
  assert.ok(!('routeToTaskContract' in intentContract));
  assert.ok(!('taskContractToRouteInput' in intentContract));
}

function testRoutePromptsDeclareTaskContextBoundary() {
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('new_task uses only current_input'));
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('\u753b\u4e00\u6761\u9c7c'));
  assert.ok(routeService.INTENT_REVIEW_SYSTEM_PROMPT.includes('new_task uses only current_input'));
  assert.ok(routeService.INTENT_REVIEW_SYSTEM_PROMPT.includes('complete task_contract.v2 only'));
  assert.ok(routeService.INTENT_REVIEW_SYSTEM_PROMPT.includes('Never return legacy route'));
  assert.strictEqual(routeService.parseRouteResult(JSON.stringify({ route: 'image_generate' }), routeContext.normalizeRoute, { input: FISH }), null);
}

module.exports = [
  testNewImageTaskUsesOnlyCurrentUserInput,
  testNewTaskRouteDoesNotFallbackToLastGeneratedPrompt,
  testNewTaskContractIgnoresContaminatedPromptPlanAndHistoryResources,
  testCorrectionTaskMayExplicitlyReusePreviousImageGoal,
  testTaskTypeSurvivesContractExecutionProjection,
  testRoutePromptsDeclareTaskContextBoundary,
];
