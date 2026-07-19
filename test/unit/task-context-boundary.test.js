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

function testQuotedImageGenerationPreservesTheExplicitSourceDescription() {
  const quotedDescription = '\u4e00\u5e45\u8be6\u7ec6\u7684\u590f\u65e5\u6d77\u8fb9\u63d2\u753b\uff0c\u91d1\u8272\u5915\u9633\uff0c\u900f\u660e\u6d6a\u82b1\uff0c\u8fdc\u5904\u706f\u5854\uff0c\u67d4\u548c\u7535\u5f71\u5149\u5f71';
  const shortRequest = '\u57fa\u4e8e\u5f15\u7528\u6d88\u606f\u751f\u6210\u56fe\u7247';
  const context = { suggested_contextual_image_prompt: `${quotedDescription}\n\n${shortRequest}` };
  const raw = imageContract({ currentIntent: shortRequest, finalInstruction: shortRequest });

  const composed = promptComposer.composeImageGeneratePrompt(raw, context, shortRequest);
  assert.ok(composed.includes(quotedDescription), 'an explicit quoted description must survive even when the router labels the request as a new task');
  assert.ok(composed.includes(shortRequest));
  assert.notStrictEqual(composed, shortRequest, 'the image prompt must not collapse to the short follow-up instruction');

  const parsed = routeService.parseRouteResult(JSON.stringify(raw), routeContext.normalizeRoute, { input: shortRequest, attachments: [], context });
  assert.ok(parsed.contextualImagePrompt.includes(quotedDescription), 'the routed image prompt must carry the quoted source description into execution');
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
  testQuotedImageGenerationPreservesTheExplicitSourceDescription,
  testCorrectionTaskMayExplicitlyReusePreviousImageGoal,
  testTaskTypeSurvivesContractExecutionProjection,
  testRoutePromptsDeclareTaskContextBoundary,
];
