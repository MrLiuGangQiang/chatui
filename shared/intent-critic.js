(function initChatUIIntentCritic(root, factory) {
  'use strict';

  const intentClaims = root?.[Symbol.for('chatui.module-registry.v1')]?.get('intentClaims')
    || (typeof require === 'function' ? require('./intent-claims') : {});
  const api = factory(intentClaims);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('intentCritic', api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createChatUIIntentCritic(intentClaims) {
  'use strict';

  intentClaims = intentClaims || {};
  const INTENT_CRITIC_VERSION = 'intent_critic.v1';
  const VERDICTS = Object.freeze(['accept', 'repair', 'clarify', 'reject']);
  const REASON_CODES = Object.freeze([
    'route_goal_missing_explicit_claim',
    'route_operation_mismatch',
    'route_resource_mismatch',
    'route_exclusion_violated',
    'route_unsupported_assumption',
    'route_unnecessary_clarification',
    'route_dependency_lost',
  ]);

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function bounded(value = '', limit = 240) {
    return stringValue(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, limit);
  }

  function normalizeReason(reason = {}) {
    const source = reason && typeof reason === 'object' && !Array.isArray(reason) ? reason : {};
    const code = stringValue(source.code);
    return Object.freeze({
      code: REASON_CODES.includes(code) ? code : 'route_unsupported_assumption',
      field: bounded(source.field, 48),
      message: bounded(source.message, 240),
    });
  }

  function normalizeClaimLink(link = {}) {
    const source = link && typeof link === 'object' && !Array.isArray(link) ? link : {};
    return Object.freeze({
      claim_id: bounded(source.claim_id || source.id, 64),
      action_ids: Object.freeze((Array.isArray(source.action_ids) ? source.action_ids : [])
        .map(item => bounded(item, 48)).filter(Boolean).slice(0, 8)),
    });
  }

  function hasExactIntentCritic(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.schema_version !== INTENT_CRITIC_VERSION || !VERDICTS.includes(stringValue(value.verdict))) return false;
    for (const key of ['covered_claims', 'missing_claims', 'conflicts', 'unsupported_assumptions', 'ambiguous_bindings', 'reasons']) {
      if (!Array.isArray(value[key])) return false;
    }
    return value.covered_claims.every(item => item && typeof item === 'object')
      && value.reasons.every(item => item && typeof item === 'object');
  }

  function normalizeIntentCritic(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.freeze({
      schema_version: INTENT_CRITIC_VERSION,
      verdict: VERDICTS.includes(stringValue(source.verdict)) ? stringValue(source.verdict) : 'reject',
      covered_claims: Object.freeze((Array.isArray(source.covered_claims) ? source.covered_claims : []).map(normalizeClaimLink).slice(0, 32)),
      missing_claims: Object.freeze((Array.isArray(source.missing_claims) ? source.missing_claims : []).map(item => bounded(item, 240)).filter(Boolean).slice(0, 32)),
      conflicts: Object.freeze((Array.isArray(source.conflicts) ? source.conflicts : []).map(item => bounded(item, 240)).filter(Boolean).slice(0, 32)),
      unsupported_assumptions: Object.freeze((Array.isArray(source.unsupported_assumptions) ? source.unsupported_assumptions : []).map(item => bounded(item, 240)).filter(Boolean).slice(0, 32)),
      ambiguous_bindings: Object.freeze((Array.isArray(source.ambiguous_bindings) ? source.ambiguous_bindings : []).map(item => bounded(item, 240)).filter(Boolean).slice(0, 32)),
      reasons: Object.freeze((Array.isArray(source.reasons) ? source.reasons : []).map(normalizeReason).slice(0, 16)),
    });
  }

  const INTENT_CRITIC_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_intent_critic_v1',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'schema_version', 'verdict', 'covered_claims', 'missing_claims',
          'conflicts', 'unsupported_assumptions', 'ambiguous_bindings', 'reasons',
        ],
        properties: {
          schema_version: { type: 'string', const: INTENT_CRITIC_VERSION },
          verdict: { type: 'string', enum: [...VERDICTS] },
          covered_claims: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['claim_id', 'action_ids'],
              properties: {
                claim_id: { type: 'string' },
                action_ids: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          missing_claims: { type: 'array', items: { type: 'string' } },
          conflicts: { type: 'array', items: { type: 'string' } },
          unsupported_assumptions: { type: 'array', items: { type: 'string' } },
          ambiguous_bindings: { type: 'array', items: { type: 'string' } },
          reasons: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['code', 'field', 'message'],
              properties: {
                code: { type: 'string', enum: [...REASON_CODES] },
                field: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
    },
  });

  function routeOperation(route = {}) {
    return stringValue(route?.operationType || route?.operation || route?.intent);
  }

  function routeGoal(route = {}) {
    return stringValue(route?.userGoal || route?.goal || route?.executionPrompt);
  }

  function routeResources(route = {}) {
    return Array.isArray(route?.resources) ? route.resources : [];
  }

  function localCritic({ input = '', route = null, understanding = null } = {}) {
    const reasons = [];
    const operation = routeOperation(route || {});
    const resources = routeResources(route || {});
    if (['plain_chat', 'web_search'].includes(operation)
        && resources.some(resource => ['image', 'file'].includes(stringValue(resource?.type)))) {
      reasons.push({
        code: 'route_resource_mismatch',
        field: 'resource_refs',
        message: '文字任务不应绑定图片或文件资源。',
      });
    }
    const actionCount = Array.isArray(understanding?.actions) ? understanding.actions.length : 0;
    if (actionCount > 1 && stringValue(route?.taskShape || route?.task_shape) === 'single') {
      reasons.push({
        code: 'route_dependency_lost',
        field: 'task_shape',
        message: '理解节点识别出多个独立动作，但最终路由只保留了单任务。',
      });
    }

    const uniqueReasons = [];
    const seen = new Set();
    for (const reason of reasons) {
      const normalized = normalizeReason(reason);
      const key = `${normalized.code}|${normalized.field}|${normalized.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueReasons.push(normalized);
    }
    const verdict = uniqueReasons.length ? 'repair' : 'accept';
    return normalizeIntentCritic({
      schema_version: INTENT_CRITIC_VERSION,
      verdict,
      covered_claims: [],
      missing_claims: [],
      conflicts: [],
      unsupported_assumptions: [],
      ambiguous_bindings: [],
      reasons: uniqueReasons,
    });
  }

  return Object.freeze({
    INTENT_CRITIC_VERSION,
    VERDICTS,
    REASON_CODES,
    INTENT_CRITIC_RESPONSE_FORMAT,
    hasExactIntentCritic,
    normalizeIntentCritic,
    localCritic,
  });
});
