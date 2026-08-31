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

  const ROUTE_INTENT_VERSION = 'route_intent.v3';
  const LEGACY_ROUTE_INTENT_VERSION = 'route_intent.v2';
  const OLDEST_ROUTE_INTENT_VERSION = 'route_intent.v1';
  const VALID_RELATIONS = new Set(['new', 'followup', 'continuation']);
  const ROUTE_INTENT_GOAL_MODES = new Set(['replace', 'amend']);
  const VALID_RESOURCE_ROLES = new Set([
    'target', 'reference', 'style_reference', 'mask',
    'source', 'attachment', 'context', 'compare_a', 'compare_b',
  ]);
  // route_intent.v3 separates task continuity from resource continuity.
  // relation describes discourse/execution dependency, goal_mode describes
  // whether the current goal replaces or amends the previous task state, and
  // resource_refs independently selects concrete images/files/messages.
  const ROUTE_INTENT_V1_FIELDS = Object.freeze(['operation', 'relation', 'goal', 'resource_refs']);
  const ROUTE_INTENT_TASK_SHAPE_FIELD = 'task_shape';
  const ROUTE_INTENT_GOAL_MODE_FIELD = 'goal_mode';
  const ROUTE_INTENT_TASK_SHAPES = new Set(['single', 'multi']);
  const ROUTE_INTENT_V2_FIELDS = Object.freeze([...ROUTE_INTENT_V1_FIELDS, ROUTE_INTENT_TASK_SHAPE_FIELD]);
  const ROUTE_INTENT_FIELDS = Object.freeze([
    'operation', 'relation', 'goal', ROUTE_INTENT_GOAL_MODE_FIELD, 'resource_refs', ROUTE_INTENT_TASK_SHAPE_FIELD,
  ]);
  const LEGACY_ROUTE_INTENT_FIELDS = ROUTE_INTENT_V1_FIELDS;
  const RESOURCE_REF_FIELDS = Object.freeze(['candidate_key', 'role']);
  const ROUTE_INTENT_MAX_RESOURCE_REFS = 16;
  const ROUTE_INTENT_MAX_GOAL_LENGTH = 1000;

  const ROUTE_INTENT_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_route_intent_v3',
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
          goal_mode: { type: 'string', enum: [...ROUTE_INTENT_GOAL_MODES] },
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
          task_shape: { type: 'string', enum: [...ROUTE_INTENT_TASK_SHAPES] },
        },
      },
    },
  });

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

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
    const allowedOperations = [...new Set((Array.isArray(options.allowedOperations) ? options.allowedOperations : [])
      .map(stringValue)
      .filter(operation => [
        'plain_chat', 'web_search', 'file_qa', 'multimodal_qa', 'image_qa',
        'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image',
      ].includes(operation)))];
    if (allowedOperations.length) schema.properties.operation.enum = allowedOperations;
    // The current input is deliberately NOT emitted as a goal enum literal:
    // strict structured-output gateways reject long user-derived string
    // literals inside the schema. Goal non-emptiness, the length cap, and the
    // exact-input goal rule are all enforced by the local route-intent
    // validator and the compile boundary, so the wire schema keeps goal as a
    // plain string.
    const allowedGoalModes = [...new Set((Array.isArray(options.allowedGoalModes) ? options.allowedGoalModes : [])
      .map(stringValue)
      .filter(goalMode => ROUTE_INTENT_GOAL_MODES.has(goalMode)))];
    if (allowedGoalModes.length) schema.properties.goal_mode.enum = allowedGoalModes;
    const resourceRefs = schema.properties.resource_refs;
    const requestedResourceKeys = Array.isArray(options.allowedResourceKeys)
      ? [...new Set(options.allowedResourceKeys.map(stringValue).filter(key => candidateKeys.includes(key)))]
      : null;
    const effectiveResourceKeys = requestedResourceKeys || candidateKeys;
    if (!effectiveResourceKeys.length) {
      resourceRefs.maxItems = 0;
    } else {
      resourceRefs.items.properties.candidate_key.enum = effectiveResourceKeys;
    }
    return Object.freeze(responseFormat);
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

  function routeIntentGoalMode(value = {}) {
    const raw = stringValue(value?.[ROUTE_INTENT_GOAL_MODE_FIELD]);
    return ROUTE_INTENT_GOAL_MODES.has(raw) ? raw : '';
  }

  function hasExactRouteIntent(value = {}) {
    return hasOnlyFields(value, ROUTE_INTENT_FIELDS)
      && ROUTE_INTENT_TASK_SHAPES.has(stringValue(value[ROUTE_INTENT_TASK_SHAPE_FIELD]))
      && ROUTE_INTENT_GOAL_MODES.has(stringValue(value[ROUTE_INTENT_GOAL_MODE_FIELD]))
      && hasValidCoreFields(value);
  }

  function hasExactLegacyRouteIntentV2(value = {}) {
    return hasOnlyFields(value, ROUTE_INTENT_V2_FIELDS)
      && ROUTE_INTENT_TASK_SHAPES.has(stringValue(value[ROUTE_INTENT_TASK_SHAPE_FIELD]))
      && hasValidCoreFields(value);
  }

  function adaptLegacyRouteIntentV2(value = {}, options = {}) {
    if (!hasExactLegacyRouteIntentV2(value)) {
      const error = new TypeError('Invalid route_intent.v2');
      error.code = 'ROUTE_INTENT_V2_INVALID';
      throw error;
    }
    const goalMode = options.hasPreviousTaskState === true
      && ['text_to_image', 'edit_image'].includes(stringValue(value.operation))
      && ['followup', 'continuation'].includes(stringValue(value.relation))
      ? 'amend'
      : 'replace';
    return Object.freeze({ ...value, goal_mode: goalMode });
  }

  function hasExactLegacyRouteIntentV1(value = {}) {
    return hasOnlyFields(value, ROUTE_INTENT_V1_FIELDS) && hasValidCoreFields(value);
  }

  function adaptLegacyRouteIntentV1(value = {}) {
    if (!hasExactLegacyRouteIntentV1(value)) {
      const error = new TypeError('Invalid route_intent.v1');
      error.code = 'ROUTE_INTENT_V1_INVALID';
      throw error;
    }
    return Object.freeze({ ...value, goal_mode: 'replace', task_shape: 'single' });
  }

  function assertRouteIntent(value = {}) {
    if (hasExactRouteIntent(value)) return true;
    const error = new TypeError('Invalid route_intent.v3');
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
    OLDEST_ROUTE_INTENT_VERSION,
    ROUTE_INTENT_FIELDS,
    ROUTE_INTENT_V2_FIELDS,
    ROUTE_INTENT_V1_FIELDS,
    LEGACY_ROUTE_INTENT_FIELDS,
    ROUTE_INTENT_TASK_SHAPE_FIELD,
    ROUTE_INTENT_TASK_SHAPES,
    ROUTE_INTENT_GOAL_MODE_FIELD,
    ROUTE_INTENT_GOAL_MODES,
    RESOURCE_REF_FIELDS,
    ROUTE_INTENT_MAX_RESOURCE_REFS,
    ROUTE_INTENT_MAX_GOAL_LENGTH,
    ROUTE_INTENT_RESPONSE_FORMAT,
    routeIntentResponseFormatForCandidates,
    hasExactRouteIntent,
    hasExactLegacyRouteIntentV2,
    adaptLegacyRouteIntentV2,
    hasExactLegacyRouteIntentV1,
    adaptLegacyRouteIntentV1,
    assertRouteIntent,
    routeIntentTaskShape,
    routeIntentGoalMode,
    resourceTypeForCandidateKey,
  });
});
