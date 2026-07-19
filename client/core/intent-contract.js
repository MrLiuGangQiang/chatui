(function initChatUIIntentContract(root) {
  'use strict';

  const SCHEMA_VERSION = 'task_contract.v3';
  const VALID_RELATIONS = new Set(['new', 'followup', 'correction', 'continuation']);
  const VALID_OPERATIONS = new Set(['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image', 'clarify']);
  const VALID_RESOURCE_TYPES = new Set(['image', 'file', 'text', 'message']);
  const VALID_RESOURCE_SOURCES = new Set(['current', 'quoted', 'history', 'context']);
  const VALID_RESOURCE_ROLES = new Set(['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context']);
  const VALID_DIRECTIVE_MODES = new Set(['standalone', 'patch']);
  const VALID_UNMENTIONED_POLICIES = new Set(['preserve', 'allow_change']);
  const VALID_PATCH_OPERATIONS = new Set(['preserve', 'add', 'replace', 'remove']);

  const TOP_LEVEL_FIELDS = ['schema_version', 'operation', 'relation', 'resources', 'directive', 'clarification', 'confidence', 'review_reasons', 'rationale'];
  const RESOURCE_FIELDS = ['key', 'type', 'source', 'role', 'index', 'id', 'reference_id', 'missing'];
  const DIRECTIVE_FIELDS = ['mode', 'base_resource_keys', 'unmentioned_policy', 'operations', 'constraints'];
  const PATCH_OPERATION_FIELDS = ['op', 'target', 'value'];
  const CLARIFICATION_FIELDS = ['question', 'missing_resource_keys'];

  const API_BY_OPERATION = Object.freeze({
    plain_chat: 'chat',
    file_qa: 'chat',
    multimodal_qa: 'chat',
    image_qa: 'vision',
    image_compare: 'vision',
    ocr: 'vision',
    text_to_image: 'image_generation',
    image_reference_gen: 'image_generation',
    edit_image: 'image_edit',
    clarify: 'clarify',
  });

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => keys.includes(field));
  }

  function contractApi(task = {}) {
    return API_BY_OPERATION[task.operation] || '';
  }

  function hasExactContractShape(value = {}) {
    if (!hasOnlyFields(value, TOP_LEVEL_FIELDS)) return false;
    if (value.schema_version !== SCHEMA_VERSION || !VALID_OPERATIONS.has(value.operation) || !VALID_RELATIONS.has(value.relation)) return false;
    if (!Array.isArray(value.resources) || !hasOnlyFields(value.directive, DIRECTIVE_FIELDS) || !hasOnlyFields(value.clarification, CLARIFICATION_FIELDS)) return false;
    if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return false;
    if (!Array.isArray(value.review_reasons) || value.review_reasons.some(reason => typeof reason !== 'string' || !reason.trim())) return false;
    if (typeof value.rationale !== 'string') return false;

    const resourceKeys = new Set();
    for (const resource of value.resources) {
      if (!hasOnlyFields(resource, RESOURCE_FIELDS)) return false;
      if (!/^r\d+$/.test(resource.key) || resourceKeys.has(resource.key)) return false;
      resourceKeys.add(resource.key);
      if (!VALID_RESOURCE_TYPES.has(resource.type) || !VALID_RESOURCE_SOURCES.has(resource.source) || !VALID_RESOURCE_ROLES.has(resource.role)) return false;
      if (!Number.isInteger(resource.index) || resource.index < 1) return false;
      if (typeof resource.id !== 'string' || typeof resource.reference_id !== 'string' || typeof resource.missing !== 'boolean') return false;
      if (value.relation === 'new' && resource.source !== 'current') return false;
    }

    const directive = value.directive;
    if (!VALID_DIRECTIVE_MODES.has(directive.mode) || !VALID_UNMENTIONED_POLICIES.has(directive.unmentioned_policy)) return false;
    if (!Array.isArray(directive.base_resource_keys) || !Array.isArray(directive.operations) || !Array.isArray(directive.constraints)) return false;
    if (directive.base_resource_keys.some(key => typeof key !== 'string' || !resourceKeys.has(key) || value.resources.find(resource => resource.key === key)?.missing)) return false;
    if (new Set(directive.base_resource_keys).size !== directive.base_resource_keys.length) return false;
    if (directive.constraints.some(item => typeof item !== 'string' || !item.trim())) return false;
    if (directive.mode === 'standalone') {
      if (directive.base_resource_keys.length || directive.operations.length || directive.unmentioned_policy !== 'allow_change') return false;
    } else if (!directive.base_resource_keys.length) {
      return false;
    }
    for (const operation of directive.operations) {
      if (!hasOnlyFields(operation, PATCH_OPERATION_FIELDS)) return false;
      if (!VALID_PATCH_OPERATIONS.has(operation.op) || typeof operation.target !== 'string' || !operation.target.trim() || typeof operation.value !== 'string') return false;
      if ((operation.op === 'add' || operation.op === 'replace') && !operation.value.trim()) return false;
      if ((operation.op === 'remove' || operation.op === 'preserve') && operation.value !== '') return false;
    }

    const clarification = value.clarification;
    if (typeof clarification.question !== 'string' || !Array.isArray(clarification.missing_resource_keys)) return false;
    if (clarification.missing_resource_keys.some(key => !resourceKeys.has(key) || !value.resources.find(resource => resource.key === key)?.missing)) return false;
    if (value.operation === 'clarify') {
      if (!clarification.question.trim()) return false;
    } else {
      if (clarification.question || clarification.missing_resource_keys.length || value.resources.some(resource => resource.missing)) return false;
      if (value.relation !== 'new' && directive.mode !== 'patch') return false;
    }

    if (value.operation === 'edit_image') {
      const targets = value.resources.filter(resource => resource.type === 'image' && resource.role === 'target');
      if (directive.mode !== 'patch' || !targets.length || targets.some(resource => !directive.base_resource_keys.includes(resource.key))) return false;
    }
    if (value.operation === 'image_reference_gen') {
      const references = value.resources.filter(resource => resource.type === 'image' && ['reference', 'style_reference'].includes(resource.role));
      if (directive.mode !== 'patch' || !references.length || references.some(resource => !directive.base_resource_keys.includes(resource.key))) return false;
    }
    if (['image_qa', 'image_compare', 'ocr'].includes(value.operation) && !value.resources.some(resource => resource.type === 'image')) return false;
    if (['file_qa', 'multimodal_qa'].includes(value.operation) && !value.resources.some(resource => resource.type === 'file')) return false;
    return true;
  }

  function resourceRefs(task, type, context = {}) {
    const candidates = type === 'image' ? context.image_candidates : context.file_candidates;
    const list = Array.isArray(candidates) ? candidates : [];
    return task.resources.filter(item => item.type === type && !item.missing).map(item => {
      const candidate = list.find(entry => {
        const entryId = type === 'image' ? entry.image_id : entry.file_id;
        if (item.id && entryId === item.id) return true;
        if (type === 'image' && item.reference_id && entry.reference_id === item.reference_id && Number(entry.index) === item.index) return true;
        return Number(entry.index) === item.index && entry.source === item.source;
      }) || {};
      return {
        key: item.key,
        role: item.role,
        image_id: type === 'image' ? item.id || candidate.image_id || '' : '',
        file_id: type === 'file' ? item.id || candidate.file_id || '' : '',
        reference_id: item.reference_id || candidate.reference_id || '',
        index: Number(candidate.source_index) || Number(candidate.index) || item.index,
        target: item.source === 'history' || item.source === 'quoted' ? 'previous' : 'uploaded',
        source: item.source,
        name: candidate.name || '',
      };
    });
  }

  function taskContractToExecutionPlan(task = {}, options = {}) {
    if (!hasExactContractShape(task)) throw new TypeError('A valid task_contract.v3 is required');
    const input = String(options.input || '').trim();
    const imageRefs = resourceRefs(task, 'image', options.context || {});
    const fileRefs = resourceRefs(task, 'file', options.context || {});
    const selectedIndexes = [...new Set([...imageRefs, ...fileRefs].map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1))];
    const api = contractApi(task);
    const common = {
      api,
      relation: task.relation,
      resources: task.resources,
      imageRefs,
      fileRefs,
      operationType: task.operation,
      confidence: task.confidence,
      evidence: task.rationale,
      needClarification: false,
      clarificationQuestion: '',
      selectedIndexes,
      selectedReferenceId: imageRefs.find(ref => ref.reference_id)?.reference_id || '',
      selectedImageIds: imageRefs.map(ref => ref.image_id).filter(Boolean),
      usePreviousImage: false,
      contextualImagePrompt: '',
      editInstruction: '',
    };

    if (task.operation === 'clarify') {
      return { ...common, mode: 'chat', target: 'none', needClarification: true, clarificationQuestion: task.clarification.question, selectedIndexes: [], selectedReferenceId: '', selectedImageIds: [], imageRefs: [], fileRefs: [], intent: 'clarify' };
    }
    if (api === 'image_generation') {
      return { ...common, mode: 'image', target: 'new', contextualImagePrompt: input, intent: task.operation };
    }
    if (api === 'image_edit') {
      const targetResource = task.resources.find(item => item.type === 'image' && item.role === 'target' && !item.missing);
      const target = ['history', 'quoted'].includes(targetResource?.source) ? 'previous' : 'uploaded';
      const targetRefs = imageRefs.filter(ref => ref.role === 'target');
      return {
        ...common,
        mode: 'edit_image',
        target,
        editInstruction: input,
        intent: 'image_edit',
        selectedReferenceId: targetResource?.reference_id || targetRefs.find(ref => ref.reference_id)?.reference_id || '',
        selectedImageIds: targetRefs.map(ref => ref.image_id).filter(Boolean),
        usePreviousImage: target === 'previous',
      };
    }
    return { ...common, mode: 'chat', target: 'none', intent: task.operation };
  }

  function needsIntentReview(task = {}) {
    if (!hasExactContractShape(task)) return false;
    return task.review_reasons.length > 0 || task.confidence < 0.72 || task.operation === 'clarify';
  }

  const api = Object.freeze({
    SCHEMA_VERSION,
    contractApi,
    hasExactContractShape,
    taskContractToExecutionPlan,
    needsIntentReview,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUICoreIntentContract = api;
  if (root?.window) root.window.ChatUICoreIntentContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
