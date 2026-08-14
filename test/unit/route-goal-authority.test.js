'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

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

function testConversationDependentTextTaskExecutesTheResolvedGoalWithoutRegexGates() {
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
  assert.strictEqual(route.executionPrompt, goal);
  assert.strictEqual(route.dispatchContract.arguments.prompt, goal);
}

function testResourceResolvedTaskExecutesTheResolvedGoal() {
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
  assert.strictEqual(route.executionPrompt, goal);
  assert.strictEqual(route.dispatchContract.arguments.prompt, goal);
}

function testRoutePromptForbidsInventingUnrequestedCreativeDetails() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /只消解指代[^。\n]*合并明确约束/);
  assert.match(prompt, /不增加未提主体\/场景\/风格\/构图\/颜色\/文字/);
  assert.match(prompt, /未提供的创作要素保持未指定/);
  assert.match(prompt, /不写候选键\/资源ID/);
  assert.doesNotMatch(prompt, /写清主体、场景、构图、风格、颜色、文字/);
}

function testReadOnlyMultiImageQuestionDoesNotAskSplitOrMerge() {
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
  assert.notStrictEqual(route.readiness, 'needs_clarification');
  assert.notStrictEqual(route.clarificationQuestion, '本轮请求包含多个不同执行任务，为避免静默吞并，请选择分开做（本轮只提交其中一个任务）或合并做（将多个意图合并为一条指令后重发）。');
}

module.exports = [
  testStandaloneNewTextTaskExecutesTheRawUserInput,
  testConversationDependentTextTaskExecutesTheResolvedGoalWithoutRegexGates,
  testResourceResolvedTaskExecutesTheResolvedGoal,
  testReadOnlyMultiImageQuestionDoesNotAskSplitOrMerge,
  testRoutePromptForbidsInventingUnrequestedCreativeDetails,
];
