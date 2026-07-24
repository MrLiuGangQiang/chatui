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
  const MEDIA_TYPES = new Set(['image', 'file']);

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

  function resourceList(task = {}, type = '') {
    return (task.resources || []).filter(resource => !type || resource.type === type);
  }

  function hasOnlyResourceTypes(resources = [], types = []) {
    const allowed = new Set(types);
    return resources.every(resource => allowed.has(resource.type));
  }

  function hasOnlyResourceRoles(resources = [], roles = []) {
    const allowed = new Set(roles);
    return resources.every(resource => allowed.has(resource.role));
  }

  function hasExactMissingResourceKeys(task = {}) {
    const declared = task.clarification?.missing_resource_keys || [];
    const actual = (task.resources || []).filter(resource => resource.missing).map(resource => resource.key);
    return new Set(declared).size === declared.length
      && declared.length === actual.length
      && declared.every(key => actual.includes(key));
  }

  function hasOperationResourceShape(task = {}) {
    const resources = task.resources || [];
    const images = resourceList(task, 'image');
    const files = resourceList(task, 'file');
    const directive = task.directive || {};
    const baseKeys = new Set(directive.base_resource_keys || []);

    if (files.some(resource => resource.reference_id)) return false;
    if (task.operation === 'clarify') {
      return hasExactMissingResourceKeys(task)
        && directive.mode === 'standalone'
        && directive.base_resource_keys.length === 0
        && directive.unmentioned_policy === 'allow_change'
        && directive.operations.length === 0;
    }
    if (task.operation === 'plain_chat') {
      // A chat task may carry an explicitly selected historical image as a visual
      // reference (for example, reproducing a webpage style in HTML). It remains
      // a chat task, not an image-generation request.
      return !files.length
        && hasOnlyResourceTypes(resources, ['image', 'text', 'message'])
        && images.every(resource => resource.source !== 'current' && ['reference', 'style_reference'].includes(resource.role));
    }
    if (task.operation === 'text_to_image') {
      return !files.length
        && hasOnlyResourceTypes(resources, ['image'])
        && hasOnlyResourceRoles(images, ['reference'])
        && images.every(resource => resource.source !== 'current');
    }

    if (task.operation === 'file_qa') {
      return files.length > 0
        && !images.length
        && hasOnlyResourceTypes(resources, ['file'])
        && hasOnlyResourceRoles(files, ['attachment']);
    }

    if (task.operation === 'multimodal_qa') {
      return images.length > 0
        && files.length > 0
        && hasOnlyResourceTypes(resources, ['image', 'file'])
        && hasOnlyResourceRoles(images, ['source'])
        && hasOnlyResourceRoles(files, ['attachment']);
    }

    if (task.operation === 'image_qa' || task.operation === 'ocr') {
      return images.length > 0
        && hasOnlyResourceTypes(resources, ['image'])
        && hasOnlyResourceRoles(images, ['source']);
    }

    if (task.operation === 'image_compare') {
      const roles = new Set(images.map(resource => resource.role));
      return images.length === 2
        && hasOnlyResourceTypes(resources, ['image'])
        && roles.size === 2
        && roles.has('compare_a')
        && roles.has('compare_b');
    }

    if (task.operation === 'edit_image') {
      const targets = images.filter(resource => resource.role === 'target');
      return directive.mode === 'patch'
        && images.length > 0
        && !files.length
        && hasOnlyResourceTypes(resources, ['image'])
        && hasOnlyResourceRoles(images, ['target', 'mask'])
        && targets.length > 0
        && images.every(resource => baseKeys.has(resource.key));
    }

    if (task.operation === 'image_reference_gen') {
      const references = images.filter(resource => ['reference', 'style_reference'].includes(resource.role));
      return directive.mode === 'patch'
        && images.length > 0
        && !files.length
        && hasOnlyResourceTypes(resources, ['image'])
        && hasOnlyResourceRoles(images, ['reference', 'style_reference'])
        && references.length > 0
        && images.every(resource => baseKeys.has(resource.key));
    }

    return false;
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

    return hasOperationResourceShape(value);
  }

  function currentUserMessageIndex(context = {}) {
    const messages = Array.isArray(context.recent_messages) ? context.recent_messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'user') continue;
      const candidateIndex = Number(message.index);
      return Number.isInteger(candidateIndex) && candidateIndex > 0 ? candidateIndex : index + 1;
    }
    return 0;
  }

  function normalizeCandidateSource(source = '', messageIndex = 0, currentMessageIndex = 0) {
    const value = String(source || '').trim();
    if (VALID_RESOURCE_SOURCES.has(value)) return value;
    if (value === 'user_message') return Number(messageIndex) === Number(currentMessageIndex) ? 'current' : 'history';
    return 'context';
  }

  function mediaCandidates(type, context = {}, attachments = [], operation = '') {
    const currentMessageIndex = currentUserMessageIndex(context);
    const sourceCandidates = Array.isArray(type === 'image' ? context.image_candidates : context.file_candidates)
      ? (type === 'image' ? context.image_candidates : context.file_candidates)
      : [];
    const candidates = sourceCandidates.map(entry => {
      const index = Number(entry?.index);
      if (!Number.isInteger(index) || index < 1) return null;
      return {
        id: String(type === 'image' ? entry?.image_id || entry?.imageId || '' : entry?.file_id || entry?.fileId || entry?.id || ''),
        referenceId: String(entry?.reference_id || entry?.referenceId || ''),
        index,
        sourceIndex: Number(entry?.source_index || entry?.sourceIndex || entry?.index) || index,
        source: normalizeCandidateSource(entry?.source, entry?.message_index || entry?.messageIndex, currentMessageIndex),
        target: String(entry?.target || ''),
        name: String(entry?.name || entry?.filename || ''),
        attachmentIdAliases: [],
        attachmentIndexAliases: [],
      };
    }).filter(Boolean);

    let attachmentIndex = 0;
    for (const attachment of attachments || []) {
      const mime = String(attachment?.type || attachment?.mime || attachment?.file?.type || '').toLowerCase();
      const isImage = attachment?.is_image === true || attachment?.isImage === true || mime.startsWith('image/');
      if ((type === 'image') !== isImage) continue;
      attachmentIndex += 1;
      const index = attachmentIndex;
      const candidate = {
        id: String(type === 'image'
          ? attachment?.image_id || attachment?.imageId || attachment?.id || attachment?.attachmentId || attachment?.attachment_id || ''
          : attachment?.file_id || attachment?.fileId || attachment?.id || attachment?.attachmentId || attachment?.attachment_id || ''),
        referenceId: String(attachment?.reference_id || attachment?.referenceId || ''),
        index,
        sourceIndex: type === 'image'
          ? Number(attachment?.media_index || attachment?.mediaIndex || attachment?.source_index || attachment?.sourceIndex) || index
          : Number(attachment?.source_index || attachment?.sourceIndex || attachment?.media_index || attachment?.mediaIndex) || index,
        source: 'current',
        target: 'uploaded',
        name: String(attachment?.name || attachment?.filename || attachment?.file?.name || ''),
        attachmentIdAliases: [],
        attachmentIndexAliases: [],
      };
      const canonical = candidates.find(item => item.source === candidate.source && item.sourceIndex === candidate.sourceIndex);
      if (canonical) {
        // A just-uploaded image has both a transient attachment id and a durable route-context id.
        // They identify the same current resource only when their source-local index also agrees.
        if (candidate.id && candidate.id !== canonical.id && !canonical.attachmentIdAliases.includes(candidate.id)) {
          canonical.attachmentIdAliases.push(candidate.id);
        }
        if (candidate.index !== canonical.index && !canonical.attachmentIndexAliases.includes(candidate.index)) {
          canonical.attachmentIndexAliases.push(candidate.index);
        }
      } else {
        candidates.push(candidate);
      }
    }
    if (type === 'image' && operation === 'text_to_image' && !candidates.length && context?.last_generated_image?.prompt) {
      candidates.push({
        id: '',
        referenceId: String(context.last_generated_image.reference_id || ''),
        index: 1,
        sourceIndex: 1,
        source: 'history',
        target: 'previous',
        name: '',
      });
    }
    return candidates;
  }

  function resolveResourceCandidate(resource = {}, type = '', options = {}) {
    if (!MEDIA_TYPES.has(type) || resource.missing) return null;
    const candidates = mediaCandidates(type, options.context || {}, options.attachments || [], options.operation || '');
    const matches = candidates.filter(candidate => {
      const indexes = [candidate.index, ...(candidate.attachmentIndexAliases || [])];
      const ids = [candidate.id, ...(candidate.attachmentIdAliases || [])];
      if (candidate.source !== resource.source || !indexes.includes(Number(resource.index))) return false;
      if (resource.id && !ids.includes(resource.id)) return false;
      if (resource.reference_id && candidate.referenceId !== resource.reference_id) return false;
      return true;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function hasResolvedResourceBindings(task = {}, options = {}) {
    if (!hasExactContractShape(task)) return false;
    const resolved = [];
    for (const resource of task.resources || []) {
      if (resource.missing || !MEDIA_TYPES.has(resource.type)) continue;
      const candidate = resolveResourceCandidate(resource, resource.type, { ...options, operation: task.operation });
      if (!candidate) return false;
      resolved.push({ resource, candidate });
    }
    if (task.operation === 'image_compare') {
      const imageKeys = new Set(resolved
        .filter(item => item.resource.type === 'image')
        .map(item => `${item.candidate.id || item.candidate.referenceId || ''}:${item.candidate.source}:${item.candidate.index}`));
      if (imageKeys.size !== 2) return false;
    }
    return true;
  }

  function fallbackCandidate(resource = {}) {
    const source = resource.source;
    return {
      id: resource.id || '',
      referenceId: resource.reference_id || '',
      index: Number(resource.index),
      sourceIndex: Number(resource.index),
      source,
      target: ['history', 'quoted', 'context'].includes(source) ? 'previous' : 'uploaded',
      name: '',
    };
  }

  function resourceRefs(task, type, options = {}) {
    const strict = options.requireCandidateMatch === true;
    return task.resources.filter(item => item.type === type && !item.missing).map(item => {
      const candidate = resolveResourceCandidate(item, type, { ...options, operation: task.operation });
      if (strict && !candidate) throw new TypeError(`Unresolved ${type} resource: ${item.key}`);
      const resolved = candidate || fallbackCandidate(item);
      const target = ['previous', 'uploaded'].includes(resolved.target)
        ? resolved.target
        : ['history', 'quoted', 'context'].includes(resolved.source) ? 'previous' : 'uploaded';
      return {
        key: item.key,
        role: item.role,
        image_id: type === 'image' ? resolved.id : '',
        file_id: type === 'file' ? resolved.id : '',
        reference_id: resolved.referenceId,
        index: resolved.sourceIndex,
        target,
        source: resolved.source,
        name: resolved.name,
      };
    });
  }

  function taskContractToExecutionPlan(task = {}, options = {}) {
    if (!hasExactContractShape(task)) throw new TypeError('A valid task_contract.v3 is required');
    if (options.requireCandidateMatch === true && !hasResolvedResourceBindings(task, options)) throw new TypeError('Task resources must resolve to unique candidates');
    const input = String(options.input || '').trim();
    const imageRefs = resourceRefs(task, 'image', options);
    const fileRefs = resourceRefs(task, 'file', options);
    const selectedImageIndexes = [...new Set(imageRefs.map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1))];
    const selectedFileIndexes = [...new Set(fileRefs.map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1))];
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
      selectedIndexes: selectedImageIndexes,
      selectedImageIndexes,
      selectedFileIndexes,
      selectedReferenceId: imageRefs.find(ref => ref.reference_id)?.reference_id || '',
      selectedImageIds: imageRefs.map(ref => ref.image_id).filter(Boolean),
      usePreviousImage: false,
      contextualImagePrompt: '',
      editInstruction: '',
    };

    if (task.operation === 'clarify') {
      return { ...common, mode: 'chat', target: 'none', needClarification: true, clarificationQuestion: task.clarification.question, selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [], selectedReferenceId: '', selectedImageIds: [], imageRefs: [], fileRefs: [], intent: 'clarify' };
    }
    if (api === 'image_generation') {
      return { ...common, mode: 'image', target: 'new', contextualImagePrompt: input, intent: task.operation };
    }
    if (api === 'image_edit') {
      const targetRef = imageRefs.find(item => item.role === 'target');
      return {
        ...common,
        mode: 'edit_image',
        target: targetRef?.target || 'none',
        editInstruction: input,
        intent: 'image_edit',
        selectedReferenceId: targetRef?.reference_id || '',
        selectedImageIds: imageRefs.filter(ref => ref.role === 'target').map(ref => ref.image_id).filter(Boolean),
        selectedIndexes: imageRefs.filter(ref => ref.role === 'target').map(ref => ref.index),
        selectedImageIndexes: imageRefs.filter(ref => ref.role === 'target').map(ref => ref.index),
        usePreviousImage: targetRef?.target === 'previous',
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
    hasResolvedResourceBindings,
    resolveResourceCandidate,
    taskContractToExecutionPlan,
    needsIntentReview,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUICoreIntentContract = api;
  if (root?.window) root.window.ChatUICoreIntentContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
