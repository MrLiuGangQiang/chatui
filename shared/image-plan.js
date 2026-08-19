(function initChatUIImagePlan(root, factory) {
  'use strict';

  const capabilityRegistry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('capabilityRegistry')
    || root?.ChatUICapabilityRegistry
    || (typeof require === 'function' ? require('./capability-registry') : {});
  const api = factory(capabilityRegistry);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('imagePlan', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIImagePlan(capabilityRegistry) {
  'use strict';

  // image_plan.v1 is the second-stage planning protocol for multi-image
  // generation/edit requests. It never carries executable bindings directly:
  // each task references the same candidate_key/role vocabulary as
  // route_intent.v3, and the local compiler resolves those keys into canonical
  // dispatch_contract.v1 bindings. A one-task plan is legal and lets the
  // planning model collapse an apparent multi-task request back to single.
  const IMAGE_PLAN_VERSION = 'image_plan.v1';
  // Product limit enforced by the compile boundary with a user-facing prompt.
  const IMAGE_PLAN_MAX_TASKS = 5;
  // Structural protocol ceiling: models must never push unbounded task lists
  // through the validator, but slightly-over-limit output is still parseable
  // so the compiler can report the specific over-limit error instead of a
  // generic invalid-protocol message.
  const IMAGE_PLAN_ABSOLUTE_MAX_TASKS = 50;
  const PLAN_FIELDS = Object.freeze(['schema_version', 'tasks']);
  const TASK_FIELDS = Object.freeze([
    'task_type', 'prompt', 'input_images',
    'quality', 'background', 'output_format',
    'label',
  ]);
  const REQUIRED_TASK_FIELDS = Object.freeze(TASK_FIELDS.filter(field => field !== 'label'));
  const INPUT_IMAGE_FIELDS = Object.freeze(['candidate_key', 'role']);
  const VALID_TASK_TYPES = new Set(['generate', 'edit']);
  const VALID_INPUT_ROLES = new Set(['target', 'reference', 'style_reference', 'mask']);

  const IMAGE_QUALITIES = Object.freeze(Array.isArray(capabilityRegistry?.IMAGE_QUALITIES) && capabilityRegistry.IMAGE_QUALITIES.length
    ? capabilityRegistry.IMAGE_QUALITIES
    : ['auto', 'low', 'medium', 'high', 'standard', 'hd']);
  const IMAGE_BACKGROUNDS = Object.freeze(Array.isArray(capabilityRegistry?.IMAGE_BACKGROUNDS) && capabilityRegistry.IMAGE_BACKGROUNDS.length
    ? capabilityRegistry.IMAGE_BACKGROUNDS
    : ['auto', 'transparent', 'opaque']);
  const IMAGE_OUTPUT_FORMATS = Object.freeze(Array.isArray(capabilityRegistry?.IMAGE_OUTPUT_FORMATS) && capabilityRegistry.IMAGE_OUTPUT_FORMATS.length
    ? capabilityRegistry.IMAGE_OUTPUT_FORMATS
    : ['auto', 'png', 'jpeg', 'webp']);

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }

  function hasOnlyAllowedFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.keys(value).every(key => fields.includes(key));
  }

  function validInputImage(ref = {}) {
    return hasOnlyFields(ref, INPUT_IMAGE_FIELDS)
      && /^[ifm][1-9]\d*$/.test(stringValue(ref.candidate_key))
      && VALID_INPUT_ROLES.has(stringValue(ref.role));
  }

  function validTask(task = {}) {
    if (!hasOnlyAllowedFields(task, TASK_FIELDS)
        || !Object.prototype.hasOwnProperty.call(task, 'task_type')
        || !Object.prototype.hasOwnProperty.call(task, 'prompt')
        || !Object.prototype.hasOwnProperty.call(task, 'input_images')) return false;
    const prompt = stringValue(task.prompt);
    if (!VALID_TASK_TYPES.has(stringValue(task.task_type)) || !prompt || prompt.length > 4000) return false;
    if (!Array.isArray(task.input_images) || task.input_images.length > 16 || !task.input_images.every(validInputImage)) return false;
    if (new Set(task.input_images.map(ref => `${ref.candidate_key}|${ref.role}`)).size !== task.input_images.length) return false;
    if (task.quality !== undefined && !IMAGE_QUALITIES.includes(stringValue(task.quality))) return false;
    if (task.background !== undefined && !IMAGE_BACKGROUNDS.includes(stringValue(task.background))) return false;
    if (task.output_format !== undefined && !IMAGE_OUTPUT_FORMATS.includes(stringValue(task.output_format))) return false;
    if (task.label !== undefined) {
      const label = stringValue(task.label);
      if (!label || label.length > 120) return false;
    }
    return true;
  }

  function hasExactImagePlan(value = {}) {
    return hasOnlyFields(value, PLAN_FIELDS)
      && value.schema_version === IMAGE_PLAN_VERSION
      && Array.isArray(value.tasks)
      && value.tasks.length >= 1
      && value.tasks.length <= IMAGE_PLAN_ABSOLUTE_MAX_TASKS
      && value.tasks.every(validTask);
  }

  function assertImagePlan(value = {}) {
    if (hasExactImagePlan(value)) return true;
    const error = new TypeError('Invalid image_plan.v1');
    error.code = 'IMAGE_PLAN_INVALID';
    throw error;
  }

  const IMAGE_PLAN_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_image_plan_v1',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [...PLAN_FIELDS],
        properties: {
          schema_version: { type: 'string', enum: [IMAGE_PLAN_VERSION] },
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: IMAGE_PLAN_ABSOLUTE_MAX_TASKS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [...TASK_FIELDS],
              properties: {
                task_type: { type: 'string', enum: [...VALID_TASK_TYPES] },
                prompt: { type: 'string', minLength: 1, maxLength: 4000 },
                input_images: {
                  type: 'array',
                  maxItems: 16,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: [...INPUT_IMAGE_FIELDS],
                    properties: {
                      candidate_key: { type: 'string', pattern: '^[ifm][1-9]\\d*$' },
                      role: { type: 'string', enum: [...VALID_INPUT_ROLES] },
                    },
                  },
                },
                quality: { type: 'string', enum: [...IMAGE_QUALITIES] },
                background: { type: 'string', enum: [...IMAGE_BACKGROUNDS] },
                output_format: { type: 'string', enum: [...IMAGE_OUTPUT_FORMATS] },
                label: { type: 'string', minLength: 1, maxLength: 120 },
              },
            },
          },
        },
      },
    },
  });

  return Object.freeze({
    IMAGE_PLAN_VERSION,
    IMAGE_PLAN_MAX_TASKS,
    IMAGE_PLAN_ABSOLUTE_MAX_TASKS,
    PLAN_FIELDS,
    TASK_FIELDS,
    REQUIRED_TASK_FIELDS,
    INPUT_IMAGE_FIELDS,
    VALID_TASK_TYPES,
    VALID_INPUT_ROLES,
    IMAGE_PLAN_RESPONSE_FORMAT,
    hasExactImagePlan,
    assertImagePlan,
  });
});
