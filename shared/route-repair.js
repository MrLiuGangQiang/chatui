(function initChatUIRouteRepair(root, factory) {
  'use strict';

  const routeIntent = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeIntent')
    || root?.ChatUIRouteIntent
    || (typeof require === 'function' ? require('./route-intent') : {});
  const api = factory(routeIntent);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('routeRepair', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIRouteRepair(routeIntent) {
  'use strict';

  const ROUTE_REPAIR_VERSION = 'route_repair.v1';
  const ROUTE_REPAIR_FIELDS = Object.freeze([
    'operation', 'relation', 'goal', 'goal_mode', 'resource_refs', 'task_shape',
  ]);
  const ROUTE_REPAIR_RESPONSE_FIELDS = Object.freeze([
    'schema_version', 'changed_fields', ...ROUTE_REPAIR_FIELDS,
  ]);

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }

  function asRouteIntent(value = {}) {
    return {
      operation: stringValue(value.operation),
      relation: stringValue(value.relation),
      goal: stringValue(value.goal),
      goal_mode: stringValue(value.goal_mode),
      resource_refs: Array.isArray(value.resource_refs) ? value.resource_refs : [],
      task_shape: stringValue(value.task_shape),
    };
  }

  function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  const ROUTE_REPAIR_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_route_repair_v1',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [...ROUTE_REPAIR_RESPONSE_FIELDS],
        properties: {
          schema_version: { type: 'string', enum: [ROUTE_REPAIR_VERSION] },
          changed_fields: {
            type: 'array',
            items: { type: 'string', enum: [...ROUTE_REPAIR_FIELDS] },
          },
          operation: { type: 'string' },
          relation: { type: 'string' },
          goal: { type: 'string' },
          goal_mode: { type: 'string' },
          resource_refs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['candidate_key', 'role'],
              properties: {
                candidate_key: { type: 'string', pattern: '^[ifm][1-9]\\d*$' },
                role: { type: 'string' },
              },
            },
          },
          task_shape: { type: 'string' },
        },
      },
    },
  });

  function routeRepairResponseFormatForCandidates(candidates = []) {
    const candidateKeys = [];
    const seen = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const key = stringValue(candidate && typeof candidate === 'object' ? candidate.candidate_key : candidate);
      if (!/^[ifm][1-9]\d*$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      candidateKeys.push(key);
    }
    const responseFormat = JSON.parse(JSON.stringify(ROUTE_REPAIR_RESPONSE_FORMAT));
    const resourceRefs = responseFormat.json_schema.schema.properties.resource_refs;
    if (!candidateKeys.length) resourceRefs.maxItems = 0;
    else resourceRefs.items.properties.candidate_key.enum = candidateKeys;
    return Object.freeze(responseFormat);
  }

  function hasExactRouteRepair(value = {}) {
    if (!hasOnlyFields(value, ROUTE_REPAIR_RESPONSE_FIELDS)) return false;
    if (stringValue(value.schema_version) !== ROUTE_REPAIR_VERSION) return false;
    const changedFields = Array.isArray(value.changed_fields) ? value.changed_fields.map(stringValue) : [];
    if (!changedFields.length || changedFields.length > ROUTE_REPAIR_FIELDS.length) return false;
    if (!changedFields.every(field => ROUTE_REPAIR_FIELDS.includes(field))) return false;
    if (new Set(changedFields).size !== changedFields.length) return false;
    return typeof routeIntent.hasExactRouteIntent === 'function'
      && routeIntent.hasExactRouteIntent(asRouteIntent(value));
  }

  function adaptLegacyRouteIntentRepair(value = {}, baseIntent = {}) {
    if (typeof routeIntent.hasExactRouteIntent !== 'function'
        || !routeIntent.hasExactRouteIntent(value)
        || !routeIntent.hasExactRouteIntent(baseIntent)) return null;
    const changedFields = ROUTE_REPAIR_FIELDS.filter(field => !sameValue(value[field], baseIntent[field]));
    if (!changedFields.length) return null;
    return normalizeRouteRepair({
      schema_version: ROUTE_REPAIR_VERSION,
      changed_fields: changedFields,
      ...asRouteIntent(value),
    });
  }

  function normalizeRouteRepair(value = {}) {
    if (!hasExactRouteRepair(value)) {
      const error = new TypeError('Invalid route_repair.v1');
      error.code = 'ROUTE_REPAIR_INVALID';
      throw error;
    }
    const route = asRouteIntent(value);
    return Object.freeze({
      schema_version: ROUTE_REPAIR_VERSION,
      changed_fields: Object.freeze(value.changed_fields.map(stringValue)),
      ...route,
    });
  }

  function unchangedFieldsMatchBase(baseIntent = {}, repair = {}) {
    const changed = new Set(Array.isArray(repair.changed_fields) ? repair.changed_fields : []);
    for (const field of ROUTE_REPAIR_FIELDS) {
      if (changed.has(field)) continue;
      if (!sameValue(repair[field], baseIntent[field])) return false;
    }
    return true;
  }

  function applyRouteRepair(baseIntent = {}, repair = {}) {
    if (typeof routeIntent.hasExactRouteIntent !== 'function' || !routeIntent.hasExactRouteIntent(baseIntent)) {
      const error = new TypeError('Route repair requires an exact route_intent.v3 base');
      error.code = 'ROUTE_REPAIR_BASE_INVALID';
      throw error;
    }
    const normalized = normalizeRouteRepair(repair);
    if (!unchangedFieldsMatchBase(baseIntent, normalized)) {
      const error = new TypeError('Route repair changed an undeclared field');
      error.code = 'ROUTE_REPAIR_UNDECLARED_CHANGE';
      throw error;
    }
    const next = { ...baseIntent };
    for (const field of normalized.changed_fields) next[field] = normalized[field];
    if (!routeIntent.hasExactRouteIntent(next)) {
      const error = new TypeError('Route repair produced an invalid route_intent.v3');
      error.code = 'ROUTE_REPAIR_RESULT_INVALID';
      throw error;
    }
    return Object.freeze(next);
  }

  return Object.freeze({
    ROUTE_REPAIR_VERSION,
    ROUTE_REPAIR_FIELDS,
    ROUTE_REPAIR_RESPONSE_FIELDS,
    ROUTE_REPAIR_RESPONSE_FORMAT,
    routeRepairResponseFormatForCandidates,
    hasExactRouteRepair,
    normalizeRouteRepair,
    adaptLegacyRouteIntentRepair,
    unchangedFieldsMatchBase,
    applyRouteRepair,
  });
});
