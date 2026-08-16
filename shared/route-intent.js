(function initChatUIRouteIntent(root, factory) {
  'use strict';

  const capabilityRegistry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('capabilityRegistry')
    || root?.ChatUICapabilityRegistry
    || (typeof require === 'function' ? require('./capability-registry') : {});
  const api = factory(capabilityRegistry);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('routeIntent', api);
  if (root) root.ChatUIRouteIntent = api;
  if (root?.window) root.window.ChatUIRouteIntent = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIRouteIntent(capabilityRegistry) {
  'use strict';

  const ROUTE_INTENT_VERSION = 'route_intent.v2';
  const LEGACY_ROUTE_INTENT_VERSION = 'route_intent.v1';
  const VALID_RELATIONS = new Set(['new', 'followup', 'continuation']);
  const VALID_RESOURCE_ROLES = new Set([
    'target', 'reference', 'style_reference', 'mask',
    'source', 'attachment', 'context', 'compare_a', 'compare_b',
  ]);
  // route_intent.v2 is the live model protocol. All five fields are mandatory;
  // task_shape is no longer inferred by the parser. Historical four-field v1
  // values can be migrated only through the explicit adapter below, never by
  // the live response parser.
  const LEGACY_ROUTE_INTENT_FIELDS = Object.freeze(['operation', 'relation', 'goal', 'resource_refs']);
  const ROUTE_INTENT_TASK_SHAPE_FIELD = 'task_shape';
  const ROUTE_INTENT_TASK_SHAPES = new Set(['single', 'multi']);
  const ROUTE_INTENT_FIELDS = Object.freeze([...LEGACY_ROUTE_INTENT_FIELDS, ROUTE_INTENT_TASK_SHAPE_FIELD]);
  const RESOURCE_REF_FIELDS = Object.freeze(['candidate_key', 'role']);
  const ROUTE_INTENT_MAX_RESOURCE_REFS = 16;
  const ROUTE_INTENT_MAX_GOAL_LENGTH = 1000;

  const ROUTE_INTENT_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_route_intent_v2',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [...ROUTE_INTENT_FIELDS],
        properties: {
          operation: {
            type: 'string',
            enum: [
              'plain_chat', 'web_search', 'file_qa', 'multimodal_qa', 'image_qa',
              'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image',
            ],
          },
          relation: {
            type: 'string',
            enum: [...VALID_RELATIONS],
          },
          goal: {
            type: 'string',
            minLength: 1,
            maxLength: ROUTE_INTENT_MAX_GOAL_LENGTH,
          },
          task_shape: { type: 'string', enum: [...ROUTE_INTENT_TASK_SHAPES] },
          resource_refs: {
            type: 'array',
            maxItems: ROUTE_INTENT_MAX_RESOURCE_REFS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [...RESOURCE_REF_FIELDS],
              properties: {
                candidate_key: {
                  type: 'string',
                  pattern: '^[ifm][1-9]\\d*$',
                },
                role: {
                  type: 'string',
                  enum: [...VALID_RESOURCE_ROLES],
                },
              },
            },
          },
        },
      },
    },
  });

  function routeIntentResponseFormatForCandidates(candidates = [], options = {}) {
    const candidateKeys = [];
    const seen = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const candidateKey = stringValue(
        candidate && typeof candidate === 'object' ? candidate.candidate_key : candidate,
      );
      if (!/^[ifm][1-9]\d*$/.test(candidateKey) || seen.has(candidateKey)) continue;
      seen.add(candidateKey);
      candidateKeys.push(candidateKey);
    }

    const responseFormat = JSON.parse(JSON.stringify(ROUTE_INTENT_RESPONSE_FORMAT));
    const schema = responseFormat.json_schema.schema;
    const allowedRelations = [...new Set((Array.isArray(options.allowedRelations) ? options.allowedRelations : [])
      .map(stringValue)
      .filter(relation => VALID_RELATIONS.has(relation)))];
    if (allowedRelations.length) schema.properties.relation.enum = allowedRelations;
    const allowedGoals = [...new Set((Array.isArray(options.allowedGoals) ? options.allowedGoals : [])
      .map(stringValue)
      .filter(goal => goal.length >= 1 && goal.length <= ROUTE_INTENT_MAX_GOAL_LENGTH))];
    if (allowedGoals.length) schema.properties.goal.enum = allowedGoals;
    const resourceRefs = schema.properties.resource_refs;
    if (!candidateKeys.length) {
      resourceRefs.maxItems = 0;
    } else {
      resourceRefs.items.properties.candidate_key.enum = candidateKeys;
    }
    return Object.freeze(responseFormat);
  }
  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }

  function validResourceRef(ref = {}) {
    return hasOnlyFields(ref, RESOURCE_REF_FIELDS)
      && /^[ifm][1-9]\d*$/.test(stringValue(ref.candidate_key))
      && VALID_RESOURCE_ROLES.has(stringValue(ref.role));
  }

  function hasValidCoreFields(value = {}) {
    return !!capabilityRegistry.capabilityFor?.(value.operation)
      && VALID_RELATIONS.has(value.relation)
      && stringValue(value.goal).length >= 1
      && stringValue(value.goal).length <= ROUTE_INTENT_MAX_GOAL_LENGTH
      && Array.isArray(value.resource_refs)
      && value.resource_refs.length <= ROUTE_INTENT_MAX_RESOURCE_REFS
      && value.resource_refs.every(validResourceRef)
      && new Set(value.resource_refs.map(ref => `${ref.candidate_key}|${ref.role}`)).size === value.resource_refs.length;
  }

  function routeIntentTaskShape(value = {}) {
    const raw = stringValue(value?.[ROUTE_INTENT_TASK_SHAPE_FIELD]);
    return ROUTE_INTENT_TASK_SHAPES.has(raw) ? raw : '';
  }

  function hasExactRouteIntent(value = {}) {
    return hasOnlyFields(value, ROUTE_INTENT_FIELDS)
      && ROUTE_INTENT_TASK_SHAPES.has(stringValue(value[ROUTE_INTENT_TASK_SHAPE_FIELD]))
      && hasValidCoreFields(value);
  }

  function hasExactLegacyRouteIntentV1(value = {}) {
    return hasOnlyFields(value, LEGACY_ROUTE_INTENT_FIELDS) && hasValidCoreFields(value);
  }

  function adaptLegacyRouteIntentV1(value = {}) {
    if (!hasExactLegacyRouteIntentV1(value)) {
      const error = new TypeError('Invalid route_intent.v1');
      error.code = 'ROUTE_INTENT_V1_INVALID';
      throw error;
    }
    return Object.freeze({ ...value, task_shape: 'single' });
  }

  function assertRouteIntent(value = {}) {
    if (hasExactRouteIntent(value)) return true;
    const error = new TypeError('Invalid route_intent.v2');
    error.code = 'ROUTE_INTENT_INVALID';
    throw error;
  }

  function resourceTypeForCandidateKey(candidateKey = '') {
    const prefix = stringValue(candidateKey).charAt(0);
    return prefix === 'i' ? 'image' : prefix === 'f' ? 'file' : prefix === 'm' ? 'message' : '';
  }

  return Object.freeze({
    ROUTE_INTENT_VERSION,
    LEGACY_ROUTE_INTENT_VERSION,
    ROUTE_INTENT_FIELDS,
    LEGACY_ROUTE_INTENT_FIELDS,
    ROUTE_INTENT_TASK_SHAPE_FIELD,
    ROUTE_INTENT_TASK_SHAPES,
    RESOURCE_REF_FIELDS,
    ROUTE_INTENT_MAX_RESOURCE_REFS,
    ROUTE_INTENT_MAX_GOAL_LENGTH,
    ROUTE_INTENT_RESPONSE_FORMAT,
    routeIntentResponseFormatForCandidates,
    hasExactRouteIntent,
    hasExactLegacyRouteIntentV1,
    adaptLegacyRouteIntentV1,
    assertRouteIntent,
    routeIntentTaskShape,
    resourceTypeForCandidateKey,
  });
});
