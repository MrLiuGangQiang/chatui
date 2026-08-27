(function initChatUIMultiTaskPlan(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('multiTaskPlan', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIMultiTaskPlan() {
  'use strict';

  // multi_task_plan.v1 is the second-stage planning protocol for cross-API or
  // non-image multi-intent requests. ChatUI executes one task per turn, so the
  // planner must split the user request into independently executable tasks;
  // the user then chooses one task (or a later turn picks the next one).
  const MULTI_TASK_PLAN_VERSION = 'multi_task_plan.v1';
  const MULTI_TASK_PLAN_MAX_TASKS = 8;
  const PLAN_FIELDS = Object.freeze(['schema_version', 'tasks']);
  const TASK_FIELDS = Object.freeze(['key', 'operation', 'description', 'goal', 'resource_refs']);
  const VALID_OPERATIONS = new Set([
    'plain_chat', 'web_search', 'file_qa', 'image_qa', 'image_compare',
    'ocr', 'multimodal_qa', 'text_to_image', 'image_reference_gen', 'edit_image',
  ]);
  const VALID_ROLES = new Set([
    'target', 'reference', 'style_reference', 'mask', 'source', 'attachment',
    'context', 'compare_a', 'compare_b',
  ]);

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.keys(value).every(field => fields.includes(field));
  }

  function validResourceRef(ref = {}) {
    return hasOnlyFields(ref, ['candidate_key', 'role'])
      && /^[ifm][1-9]\d*$/.test(stringValue(ref.candidate_key))
      && VALID_ROLES.has(stringValue(ref.role));
  }

  function validTask(task = {}) {
    if (!hasOnlyFields(task, TASK_FIELDS)) return false;
    const key = stringValue(task.key);
    const operation = stringValue(task.operation);
    const description = stringValue(task.description);
    const goal = stringValue(task.goal);
    if (!/^t[1-9]\d*$/.test(key)) return false;
    if (!VALID_OPERATIONS.has(operation)) return false;
    if (!description || description.length > 120) return false;
    if (!goal || goal.length > 4000) return false;
    if (!Array.isArray(task.resource_refs) || task.resource_refs.length > 16) return false;
    return task.resource_refs.every(validResourceRef);
  }

  function hasExactMultiTaskPlan(value = {}) {
    return hasOnlyFields(value, PLAN_FIELDS)
      && value.schema_version === MULTI_TASK_PLAN_VERSION
      && Array.isArray(value.tasks)
      && value.tasks.length >= 2
      && value.tasks.length <= MULTI_TASK_PLAN_MAX_TASKS
      && value.tasks.every(validTask)
      && new Set(value.tasks.map(task => stringValue(task.key))).size === value.tasks.length;
  }

  function assertMultiTaskPlan(value = {}) {
    if (hasExactMultiTaskPlan(value)) return true;
    const error = new TypeError('Invalid multi_task_plan.v1');
    error.code = 'MULTI_TASK_PLAN_INVALID';
    throw error;
  }

  const MULTI_TASK_PLAN_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_multi_task_plan_v1',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [...PLAN_FIELDS],
        properties: {
          schema_version: { type: 'string', enum: [MULTI_TASK_PLAN_VERSION] },
          tasks: {
            type: 'array',
            minItems: 2,
            maxItems: MULTI_TASK_PLAN_MAX_TASKS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: TASK_FIELDS,
              properties: {
                key: { type: 'string', pattern: '^t[1-9]\\d*$' },
                operation: { type: 'string', enum: [...VALID_OPERATIONS] },
                description: { type: 'string', minLength: 1, maxLength: 120 },
                goal: { type: 'string', minLength: 1, maxLength: 4000 },
                resource_refs: {
                  type: 'array',
                  maxItems: 16,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['candidate_key', 'role'],
                    properties: {
                      candidate_key: { type: 'string', pattern: '^[ifm][1-9]\\d*$' },
                      role: { type: 'string', enum: [...VALID_ROLES] },
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

  return Object.freeze({
    MULTI_TASK_PLAN_VERSION,
    MULTI_TASK_PLAN_MAX_TASKS,
    MULTI_TASK_PLAN_RESPONSE_FORMAT,
    hasExactMultiTaskPlan,
    assertMultiTaskPlan,
  });
});
