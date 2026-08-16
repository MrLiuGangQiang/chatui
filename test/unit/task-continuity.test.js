'use strict';

const assert = require('assert');
const continuity = require('../../shared/task-continuity');

function testOptionalTaskStateBoundaryPreservesValidStateAndRejectsCorruption() {
  const state = continuity.transitionTaskContinuity({ goalMode: 'replace', goal: '有效基础' });
  assert.deepStrictEqual(continuity.normalizeOptionalTaskContinuity(state), state);
  assert.strictEqual(continuity.normalizeOptionalTaskContinuity(null), null);
  assert.throws(() => continuity.normalizeOptionalTaskContinuity({}), error => error?.code === 'TASK_CONTINUITY_INVALID');
}

function testImageTaskLineagePreservesIndependentBatchStatesByReferenceAndImage() {
  const firstState = continuity.transitionTaskContinuity({ goalMode: 'replace', goal: '生成日间方案' });
  const secondState = continuity.transitionTaskContinuity({ goalMode: 'replace', goal: '生成夜间方案' });
  const first = continuity.createImageTaskLineage({
    referenceId: 'imgref-day', imageIds: ['img-day-1'], taskState: firstState,
  });
  const second = continuity.createImageTaskLineage({
    referenceId: 'imgref-night', imageIds: ['img-night-1'], taskState: secondState,
  });
  const merged = continuity.mergeImageTaskLineages(first, second);
  assert.strictEqual(merged.schema_version, 'image_task_lineage.v1');
  assert.strictEqual(merged.entries.length, 2);
  assert.strictEqual(continuity.taskContinuityFromImageTaskLineage(merged), null,
    'a heterogeneous batch has no implicit single text-task state');
  assert.deepStrictEqual(
    continuity.taskContinuityFromImageTaskLineage(merged, { referenceId: 'imgref-day' }),
    firstState,
  );
  assert.deepStrictEqual(
    continuity.taskContinuityFromImageTaskLineage(merged, { imageId: 'img-night-1' }),
    secondState,
  );
}

function testImageTaskLineageRejectsConflictingStateForOneResultReference() {
  const first = continuity.createImageTaskLineage({
    referenceId: 'imgref-same',
    imageIds: ['img-same'],
    taskState: continuity.transitionTaskContinuity({ goalMode: 'replace', goal: '第一任务' }),
  });
  const conflicting = continuity.createImageTaskLineage({
    referenceId: 'imgref-same',
    imageIds: ['img-same'],
    taskState: continuity.transitionTaskContinuity({ goalMode: 'replace', goal: '冲突任务' }),
  });
  assert.throws(() => continuity.mergeImageTaskLineages(first, conflicting),
    error => error?.code === 'IMAGE_TASK_LINEAGE_CONFLICT');
}

function testReplacementCreatesOneImmutableBaseSegment() {
  const state = continuity.transitionTaskContinuity({ goalMode: 'replace', goal: '生成一张对称住宅户型图。' });
  assert.strictEqual(Object.isFrozen(state), true);
  assert.strictEqual(Object.isFrozen(state.segments), true);
  assert.deepStrictEqual(state, {
    schema_version: 'task_continuity.v1',
    goal_mode: 'replace',
    segments: [{ kind: 'base', text: '生成一张对称住宅户型图。' }],
  });
  assert.strictEqual(continuity.renderTaskContinuity(state), '生成一张对称住宅户型图。');
}

function testAmendmentPreservesOrderedRequirementsAndLatestPriority() {
  const base = continuity.transitionTaskContinuity({ goalMode: 'replace', goal: '总长18米、总宽8米，左右镜像。' });
  const first = continuity.transitionTaskContinuity({ goalMode: 'amend', goal: '堂屋入口保持无遮挡。', previousState: base });
  const second = continuity.transitionTaskContinuity({ goalMode: 'amend', goal: '卫生间不得与餐厅相邻。', previousState: first });
  assert.deepStrictEqual(second.segments, [
    { kind: 'base', text: '总长18米、总宽8米，左右镜像。' },
    { kind: 'amendment', text: '堂屋入口保持无遮挡。' },
    { kind: 'amendment', text: '卫生间不得与餐厅相邻。' },
  ]);
  assert.strictEqual(continuity.renderTaskContinuity(second), [
    '任务基础要求：\n总长18米、总宽8米，左右镜像。',
    '修订要求（按顺序应用，后者优先）：\n1. 堂屋入口保持无遮挡。\n2. 卫生间不得与餐厅相邻。',
  ].join('\n\n'));
}

function testLegacyResolvedGoalHasOneExplicitMigrationPath() {
  const state = continuity.taskContinuityFromExecution({ resolved_goal: '旧版完整图片任务规格' });
  assert.deepStrictEqual(state, {
    schema_version: 'task_continuity.v1',
    goal_mode: 'replace',
    segments: [{ kind: 'base', text: '旧版完整图片任务规格' }],
  });
}

function testAmendmentWithoutPreviousStateIsRejected() {
  assert.throws(() => continuity.transitionTaskContinuity({
    goalMode: 'amend',
    goal: '把入口移开。',
  }), error => error?.code === 'TASK_CONTINUITY_BASE_REQUIRED');
}

function testInvalidSegmentOrderingIsRejected() {
  assert.strictEqual(continuity.hasExactTaskContinuity({
    schema_version: 'task_continuity.v1',
    goal_mode: 'amend',
    segments: [
      { kind: 'base', text: '基础' },
      { kind: 'base', text: '错误的第二基础' },
    ],
  }), false);
}

function testInvalidExplicitExecutionTaskStateCannotSilentlyMigrateToLegacyText() {
  assert.throws(() => continuity.taskContinuityFromExecution({
    task_state: {
      schema_version: 'task_continuity.v1',
      goal_mode: 'amend',
      segments: [{ kind: 'amendment', text: '缺少基础段' }],
    },
    input: '旧版输入不应成为静默兜底',
  }), error => error?.code === 'TASK_CONTINUITY_INVALID');
}

function testInvalidExplicitPreviousStateCannotFallBackToAnotherExecutionState() {
  const base = continuity.transitionTaskContinuity({ goalMode: 'replace', goal: '有效基础' });
  assert.throws(() => continuity.transitionTaskContinuity({
    goalMode: 'amend',
    goal: '新修订',
    previousState: { schema_version: 'task_continuity.v1', goal_mode: 'amend', segments: [] },
    previousExecution: { input: continuity.renderTaskContinuity(base) },
  }), error => error?.code === 'TASK_CONTINUITY_INVALID');
}

function testSegmentCapacityCompactsWithoutLosingAnyRequirement() {
  let state = continuity.transitionTaskContinuity({ goalMode: 'replace', goal: '基础要求' });
  for (let index = 1; index < continuity.TASK_CONTINUITY_MAX_SEGMENTS; index += 1) {
    state = continuity.transitionTaskContinuity({ goalMode: 'amend', goal: `修订${index}`, previousState: state });
  }
  const compacted = continuity.transitionTaskContinuity({ goalMode: 'amend', goal: '最后修订', previousState: state });
  assert.strictEqual(compacted.segments.length, 2);
  const rendered = continuity.renderTaskContinuity(compacted);
  assert.match(rendered, /基础要求/);
  for (let index = 1; index < continuity.TASK_CONTINUITY_MAX_SEGMENTS; index += 1) {
    assert.match(rendered, new RegExp(`修订${index}`));
  }
  assert.match(rendered, /最后修订/);
}

function testRepeatedUserAmendmentsRemainSeparateOrderedEvents() {
  const base = continuity.transitionTaskContinuity({ goalMode: 'replace', goal: '基础要求' });
  const first = continuity.transitionTaskContinuity({ goalMode: 'amend', goal: '入口不得遮挡', previousState: base });
  const second = continuity.transitionTaskContinuity({ goalMode: 'amend', goal: '入口不得遮挡', previousState: first });
  assert.strictEqual(second.segments.length, 3,
    'task state must preserve user revision events instead of using lexical de-duplication heuristics');
}

module.exports = [
  testImageTaskLineagePreservesIndependentBatchStatesByReferenceAndImage,
  testImageTaskLineageRejectsConflictingStateForOneResultReference,
  testOptionalTaskStateBoundaryPreservesValidStateAndRejectsCorruption,
  testReplacementCreatesOneImmutableBaseSegment,
  testAmendmentPreservesOrderedRequirementsAndLatestPriority,
  testLegacyResolvedGoalHasOneExplicitMigrationPath,
  testAmendmentWithoutPreviousStateIsRejected,
  testInvalidSegmentOrderingIsRejected,
  testInvalidExplicitExecutionTaskStateCannotSilentlyMigrateToLegacyText,
  testInvalidExplicitPreviousStateCannotFallBackToAnotherExecutionState,
  testSegmentCapacityCompactsWithoutLosingAnyRequirement,
  testRepeatedUserAmendmentsRemainSeparateOrderedEvents,
];
