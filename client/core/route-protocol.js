(function initChatUIRouteProtocol(root) {
  'use strict';

  const SCHEMA_VERSION = 'task_contract.v5';
  const ROUTE_DECISION_VERSION = 'route_decision.v1';
  const SEMANTIC_TASK_VERSION = 'semantic_task.v2';
  const VALID_RELATIONS = new Set(['new', 'followup', 'correction', 'continuation']);
  const VALID_OPERATIONS = new Set([
    'plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr',
    'text_to_image', 'image_reference_gen', 'edit_image',
  ]);
  const VALID_READINESS = new Set(['ready', 'needs_clarification']);
  const VALID_RESOURCE_TYPES = new Set(['image', 'file', 'text', 'message']);
  const VALID_RESOURCE_SOURCES = new Set(['current', 'quoted', 'history', 'context']);
  const VALID_RESOURCE_ROLES = new Set([
    'source', 'target', 'reference', 'style_reference', 'mask',
    'compare_a', 'compare_b', 'attachment', 'context',
  ]);
  const VALID_PATCH_OPERATIONS = new Set(['preserve', 'add', 'replace', 'remove']);
  const VALID_UNRESOLVED_REASONS = new Set(['missing', 'ambiguous', 'unavailable']);

  // semantic_task.v2 contains only model-observed facts. Product operations,
  // readiness, clarification text and task_contract fields are derived locally.
  const SEMANTIC_ACTIONS = new Set(['respond', 'extract_text', 'compare', 'generate', 'edit']);
  const SEMANTIC_DISCOURSES = new Set(['independent', 'followup', 'correction', 'continuation']);
  const SEMANTIC_PENDING_EFFECTS = new Set([
    'none', 'answer', 'partial', 'revision', 'continuation', 'assistance', 'new_task', 'unclear',
  ]);
  const SEMANTIC_SLOT_PURPOSES = new Set([
    'source', 'target', 'reference', 'style_reference', 'mask',
    'compare_a', 'compare_b', 'attachment', 'context', 'change_value',
  ]);
  const SEMANTIC_SLOT_RESOLUTIONS = new Set(['bound', 'ambiguous', 'missing', 'unavailable']);

  const OPERATIONS_BY_FIXED_MODE = Object.freeze({
    chat: new Set(['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr']),
    image: new Set(['text_to_image', 'image_reference_gen']),
    edit_image: new Set(['edit_image']),
  });

  const api = Object.freeze({
    SCHEMA_VERSION,
    ROUTE_DECISION_VERSION,
    SEMANTIC_TASK_VERSION,
    VALID_RELATIONS,
    VALID_OPERATIONS,
    VALID_READINESS,
    VALID_RESOURCE_TYPES,
    VALID_RESOURCE_SOURCES,
    VALID_RESOURCE_ROLES,
    VALID_PATCH_OPERATIONS,
    VALID_UNRESOLVED_REASONS,
    SEMANTIC_ACTIONS,
    SEMANTIC_DISCOURSES,
    SEMANTIC_PENDING_EFFECTS,
    SEMANTIC_SLOT_PURPOSES,
    SEMANTIC_SLOT_RESOLUTIONS,
    SEMANTIC_TASK_FIELDS: Object.freeze([
      'schema_version', 'actions', 'discourse', 'pending_effect', 'slots', 'changes', 'constraints',
    ]),
    SEMANTIC_SLOT_FIELDS: Object.freeze([
      'kind', 'purpose', 'label', 'resolution', 'candidate_keys',
    ]),
    ROUTE_DECISION_FIELDS: Object.freeze([
      'schema_version', 'readiness', 'operation', 'relation', 'bindings',
      'changes', 'constraints', 'clarification', 'confidence', 'rationale',
    ]),
    OPERATIONS_BY_FIXED_MODE,
    // Protocol-oriented aliases make the service boundary explicit without
    // creating a second set of enum definitions.
    ROUTE_OPERATIONS: VALID_OPERATIONS,
    ROUTE_RELATIONS: VALID_RELATIONS,
    ROUTE_ROLES: VALID_RESOURCE_ROLES,
    ROUTE_RESOURCE_TYPES: VALID_RESOURCE_TYPES,
    ROUTE_RESOURCE_SOURCES: VALID_RESOURCE_SOURCES,
    ROUTE_REASONS: VALID_UNRESOLVED_REASONS,
    ROUTE_CHANGES: VALID_PATCH_OPERATIONS,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeProtocol', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
