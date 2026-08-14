(function initChatUIImageBatchExecution(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('imageBatchExecution', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIImageBatchExecution() {
  'use strict';

  // image_batch_execution.v1 is the browser -> ChatUI server fan-out contract.
  // The browser submits the whole compiled batch once; the server materializes
  // one parent job plus one managed child image job per task and fans out to
  // the upstream provider itself. Every child still carries its own validated
  // dispatch_contract.v1 and binding evidence.
  const IMAGE_BATCH_EXECUTION_VERSION = 'image_batch_execution.v1';
  const IMAGE_BATCH_MAX_TASKS = 5;
  const IMAGE_BATCH_ABSOLUTE_MAX_TASKS = 50;
  const BATCH_FIELDS = Object.freeze(['schema_version', 'batchId', 'submissionId', 'tasks']);
  const TASK_FIELDS = Object.freeze([
    'jobId', 'requestPurpose', 'mode', 'payload', 'dispatchContract',
    'bindingEvidence', 'files', 'masks',
  ]);
  const VALID_TASK_MODES = new Set(['image', 'edit_image']);
  const VALID_REQUEST_PURPOSES = new Set(['final_execution']);

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }

  function validBatchId(value) {
    const id = stringValue(value);
    return !id || /^imgbatch-[a-z0-9-]{8,80}$/i.test(id);
  }

  function validChildJobId(value) {
    const id = stringValue(value);
    return !id || /^imgjob-[a-z0-9-]{8,80}$/i.test(id);
  }

  function validTask(task = {}) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
    const fields = Object.keys(task);
    if (!fields.every(field => TASK_FIELDS.includes(field))) return false;
    if (!validChildJobId(task.jobId)) return false;
    if (!VALID_REQUEST_PURPOSES.has(stringValue(task.requestPurpose))) return false;
    if (!VALID_TASK_MODES.has(stringValue(task.mode))) return false;
    if (!task.payload || typeof task.payload !== 'object' || Array.isArray(task.payload)) return false;
    if (!task.dispatchContract || typeof task.dispatchContract !== 'object' || Array.isArray(task.dispatchContract)) return false;
    if (!Array.isArray(task.bindingEvidence)) return false;
    if (!Array.isArray(task.files)) return false;
    if (!Array.isArray(task.masks)) return false;
    return true;
  }

  function hasExactImageBatchExecution(value = {}) {
    return !!value
      && typeof value === 'object'
      && !Array.isArray(value)
      && hasOnlyFields(value, BATCH_FIELDS)
      && value.schema_version === IMAGE_BATCH_EXECUTION_VERSION
      && validBatchId(value.batchId)
      && typeof value.submissionId === 'string'
      && Array.isArray(value.tasks)
      && value.tasks.length >= 1
      && value.tasks.length <= IMAGE_BATCH_ABSOLUTE_MAX_TASKS
      && value.tasks.every(validTask);
  }

  function imageBatchExecutionError(message) {
    const error = new TypeError(message);
    error.code = 'IMAGE_BATCH_EXECUTION_INVALID';
    error.statusCode = 400;
    return error;
  }

  function assertImageBatchExecution(value = {}) {
    if (!hasExactImageBatchExecution(value)) {
      throw imageBatchExecutionError('Invalid image_batch_execution.v1');
    }
    if (value.tasks.length > IMAGE_BATCH_MAX_TASKS) {
      const error = imageBatchExecutionError(`多图任务最多支持 ${IMAGE_BATCH_MAX_TASKS} 个子任务`);
      error.code = 'IMAGE_BATCH_TOO_MANY_TASKS';
      throw error;
    }
    return value;
  }

  function normalizeImageBatchExecution(value = {}) {
    assertImageBatchExecution(value);
    return {
      schema_version: IMAGE_BATCH_EXECUTION_VERSION,
      batchId: stringValue(value.batchId),
      submissionId: stringValue(value.submissionId),
      tasks: value.tasks.map(task => ({
        jobId: stringValue(task.jobId),
        requestPurpose: stringValue(task.requestPurpose),
        mode: stringValue(task.mode),
        payload: { ...task.payload },
        dispatchContract: { ...task.dispatchContract },
        bindingEvidence: task.bindingEvidence.map(item => ({ ...item })),
        files: task.files.map(item => ({ ...item })),
        masks: task.masks.map(item => ({ ...item })),
      })),
    };
  }

  // Idempotency identity is derived from the execution plans only. Client job
  // ids are ownership/recovery identifiers and must not change whether a
  // repeated batch submission is recognized as the same execution.
  function imageBatchIdempotencyPlan(batch = {}) {
    assertImageBatchExecution(batch);
    return {
      schema_version: IMAGE_BATCH_EXECUTION_VERSION,
      plans: batch.tasks.map(task => task.dispatchContract),
    };
  }

  return Object.freeze({
    IMAGE_BATCH_EXECUTION_VERSION,
    IMAGE_BATCH_MAX_TASKS,
    IMAGE_BATCH_ABSOLUTE_MAX_TASKS,
    BATCH_FIELDS,
    TASK_FIELDS,
    VALID_TASK_MODES,
    VALID_REQUEST_PURPOSES,
    hasExactImageBatchExecution,
    assertImageBatchExecution,
    normalizeImageBatchExecution,
    imageBatchIdempotencyPlan,
  });
});
