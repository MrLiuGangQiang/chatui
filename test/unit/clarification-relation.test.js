'use strict';

const assert = require('assert');
const relation = require('../../shared/clarification-relation');
const clarification = require('../../shared/clarification-answer');

function makePending() {
  return clarification.createPendingClarification({
    messages: [{ role: 'user', content: '这个呢' }],
    clarificationText: '请补充原任务所需的信息',
    routeInfo: {
      mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
      dispatchAuthorized: false, dispatchContract: null, resources: [], clarificationSlots: [],
    },
  });
}

function testRelationProtocolIsExactAndVersioned() {
  const clarificationRecord = relation.createRelationClarification({
    clarificationId: 'relation-1', pendingId: 'pending-1', input: '这个呢', sourceMessageIndex: 4,
  });
  assert.strictEqual(relation.hasExactRelationClarification(clarificationRecord), true);
  assert.deepStrictEqual(Object.keys(clarificationRecord), [
    'schema_version', 'clarification_id', 'pending_id', 'input', 'source_message_index',
  ]);
  const answer = relation.createRelationAnswer({
    clarificationId: 'relation-1', pendingId: 'pending-1', decision: 'continue',
  });
  assert.strictEqual(relation.hasExactRelationAnswer(answer), true);
  assert.strictEqual(Object.isFrozen(answer), true);
  assert.strictEqual(relation.hasExactRelationAnswer({ ...answer, extra: true }), false);
  assert.throws(
    () => relation.createRelationAnswer({ clarificationId: 'relation-1', pendingId: 'pending-1', decision: 'guess' }),
    error => error?.code === 'CLARIFICATION_RELATION_ANSWER_INVALID',
  );
}

function testRelationAnswerUsesAuthoritativePendingInputAndRejectsStaleIds() {
  const pending = makePending();
  const withRelation = clarification.createPendingRelationClarification(pending, {
    input: '这个呢', sourceMessageIndex: 1,
  });
  assert.ok(withRelation?.relationClarification);
  const answer = relation.createRelationAnswer({
    clarificationId: withRelation.relationClarification.clarification_id,
    pendingId: withRelation.id,
    decision: 'new_task',
  });
  const applied = clarification.applyPendingRelationAnswer(withRelation, answer);
  assert.strictEqual(applied.decision, 'new_task');
  assert.strictEqual(applied.input, '这个呢');
  assert.strictEqual(applied.source_message_index, 1);
  assert.strictEqual(applied.pending.relationClarification, null);
  assert.throws(
    () => clarification.applyPendingRelationAnswer(withRelation, relation.createRelationAnswer({
      clarificationId: 'relation-stale', pendingId: withRelation.id, decision: 'continue',
    })),
    error => error?.code === 'CLARIFICATION_RELATION_ID_MISMATCH',
  );
}

module.exports = [
  testRelationProtocolIsExactAndVersioned,
  testRelationAnswerUsesAuthoritativePendingInputAndRejectsStaleIds,
];
