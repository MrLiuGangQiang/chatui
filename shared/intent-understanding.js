(function initChatUIIntentUnderstanding(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('intentUnderstanding', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIIntentUnderstanding() {
  'use strict';

  // understanding.v1 is the first thinking node of the intent pipeline. It only
  // extracts what the user asked for and what "this/那个/第2张" refers to. It
  // never maps to an operation; the deterministic Shape Compiler below derives
  // operation/task_shape/required roles from the closed kind enum.

  const UNDERSTANDING_VERSION = 'intent_understanding.v1';
  const ACTION_KINDS = Object.freeze({
    plain_text: 'plain_chat',
    web_search: 'web_search',
    file_read: 'file_qa',
    image_read: 'image_qa',
    ocr: 'ocr',
    image_compare: 'image_compare',
    multimodal_qa: 'multimodal_qa',
    image_generate: 'text_to_image',
    image_reference: 'image_reference_gen',
    image_edit: 'edit_image',
  });

  // kind -> required resource roles (type -> allowed roles). Text/image binding
  // stays deterministic; the model only names the candidate, never the role.
  const KIND_RESOURCE_ROLES = Object.freeze({
    plain_text: Object.freeze({ message: Object.freeze(['context']) }),
    web_search: Object.freeze({ message: Object.freeze(['context']) }),
    file_read: Object.freeze({ file: Object.freeze(['attachment']) }),
    image_read: Object.freeze({ image: Object.freeze(['source']) }),
    ocr: Object.freeze({ image: Object.freeze(['source']) }),
    image_compare: Object.freeze({ image: Object.freeze(['compare_a', 'compare_b']) }),
    multimodal_qa: Object.freeze({ image: Object.freeze(['source']), file: Object.freeze(['attachment']) }),
    image_generate: Object.freeze({}),
    image_reference: Object.freeze({ image: Object.freeze(['reference', 'style_reference']) }),
    image_edit: Object.freeze({ image: Object.freeze(['target']) }),
  });

  // Multiple actions that can be answered in one dispatch.
  const AGGREGATABLE_SINGLE_KINDS = new Set(['image_read', 'ocr', 'file_read']);
  // Multiple actions that always stay on the image_plan path.
  const IMAGE_MULTI_KINDS = new Set(['image_generate', 'image_reference', 'image_edit']);
  const ACTION_FIELDS = Object.freeze(['index', 'kind', 'verb', 'target', 'resolved_refs']);

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function validResolvedRef(ref = {}) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;
    return /^(?:[ifm])?[1-9]\d*$/.test(stringValue(ref.candidate_key))
      && typeof ref.text === 'string';
  }

  function validAction(action = {}) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
    if (!Number.isInteger(Number(action.index)) || Number(action.index) < 1) return false;
    if (!Object.prototype.hasOwnProperty.call(ACTION_KINDS, stringValue(action.kind))) return false;
    if (typeof action.target !== 'string') return false;
    const refs = Array.isArray(action.resolved_refs) ? action.resolved_refs : [];
    return refs.every(validResolvedRef);
  }

  function hasExactUnderstanding(value = {}) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
      && value.schema_version === UNDERSTANDING_VERSION
      && Array.isArray(value.actions)
      && value.actions.length <= 20
      && value.actions.every(validAction);
  }

  function assertUnderstanding(value = {}) {
    if (hasExactUnderstanding(value)) return true;
    const error = new TypeError('Invalid intent_understanding.v1');
    error.code = 'INTENT_UNDERSTANDING_INVALID';
    throw error;
  }

  function normalizeAction(action = {}) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
    const kind = stringValue(action.kind);
    if (!Object.prototype.hasOwnProperty.call(ACTION_KINDS, kind)) return null;
    return {
      index: Number(action.index) || 0,
      kind,
      verb: stringValue(action.verb),
      target: stringValue(action.target),
      resolved_refs: Array.isArray(action.resolved_refs)
        ? action.resolved_refs.map(ref => ({ candidate_key: stringValue(ref?.candidate_key), text: stringValue(ref?.text) }))
        : [],
    };
  }

  function operationForKind(kind = '') {
    return ACTION_KINDS[stringValue(kind)] || '';
  }

  function requiredResourceRoles(kind = '') {
    return KIND_RESOURCE_ROLES[stringValue(kind)] || Object.freeze({});
  }

  // Deterministic Shape Compiler: derive operation / task_shape / branch from
  // the extracted actions. The route model never decides task_shape again.
  function compileUnderstandingShape(actions = []) {
    const normalized = (Array.isArray(actions) ? actions : []).map(normalizeAction).filter(Boolean);
    if (!normalized.length) {
      return Object.freeze({ taskShape: 'none', operation: '', branch: 'clarification' });
    }
    if (normalized.length === 1) {
      const kind = normalized[0].kind;
      return Object.freeze({
        taskShape: 'single',
        operation: operationForKind(kind),
        requiredRoles: requiredResourceRoles(kind),
        branch: 'route',
        actions: normalized,
      });
    }
    const kinds = new Set(normalized.map(action => action.kind));
    if (kinds.size === 1 && AGGREGATABLE_SINGLE_KINDS.has(normalized[0].kind)) {
      return Object.freeze({
        taskShape: 'single',
        operation: operationForKind(normalized[0].kind),
        requiredRoles: requiredResourceRoles(normalized[0].kind),
        branch: 'route',
        aggregate: true,
        actions: normalized,
      });
    }
    const allImage = normalized.every(action => IMAGE_MULTI_KINDS.has(action.kind));
    if (allImage) {
      return Object.freeze({
        taskShape: 'multi',
        operation: operationForKind(normalized[0].kind),
        requiredRoles: requiredResourceRoles(normalized[0].kind),
        branch: 'image_plan',
        actions: normalized,
      });
    }
    return Object.freeze({
      taskShape: 'multi',
      operation: operationForKind(normalized[0].kind),
      requiredRoles: requiredResourceRoles(normalized[0].kind),
      branch: 'multi_task_plan',
      actions: normalized,
    });
  }

  // Expected task projections used by the planner's 1:1 faithfulness check.
  function expectedPlanTasks(actions = []) {
    return (Array.isArray(actions) ? actions : []).map((action, index) => {
      const kind = stringValue(action?.kind);
      return {
        index: index + 1,
        kind,
        operation: operationForKind(kind),
        resource_roles: requiredResourceRoles(kind),
      };
    });
  }

  const UNDERSTANDING_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_intent_understanding_v1',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['schema_version', 'actions'],
        properties: {
          schema_version: { type: 'string', const: UNDERSTANDING_VERSION },
          ordering: { type: 'string', enum: ['sequential', 'independent'] },
          dependency: { type: 'string', enum: ['new', 'followup', 'continuation'] },
          actions: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['index', 'kind', 'target', 'resolved_refs'],
              properties: {
                index: { type: 'integer', minimum: 1 },
                kind: { type: 'string', enum: Object.keys(ACTION_KINDS) },
                verb: { type: 'string' },
                target: { type: 'string' },
                resolved_refs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['candidate_key', 'text'],
                    properties: {
                      candidate_key: { type: 'string' },
                      text: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  // 1:1 planner faithfulness: every extracted action must be covered by exactly
  // one plan task with the matching operation, and the planner must not invent
  // extra tasks. Roles are intentionally not compared here: role canonicalization
  // happens later in the deterministic compiler.
  function planCoversExpected(plan = {}, expectedTasks = []) {
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const expected = Array.isArray(expectedTasks) ? expectedTasks : [];
    if (!tasks.length || tasks.length !== expected.length) return false;
    const operations = list => list.map(item => stringValue(item?.operation)).sort();
    return JSON.stringify(operations(tasks)) === JSON.stringify(operations(expected));
  }

  return Object.freeze({
    UNDERSTANDING_VERSION,
    planCoversExpected,
    UNDERSTANDING_RESPONSE_FORMAT,
    ACTION_KINDS,
    KIND_RESOURCE_ROLES,
    AGGREGATABLE_SINGLE_KINDS,
    IMAGE_MULTI_KINDS,
    hasExactUnderstanding,
    assertUnderstanding,
    normalizeAction,
    operationForKind,
    requiredResourceRoles,
    compileUnderstandingShape,
    expectedPlanTasks,
  });
});
