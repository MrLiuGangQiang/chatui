(function initChatUITaskContinuity(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('taskContinuity', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUITaskContinuity() {
  'use strict';

  const TASK_CONTINUITY_VERSION = 'task_continuity.v1';
  const GOAL_MODES = new Set(['replace', 'amend']);
  const SEGMENT_KINDS = new Set(['base', 'amendment']);
  const TASK_CONTINUITY_MAX_SEGMENTS = 16;
  const TASK_CONTINUITY_MAX_RENDERED_LENGTH = 16000;
  const IMAGE_TASK_LINEAGE_VERSION = 'image_task_lineage.v1';
  const IMAGE_TASK_LINEAGE_MAX_ENTRIES = 50;
  const STATE_FIELDS = Object.freeze(['schema_version', 'goal_mode', 'segments']);
  const SEGMENT_FIELDS = Object.freeze(['kind', 'text']);
  const IMAGE_TASK_LINEAGE_FIELDS = Object.freeze(['schema_version', 'entries']);
  const IMAGE_TASK_LINEAGE_ENTRY_FIELDS = Object.freeze(['reference_id', 'image_ids', 'task_state']);

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }

  function validSegment(segment = {}, index = 0) {
    if (!hasOnlyFields(segment, SEGMENT_FIELDS)) return false;
    const kind = stringValue(segment.kind);
    const text = stringValue(segment.text);
    if (!SEGMENT_KINDS.has(kind) || !text) return false;
    return index === 0 ? kind === 'base' : kind === 'amendment';
  }

  function renderTaskContinuity(state = {}) {
    if (!hasExactTaskContinuity(state)) {
      const error = new TypeError('Invalid task_continuity.v1');
      error.code = 'TASK_CONTINUITY_INVALID';
      throw error;
    }
    const [base, ...amendments] = state.segments;
    if (!amendments.length) return base.text;
    return [
      `任务基础要求：\n${base.text}`,
      `修订要求（按顺序应用，后者优先）：\n${amendments.map((segment, index) => `${index + 1}. ${segment.text}`).join('\n')}`,
    ].join('\n\n');
  }

  function hasExactTaskContinuity(state = {}) {
    if (!hasOnlyFields(state, STATE_FIELDS)
        || state.schema_version !== TASK_CONTINUITY_VERSION
        || !GOAL_MODES.has(stringValue(state.goal_mode))
        || !Array.isArray(state.segments)
        || state.segments.length < 1
        || state.segments.length > TASK_CONTINUITY_MAX_SEGMENTS
        || !state.segments.every(validSegment)) return false;
    const rendered = state.segments.length === 1
      ? stringValue(state.segments[0].text)
      : [
          `任务基础要求：\n${stringValue(state.segments[0].text)}`,
          `修订要求（按顺序应用，后者优先）：\n${state.segments.slice(1).map((segment, index) => `${index + 1}. ${stringValue(segment.text)}`).join('\n')}`,
        ].join('\n\n');
    return rendered.length <= TASK_CONTINUITY_MAX_RENDERED_LENGTH;
  }

  function freezeTaskContinuity(state = {}) {
    return Object.freeze({
      schema_version: TASK_CONTINUITY_VERSION,
      goal_mode: stringValue(state.goal_mode),
      segments: Object.freeze(state.segments.map(segment => Object.freeze({
        kind: stringValue(segment.kind),
        text: stringValue(segment.text),
      }))),
    });
  }

  function assertTaskContinuity(state = {}) {
    if (hasExactTaskContinuity(state)) return true;
    const error = new TypeError('Invalid task_continuity.v1');
    error.code = 'TASK_CONTINUITY_INVALID';
    throw error;
  }

  function normalizeOptionalTaskContinuity(state = null) {
    if (state === null || state === undefined) return null;
    assertTaskContinuity(state);
    return freezeTaskContinuity(state);
  }

  function hasExactImageTaskLineage(lineage = {}) {
    if (!hasOnlyFields(lineage, IMAGE_TASK_LINEAGE_FIELDS)
        || lineage.schema_version !== IMAGE_TASK_LINEAGE_VERSION
        || !Array.isArray(lineage.entries)
        || lineage.entries.length < 1
        || lineage.entries.length > IMAGE_TASK_LINEAGE_MAX_ENTRIES) return false;
    const references = new Set();
    const imageIds = new Set();
    for (const entry of lineage.entries) {
      if (!hasOnlyFields(entry, IMAGE_TASK_LINEAGE_ENTRY_FIELDS)) return false;
      const referenceId = stringValue(entry.reference_id);
      if (!referenceId || referenceId.length > 256 || references.has(referenceId)) return false;
      references.add(referenceId);
      if (!Array.isArray(entry.image_ids) || !entry.image_ids.length || entry.image_ids.length > 16) return false;
      for (const imageIdValue of entry.image_ids) {
        const imageId = stringValue(imageIdValue);
        if (!imageId || imageId.length > 256 || imageIds.has(imageId)) return false;
        imageIds.add(imageId);
      }
      if (!hasExactTaskContinuity(entry.task_state)) return false;
    }
    return true;
  }

  function assertImageTaskLineage(lineage = {}) {
    if (hasExactImageTaskLineage(lineage)) return true;
    const error = new TypeError('Invalid image_task_lineage.v1');
    error.code = 'IMAGE_TASK_LINEAGE_INVALID';
    throw error;
  }

  function freezeImageTaskLineage(lineage = {}) {
    return Object.freeze({
      schema_version: IMAGE_TASK_LINEAGE_VERSION,
      entries: Object.freeze(lineage.entries.map(entry => Object.freeze({
        reference_id: stringValue(entry.reference_id),
        image_ids: Object.freeze(entry.image_ids.map(stringValue)),
        task_state: normalizeOptionalTaskContinuity(entry.task_state),
      }))),
    });
  }

  function normalizeOptionalImageTaskLineage(lineage = null) {
    if (lineage === null || lineage === undefined) return null;
    assertImageTaskLineage(lineage);
    return freezeImageTaskLineage(lineage);
  }

  function createImageTaskLineage({ referenceId = '', imageIds = [], taskState = null } = {}) {
    const lineage = {
      schema_version: IMAGE_TASK_LINEAGE_VERSION,
      entries: [{
        reference_id: stringValue(referenceId),
        image_ids: [...new Set((Array.isArray(imageIds) ? imageIds : []).map(stringValue).filter(Boolean))],
        task_state: normalizeOptionalTaskContinuity(taskState),
      }],
    };
    assertImageTaskLineage(lineage);
    return freezeImageTaskLineage(lineage);
  }

  function mergeImageTaskLineages(...values) {
    const entries = new Map();
    for (const value of values.flat()) {
      const lineage = normalizeOptionalImageTaskLineage(value);
      if (!lineage) continue;
      for (const entry of lineage.entries) {
        const existing = entries.get(entry.reference_id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
          const error = new TypeError(`Conflicting image task lineage for ${entry.reference_id}`);
          error.code = 'IMAGE_TASK_LINEAGE_CONFLICT';
          throw error;
        }
        if (!existing) entries.set(entry.reference_id, entry);
      }
    }
    if (!entries.size) return null;
    const lineage = { schema_version: IMAGE_TASK_LINEAGE_VERSION, entries: [...entries.values()] };
    assertImageTaskLineage(lineage);
    return freezeImageTaskLineage(lineage);
  }

  function taskContinuityFromImageTaskLineage(lineage = null, selector = {}) {
    const normalized = normalizeOptionalImageTaskLineage(lineage);
    if (!normalized) return null;
    const referenceId = stringValue(selector.reference_id || selector.referenceId);
    const imageId = stringValue(selector.image_id || selector.imageId);
    const entry = referenceId
      ? normalized.entries.find(item => item.reference_id === referenceId)
      : imageId
        ? normalized.entries.find(item => item.image_ids.includes(imageId))
        : normalized.entries.length === 1 ? normalized.entries[0] : null;
    return entry ? normalizeOptionalTaskContinuity(entry.task_state) : null;
  }

  function createReplacementTaskContinuity(goal = '') {
    const text = stringValue(goal);
    const state = {
      schema_version: TASK_CONTINUITY_VERSION,
      goal_mode: 'replace',
      segments: [{ kind: 'base', text }],
    };
    assertTaskContinuity(state);
    return freezeTaskContinuity(state);
  }

  function adaptLegacyResolvedGoal(resolvedGoal = '') {
    const text = stringValue(resolvedGoal);
    if (!text) return null;
    return createReplacementTaskContinuity(text);
  }

  function taskContinuityFromExecution(execution = {}) {
    const hasTaskState = Object.prototype.hasOwnProperty.call(execution || {}, 'task_state')
      || Object.prototype.hasOwnProperty.call(execution || {}, 'taskState');
    const candidate = execution?.task_state ?? execution?.taskState;
    if (hasTaskState && candidate !== null && candidate !== undefined) {
      assertTaskContinuity(candidate);
      return freezeTaskContinuity(candidate);
    }
    return adaptLegacyResolvedGoal(execution?.resolved_goal || execution?.resolvedGoal || execution?.input);
  }

  function transitionTaskContinuity({ goalMode = '', goal = '', previousState = null, previousExecution = null } = {}) {
    const mode = stringValue(goalMode);
    const text = stringValue(goal);
    if (!GOAL_MODES.has(mode)) {
      const error = new TypeError(`Unsupported task goal mode: ${mode || '<missing>'}`);
      error.code = 'TASK_GOAL_MODE_INVALID';
      throw error;
    }
    if (!text) {
      const error = new TypeError('Task goal is required');
      error.code = 'TASK_GOAL_REQUIRED';
      throw error;
    }
    if (mode === 'replace') return createReplacementTaskContinuity(text);

    const hasExplicitPreviousState = previousState !== null && previousState !== undefined;
    const previous = hasExplicitPreviousState
      ? (assertTaskContinuity(previousState), freezeTaskContinuity(previousState))
      : taskContinuityFromExecution(previousExecution || {});
    if (!previous) {
      const error = new TypeError('Amending a task requires a previous task state');
      error.code = 'TASK_CONTINUITY_BASE_REQUIRED';
      throw error;
    }
    const priorSegments = previous.segments.length >= TASK_CONTINUITY_MAX_SEGMENTS
      ? [{ kind: 'base', text: renderTaskContinuity(previous) }]
      : previous.segments.map(segment => ({ ...segment }));
    const state = {
      schema_version: TASK_CONTINUITY_VERSION,
      goal_mode: 'amend',
      segments: [...priorSegments, { kind: 'amendment', text }],
    };
    assertTaskContinuity(state);
    return freezeTaskContinuity(state);
  }

  return Object.freeze({
    TASK_CONTINUITY_VERSION,
    GOAL_MODES,
    SEGMENT_KINDS,
    TASK_CONTINUITY_MAX_SEGMENTS,
    TASK_CONTINUITY_MAX_RENDERED_LENGTH,
    IMAGE_TASK_LINEAGE_VERSION,
    IMAGE_TASK_LINEAGE_MAX_ENTRIES,
    STATE_FIELDS,
    SEGMENT_FIELDS,
    IMAGE_TASK_LINEAGE_FIELDS,
    IMAGE_TASK_LINEAGE_ENTRY_FIELDS,
    hasExactTaskContinuity,
    assertTaskContinuity,
    normalizeOptionalTaskContinuity,
    hasExactImageTaskLineage,
    assertImageTaskLineage,
    normalizeOptionalImageTaskLineage,
    createImageTaskLineage,
    mergeImageTaskLineages,
    taskContinuityFromImageTaskLineage,
    createReplacementTaskContinuity,
    adaptLegacyResolvedGoal,
    taskContinuityFromExecution,
    transitionTaskContinuity,
    renderTaskContinuity,
  });
});
