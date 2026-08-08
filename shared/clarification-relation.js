(function initChatUIClarificationRelation(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('clarificationRelation', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIClarificationRelation() {
  'use strict';

  const RELATION_CLARIFICATION_VERSION = 'clarification_relation.v1';
  const RELATION_ANSWER_VERSION = 'clarification_relation_answer.v1';
  const RELATION_DECISIONS = Object.freeze(['continue', 'new_task']);
  const RELATION_DECISION_SET = new Set(RELATION_DECISIONS);
  const CLARIFICATION_FIELDS = Object.freeze([
    'schema_version', 'clarification_id', 'pending_id', 'input', 'source_message_index',
  ]);
  const ANSWER_FIELDS = Object.freeze([
    'schema_version', 'clarification_id', 'pending_id', 'decision',
  ]);

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }

  function hasExactRelationClarification(value = {}) {
    return hasOnlyFields(value, CLARIFICATION_FIELDS)
      && value.schema_version === RELATION_CLARIFICATION_VERSION
      && !!stringValue(value.clarification_id)
      && !!stringValue(value.pending_id)
      && !!stringValue(value.input)
      && Number.isInteger(value.source_message_index)
      && value.source_message_index >= 0;
  }

  function createRelationClarification({
    clarificationId = '', pendingId = '', input = '', sourceMessageIndex = 0,
  } = {}) {
    const clarification = {
      schema_version: RELATION_CLARIFICATION_VERSION,
      clarification_id: stringValue(clarificationId),
      pending_id: stringValue(pendingId),
      input: stringValue(input),
      source_message_index: Number(sourceMessageIndex),
    };
    if (!hasExactRelationClarification(clarification)) {
      const error = new TypeError('Invalid clarification_relation.v1');
      error.code = 'CLARIFICATION_RELATION_INVALID';
      throw error;
    }
    return deepFreeze(clarification);
  }

  function hasExactRelationAnswer(value = {}) {
    return hasOnlyFields(value, ANSWER_FIELDS)
      && value.schema_version === RELATION_ANSWER_VERSION
      && !!stringValue(value.clarification_id)
      && !!stringValue(value.pending_id)
      && RELATION_DECISION_SET.has(value.decision);
  }

  function createRelationAnswer({ clarificationId = '', pendingId = '', decision = '' } = {}) {
    const answer = {
      schema_version: RELATION_ANSWER_VERSION,
      clarification_id: stringValue(clarificationId),
      pending_id: stringValue(pendingId),
      decision: stringValue(decision),
    };
    if (!hasExactRelationAnswer(answer)) {
      const error = new TypeError('Invalid clarification_relation_answer.v1');
      error.code = 'CLARIFICATION_RELATION_ANSWER_INVALID';
      throw error;
    }
    return deepFreeze(answer);
  }

  function assertRelationAnswer(clarification = {}, answer = {}) {
    if (!hasExactRelationClarification(clarification)) {
      const error = new TypeError('Invalid clarification_relation.v1');
      error.code = 'CLARIFICATION_RELATION_INVALID';
      throw error;
    }
    if (!hasExactRelationAnswer(answer)) {
      const error = new TypeError('Invalid clarification_relation_answer.v1');
      error.code = 'CLARIFICATION_RELATION_ANSWER_INVALID';
      throw error;
    }
    if (answer.clarification_id !== clarification.clarification_id) {
      const error = new TypeError('Relation answer does not belong to the active clarification');
      error.code = 'CLARIFICATION_RELATION_ID_MISMATCH';
      throw error;
    }
    if (answer.pending_id !== clarification.pending_id) {
      const error = new TypeError('Relation answer does not belong to the active pending task');
      error.code = 'CLARIFICATION_RELATION_PENDING_MISMATCH';
      throw error;
    }
    return true;
  }

  function resolveRelationAnswer(clarification = {}, answer = {}) {
    assertRelationAnswer(clarification, answer);
    return deepFreeze({
      clarification_id: clarification.clarification_id,
      pending_id: clarification.pending_id,
      decision: answer.decision,
      input: clarification.input,
      source_message_index: clarification.source_message_index,
    });
  }

  return Object.freeze({
    RELATION_CLARIFICATION_VERSION,
    RELATION_ANSWER_VERSION,
    RELATION_DECISIONS,
    hasExactRelationClarification,
    createRelationClarification,
    hasExactRelationAnswer,
    createRelationAnswer,
    assertRelationAnswer,
    resolveRelationAnswer,
  });
});
