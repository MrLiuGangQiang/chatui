(function initChatUISemanticIntent(root, factory) {
  'use strict';

  const intentClaims = root?.[Symbol.for('chatui.module-registry.v1')]?.get('intentClaims')
    || (typeof require === 'function' ? require('./intent-claims') : {});
  const api = factory(intentClaims);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('semanticIntent', api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createChatUISemanticIntent(intentClaims) {
  'use strict';

  intentClaims = intentClaims || {};
  const SEMANTIC_INTENT_VERSION = 'semantic_intent.v1';
  const POLARITIES = Object.freeze(['must', 'must_not', 'context', 'optional']);
  const MAX_ACTIONS = 20;
  const MAX_CLAIMS = 32;
  const MAX_TEXT = 1000;

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function bounded(value = '', limit = MAX_TEXT) {
    return stringValue(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function uniqueText(values = [], limit = MAX_CLAIMS) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : [values]) {
      const normalized = bounded(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
      if (result.length >= limit) break;
    }
    return result;
  }

  function normalizeClaim(claim = {}, index = 0) {
    const source = claim && typeof claim === 'object' && !Array.isArray(claim) ? claim : {};
    const polarity = POLARITIES.includes(stringValue(source.polarity)) ? stringValue(source.polarity) : 'must';
    return Object.freeze({
      id: bounded(source.id || `c${index + 1}`, 64),
      text: bounded(source.text || source.fact || ''),
      polarity,
      source: bounded(source.source || 'current_input', 64),
      critical: source.critical !== false,
      ...(source.type ? { type: bounded(source.type, 64) } : {}),
    });
  }

  function normalizeRef(ref = {}) {
    const source = ref && typeof ref === 'object' && !Array.isArray(ref) ? ref : {};
    return Object.freeze({
      candidate_key: bounded(source.candidate_key || source.key, 32),
      text: bounded(source.text || '', 180),
    });
  }

  function normalizeAction(action = {}, index = 0) {
    const source = action && typeof action === 'object' && !Array.isArray(action) ? action : {};
    const actionId = bounded(source.id || `a${Number(source.index) || index + 1}`, 48);
    return Object.freeze({
      id: actionId,
      index: Number(source.index) || index + 1,
      kind: bounded(source.kind, 64),
      target: bounded(source.target),
      must: Object.freeze(uniqueText(source.must, 12)),
      must_not: Object.freeze(uniqueText(source.must_not, 12)),
      resource_refs: Object.freeze((Array.isArray(source.resolved_refs) ? source.resolved_refs : Array.isArray(source.resource_refs) ? source.resource_refs : [])
        .map(normalizeRef).filter(ref => ref.candidate_key)),
      claim_ids: Object.freeze((Array.isArray(source.claim_ids) ? source.claim_ids : []).map(item => bounded(item, 64)).filter(Boolean).slice(0, 16)),
      depends_on: Object.freeze((Array.isArray(source.depends_on) ? source.depends_on : []).map(item => bounded(item, 48)).filter(Boolean).slice(0, 8)),
      output: bounded(source.output || '', 240),
    });
  }

  function normalizeSemanticIntent(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.freeze({
      schema_version: SEMANTIC_INTENT_VERSION,
      goal: bounded(source.goal || source.user_goal || ''),
      claims: Object.freeze((Array.isArray(source.claims) ? source.claims : []).map(normalizeClaim).filter(claim => claim.text).slice(0, MAX_CLAIMS)),
      actions: Object.freeze((Array.isArray(source.actions) ? source.actions : []).map(normalizeAction).slice(0, MAX_ACTIONS)),
      ambiguities: Object.freeze(uniqueText(source.ambiguities, 16)),
      assumptions: Object.freeze(uniqueText(source.assumptions, 16)),
      success_criteria: Object.freeze(uniqueText(source.success_criteria, 24)),
    });
  }

  function hasExactSemanticIntent(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.schema_version !== SEMANTIC_INTENT_VERSION || typeof value.goal !== 'string') return false;
    if (!Array.isArray(value.claims) || !Array.isArray(value.actions)
        || !Array.isArray(value.ambiguities) || !Array.isArray(value.assumptions)
        || !Array.isArray(value.success_criteria)) return false;
    return value.claims.every(claim => claim && typeof claim.id === 'string' && typeof claim.text === 'string' && POLARITIES.includes(claim.polarity))
      && value.actions.every(action => action && typeof action.id === 'string' && typeof action.kind === 'string')
      && value.ambiguities.every(item => typeof item === 'string')
      && value.assumptions.every(item => typeof item === 'string')
      && value.success_criteria.every(item => typeof item === 'string');
  }

  function buildSemanticIntent({ input = '', understanding = null, claims = null, context = {} } = {}) {
    const sourceClaims = Array.isArray(claims)
      ? claims
      : typeof intentClaims.extractClaims === 'function' ? intentClaims.extractClaims(input) : [];
    const normalizedClaims = sourceClaims.map(normalizeClaim).filter(claim => claim.text).slice(0, MAX_CLAIMS);
    const rawActions = Array.isArray(understanding?.actions) ? understanding.actions : [];
    const actionClaims = normalizedClaims.filter(claim => claim.critical && claim.polarity === 'must').map(claim => claim.id);
    const actions = rawActions.map((action, index) => {
      const normalized = normalizeAction(action, index);
      return normalizeAction({
        ...normalized,
        claim_ids: normalized.claim_ids.length ? normalized.claim_ids : (rawActions.length === 1 ? actionClaims : []),
        must: normalized.must.length ? normalized.must : (rawActions.length === 1 ? normalizedClaims.filter(claim => claim.polarity === 'must').map(claim => claim.text) : []),
        must_not: normalized.must_not.length ? normalized.must_not : (rawActions.length === 1 ? normalizedClaims.filter(claim => claim.polarity === 'must_not').map(claim => claim.text) : []),
      }, index);
    });
    const clarification = context?.clarification_context && typeof context.clarification_context === 'object'
      ? context.clarification_context : {};
    const ambiguities = [
      ...(Array.isArray(clarification.unresolved_resources) ? clarification.unresolved_resources.map(item => `${stringValue(item?.role || item?.type)}:${stringValue(item?.reason || 'unresolved')}`) : []),
      ...(Array.isArray(context?.ambiguities) ? context.ambiguities : []),
    ];
    return normalizeSemanticIntent({
      schema_version: SEMANTIC_INTENT_VERSION,
      goal: input,
      claims: normalizedClaims,
      actions,
      ambiguities,
      assumptions: [],
      success_criteria: normalizedClaims.filter(claim => claim.critical && claim.polarity === 'must').map(claim => claim.text),
    });
  }

  return Object.freeze({
    SEMANTIC_INTENT_VERSION,
    POLARITIES,
    normalizeSemanticIntent,
    hasExactSemanticIntent,
    buildSemanticIntent,
  });
});
