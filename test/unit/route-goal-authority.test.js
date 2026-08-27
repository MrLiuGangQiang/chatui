'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntent = require('../../shared/route-intent');

function inspect(intent, input, options = {}) {
  const result = routeService.inspectModelRouteResult(JSON.stringify({ task_shape: options.taskShape || 'single', ...intent }), {
    input,
    attachments: options.attachments || [],
    context: options.context || {},
  });
  assert.ok(result.route, result.error || result.reason);
  return result.route;
}

function testStandaloneNewTextTaskExecutesTheRawUserInput() {
  const input = '把这句话改得更简洁：项目已经基本完成了。';
  const route = inspect({
    operation: 'plain_chat',
    relation: 'new',
    goal: '用正式商务语气重写并补充下一步计划。',
    resource_refs: [],
  }, input);
  assert.strictEqual(route.executionPrompt, input);
  assert.strictEqual(route.dispatchContract.arguments.prompt, input);
  assert.strictEqual(route.userGoal, '用正式商务语气重写并补充下一步计划。');
}

function testTextToImageParametersComeOnlyFromTheRawUserTurn() {
  const input = '画一个中国美女 一个俄罗斯美女 给我两张图';
  const route = inspect({
    operation: 'text_to_image',
    relation: 'new',
    // This represents a bad advisory route summary. It must neither erase the
    // user's count nor turn it into the exclusion-based 1/3/4 clarification.
    goal: '画一位中国美女和一位俄罗斯美女。',
    resource_refs: [],
  }, input);

  assert.strictEqual(route.needClarification, false);
  assert.strictEqual(Object.hasOwn(route.dispatchContract.arguments, 'count'), false, 'count is no longer an image argument');
  assert.strictEqual(route.executionPrompt, '画一位中国美女和一位俄罗斯美女。');
  assert.strictEqual(route.dispatchContract.arguments.prompt, '画一位中国美女和一位俄罗斯美女。');
}

function testConversationDependentTextTaskKeepsRawUserInputAsProviderPrompt() {
  const input = '这个方面呢';
  const goal = '继续说明上一轮主题在性能方面的差异。';
  const route = inspect({
    operation: 'plain_chat',
    relation: 'followup',
    goal,
    resource_refs: [],
  }, input, {
    context: { recent_messages: [{ index: 1, role: 'assistant', content: '上一轮回答' }] },
  });
  // The final chat model must receive the user's literal follow-up. The route
  // goal remains routing metadata and must never replace or paraphrase it.
  assert.strictEqual(route.executionPrompt, input);
  assert.strictEqual(route.dispatchContract.arguments.prompt, input);
  assert.strictEqual(route.userGoal, goal);
}

function testResourceBoundChatKeepsRawUserInputAsProviderPrompt() {
  const requiredTail = `不得改动品牌名称、联系人、预算上限和上线日期：${'约束'.repeat(1400)}`;
  const input = `请分析这个合同，并重点核对违约责任。${requiredTail}`;
  const goal = '分析所选合同中的违约责任。';
  const route = inspect({
    operation: 'file_qa',
    relation: 'new',
    goal,
    resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
  }, input, {
    attachments: [{ id: 'contract', fileId: 'contract', name: 'contract.pdf', type: 'application/pdf', hasExtractedText: true }],
    context: {
      image_candidates: [],
      file_candidates: [{ index: 1, source: 'current', file_id: 'contract', name: 'contract.pdf', has_extracted_text: true }],
    },
  });
  assert.strictEqual(route.executionPrompt, input);
  assert.strictEqual(route.dispatchContract.arguments.prompt, input);
  assert.strictEqual(route.userGoal, goal);
}
function testResourceResolvedChatKeepsRawUserInputAsProviderPrompt() {
  const input = '这是什么';
  const goal = '概述所选合同文件的主要条款。';
  const route = inspect({
    operation: 'file_qa',
    relation: 'new',
    goal,
    resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
  }, input, {
    attachments: [{ id: 'contract', fileId: 'contract', name: 'contract.pdf', type: 'application/pdf', hasExtractedText: true }],
    context: {
      image_candidates: [],
      file_candidates: [{ index: 1, source: 'current', file_id: 'contract', name: 'contract.pdf', has_extracted_text: true }],
    },
  });
  assert.strictEqual(route.executionPrompt, input);
  assert.strictEqual(route.dispatchContract.arguments.prompt, input);
  assert.strictEqual(route.userGoal, goal);
}
function testRoutePromptForbidsInventingUnrequestedCreativeDetails() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /只消解指代[^。\n]*合并明确约束/);
  assert.match(prompt, /不增加未提主体\/场景\/风格\/构图\/颜色\/文字/);
  assert.match(prompt, /未提供的创作要素保持未指定/);
  assert.match(prompt, /不写候选键\/资源ID/);
  assert.doesNotMatch(prompt, /写清主体、场景、构图、风格、颜色、文字/);
}

function testReadOnlyMultiImageShapeRequiresClarificationWithoutRewritingTheModelOutput() {
  const route = inspect({
    operation: 'image_qa',
    relation: 'new',
    goal: '回答第一张图的文字和最后一张图的颜色。',
    resource_refs: [{ candidate_key: 'i1', role: 'source' }, { candidate_key: 'i3', role: 'source' }],
  }, '第一张文字是什么，最后一张颜色是什么', {
    taskShape: 'multi',
    attachments: [
      { id: 'img-a', imageId: 'img-a', type: 'image/png' },
      { id: 'img-b', imageId: 'img-b', type: 'image/png' },
      { id: 'img-c', imageId: 'img-c', type: 'image/png' },
    ],
    context: { image_candidates: [
      { index: 1, source: 'current', id: 'img-a', image_id: 'img-a', reference_id: 'ref-a' },
      { index: 2, source: 'current', id: 'img-b', image_id: 'img-b', reference_id: 'ref-b' },
      { index: 3, source: 'current', id: 'img-c', image_id: 'img-c', reference_id: 'ref-c' },
    ] },
  });

  assert.strictEqual(route.taskShape, 'multi', 'the compiler must preserve the model-owned semantic field');
  assert.strictEqual(route.needClarification, true);
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.strictEqual(route.readiness, 'needs_clarification');
      assert.match(route.clarificationQuestion, /多个不同执行任务|一次只能执行一个/);
  assert.doesNotMatch(route.clarificationQuestion, /合并做/);
}

function testMaximumGoalSurvivesRouteParsingAndImageExecutionCompilation() {
  const goal = '图'.repeat(routeIntent.ROUTE_INTENT_MAX_GOAL_LENGTH);
  const route = inspect({
    operation: 'text_to_image',
    relation: 'new',
    goal,
    resource_refs: [],
  }, '生成一张图片');

  assert.strictEqual(route.userGoal, goal);
  assert.strictEqual(route.executionPrompt, goal);
  assert.strictEqual(route.dispatchContract.arguments.prompt, goal);

  const rejected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'text_to_image',
    relation: 'new',
    goal: `${goal}图`,
    resource_refs: [],
    task_shape: 'single',
  }), { input: '生成一张图片', attachments: [], context: {} });
  assert.strictEqual(rejected.route, null);
  assert.strictEqual(rejected.reason, 'route_intent_invalid');
}

module.exports = [
  testStandaloneNewTextTaskExecutesTheRawUserInput,
  testTextToImageParametersComeOnlyFromTheRawUserTurn,
  testConversationDependentTextTaskKeepsRawUserInputAsProviderPrompt,
  testResourceBoundChatKeepsRawUserInputAsProviderPrompt,
  testResourceResolvedChatKeepsRawUserInputAsProviderPrompt,
  testReadOnlyMultiImageShapeRequiresClarificationWithoutRewritingTheModelOutput,
  testMaximumGoalSurvivesRouteParsingAndImageExecutionCompilation,
  testRoutePromptForbidsInventingUnrequestedCreativeDetails,
];
