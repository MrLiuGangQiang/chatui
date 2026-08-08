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

  const ROUTE_INTENT_VERSION = 'route_intent.v1';
  const VALID_RELATIONS = new Set(['new', 'followup', 'correction', 'continuation']);
  const VALID_RESOURCE_ROLES = new Set([
    'target', 'reference', 'style_reference', 'mask',
    'source', 'attachment', 'context', 'compare_a', 'compare_b',
  ]);
  // The protocol version is carried by the schema name, not repeated in every
  // model response. The wire object stays limited to four intent fields.
  const ROUTE_INTENT_FIELDS = Object.freeze(['operation', 'relation', 'goal', 'resource_refs']);
  const RESOURCE_REF_FIELDS = Object.freeze(['candidate_key', 'role']);

  const ROUTE_INTENT_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_route_intent_v1',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [...ROUTE_INTENT_FIELDS],
        properties: {
          operation: {
            type: 'string',
            enum: [
              'plain_chat', 'file_qa', 'multimodal_qa', 'image_qa',
              'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image',
            ],
          },
          relation: { type: 'string', enum: [...VALID_RELATIONS] },
          goal: { type: 'string', minLength: 1, maxLength: 600 },
          resource_refs: {
            type: 'array',
            maxItems: 16,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [...RESOURCE_REF_FIELDS],
              properties: {
                candidate_key: { type: 'string', pattern: '^[ifm][1-9]\\d*$' },
                role: { type: 'string', enum: [...VALID_RESOURCE_ROLES] },
              },
            },
          },
        },
      },
    },
  });

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

  function hasExactRouteIntent(value = {}) {
    return hasOnlyFields(value, ROUTE_INTENT_FIELDS)
      && !!capabilityRegistry.capabilityFor?.(value.operation)
      && VALID_RELATIONS.has(value.relation)
      && stringValue(value.goal).length >= 1
      && stringValue(value.goal).length <= 600
      && Array.isArray(value.resource_refs)
      && value.resource_refs.length <= 16
      && value.resource_refs.every(validResourceRef)
      && new Set(value.resource_refs.map(ref => `${ref.candidate_key}|${ref.role}`)).size === value.resource_refs.length;
  }

  function assertRouteIntent(value = {}) {
    if (hasExactRouteIntent(value)) return true;
    const error = new TypeError('Invalid route_intent.v1');
    error.code = 'ROUTE_INTENT_INVALID';
    throw error;
  }

  function resourceTypeForCandidateKey(candidateKey = '') {
    const prefix = stringValue(candidateKey).charAt(0);
    return prefix === 'i' ? 'image' : prefix === 'f' ? 'file' : prefix === 'm' ? 'message' : '';
  }

  return Object.freeze({
    ROUTE_INTENT_VERSION,
    ROUTE_INTENT_FIELDS,
    RESOURCE_REF_FIELDS,
    ROUTE_INTENT_RESPONSE_FORMAT,
    hasExactRouteIntent,
    assertRouteIntent,
    resourceTypeForCandidateKey,
  });
});
