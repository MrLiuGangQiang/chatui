'use strict';

// Regression: the intent response schema narrows goal_mode to ['replace'] when
// no previous task state exists, but some OpenAI-compatible providers (e.g.
// Qwen) ignore the strict enum and return goal_mode: "amend" anyway. Amending
// without a base task state used to fail the whole route with
// "Amending a task requires a previous task state"; the intent compile
// boundary must degrade such output to replace and keep the goal.

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const taskContinuity = require('../../shared/task-continuity');

function editIntent(goalMode) {
  return {
    operation: 'edit_image',
    relation: 'followup',
    goal: '将图片风格改为卡通动漫风格',
    goal_mode: goalMode,
    resource_refs: ['i1', 'i2', 'i3', 'i4', 'i5'].map(key => ({ role: 'target', candidate_key: key })),
    task_shape: 'multi',
  };
}

function compile(goalMode, context = {}) {
  return routeService.inspectModelRouteResult(JSON.stringify(editIntent(goalMode)), {
    input: '将图片风格改为卡通动漫风格',
    attachments: [],
    context,
    currentMode: 'image',
    autoMode: true,
    currentTurn: null,
  });
}

function testAmendWithoutPreviousStateDegradesToReplace() {
  const result = compile('amend', {});
  assert.strictEqual(result.reason, '', `route must compile, got: ${result.reason} ${result.error || ''}`);
  assert.ok(result.route, 'route must compile');
  assert.strictEqual(result.route.goalMode, 'replace',
    'amend without a previous task state must degrade to replace so the request executes');
}

function testAmendWithPreviousStateStaysAmend() {
  const result = compile('amend', {
    previous_execution: {
      operation: 'text_to_image',
      family: 'generate',
      goal_mode: 'replace',
      segments: [{ kind: 'base', text: '生成一张加菲猫' }],
      resolved_goal: '生成一张加菲猫',
    },
  });
  assert.strictEqual(result.reason, '');
  assert.strictEqual(result.route.goalMode, 'amend', 'a valid base task state must keep amend semantics');
}

function testReplaceWithoutPreviousStateStaysReplace() {
  const result = compile('replace', {});
  assert.strictEqual(result.reason, '');
  assert.strictEqual(result.route.goalMode, 'replace');
}

function testProtocolLayerStillRejectsAmendWithoutBase() {
  assert.throws(
    () => taskContinuity.transitionTaskContinuity({ goalMode: 'amend', goal: '把入口移开。' }),
    error => error?.code === 'TASK_CONTINUITY_BASE_REQUIRED',
    'the protocol layer must stay strict; degradation belongs to the intent compile boundary',
  );
}

module.exports = [
  testAmendWithoutPreviousStateDegradesToReplace,
  testAmendWithPreviousStateStaysAmend,
  testReplaceWithoutPreviousStateStaysReplace,
  testProtocolLayerStillRejectsAmendWithoutBase,
];