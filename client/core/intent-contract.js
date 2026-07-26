(function initChatUIIntentContract(root) {
  'use strict';

  const SCHEMA_VERSION = 'task_contract.v4';
  const VALID_RELATIONS = new Set(['new', 'followup', 'correction', 'continuation']);
  const VALID_OPERATIONS = new Set(['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image', 'clarify']);
  const VALID_RESOURCE_TYPES = new Set(['image', 'file', 'text', 'message']);
  const VALID_RESOURCE_SOURCES = new Set(['current', 'quoted', 'history', 'context']);
  const VALID_RESOURCE_ROLES = new Set(['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context']);
  const VALID_DIRECTIVE_MODES = new Set(['standalone', 'patch']);
  const VALID_UNMENTIONED_POLICIES = new Set(['preserve', 'allow_change']);
  const VALID_PATCH_OPERATIONS = new Set(['preserve', 'add', 'replace', 'remove']);
  const MEDIA_TYPES = new Set(['image', 'file']);
  const EXECUTION_BOUND_RESOURCE_TYPES = new Set(['image', 'file', 'message']);

  const TOP_LEVEL_FIELDS = ['schema_version', 'operation', 'relation', 'resources', 'directive', 'clarification', 'confidence', 'review_reasons', 'rationale'];
  const RESOURCE_FIELDS = ['key', 'type', 'source', 'role', 'index', 'id', 'reference_id', 'missing'];
  const DIRECTIVE_FIELDS = ['mode', 'base_resource_keys', 'unmentioned_policy', 'operations', 'constraints'];
  const PATCH_OPERATION_FIELDS = ['op', 'target', 'value'];
  const CLARIFICATION_FIELDS = ['question', 'resume_operation', 'unresolved_resources'];
  const UNRESOLVED_RESOURCE_FIELDS = ['key', 'type', 'role', 'reason', 'choices'];
  const CLARIFICATION_CHOICE_FIELDS = ['key', 'source', 'index', 'id', 'reference_id', 'label'];
  const VALID_UNRESOLVED_REASONS = new Set(['missing', 'ambiguous']);

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

  function clarificationChoiceResource(slot = {}, choice = {}, relation = 'followup') {
    return {
      key: slot.key,
      type: slot.type,
      source: choice.source || (relation === 'new' ? 'current' : 'context'),
      role: slot.role,
      index: Number(choice.index) || 1,
      id: String(choice.id || ''),
      reference_id: String(choice.reference_id || ''),
      missing: false,
    };
  }

  function projectedClarificationResources(task = {}) {
    const slots = task.clarification?.unresolved_resources || [];
    return slots.map(slot => clarificationChoiceResource(slot, slot.choices?.[0], task.relation));
  }

  function hasOperationResourceShape(task = {}) {
    const resources = task.resources || [];
    const images = resourceList(task, 'image');
    const files = resourceList(task, 'file');
    const messages = resourceList(task, 'message');
    const textResources = resourceList(task, 'text');
    const boundResources = resources.filter(resource => resource.type !== 'text');
    const directive = task.directive || {};
    const baseKeys = new Set(directive.base_resource_keys || []);

    if (files.some(resource => resource.reference_id)) return false;
    if (task.operation === 'clarify') {
      const resumeOperation = task.clarification?.resume_operation;
      if (!resumeOperation || resumeOperation === 'clarify') return false;
      return hasOperationResourceShape({
        ...task,
        operation: resumeOperation,
        resources: [...resources, ...projectedClarificationResources(task)],
      });
    }
    // The current prompt is already supplied separately to every execution API.
    // Models may represent it explicitly as one neutral text resource without
    // changing the operation's media bindings.
    if (textResources.length > 1 || textResources.some(resource => resource.missing || resource.source !== 'current' || resource.role !== 'source')) return false;
    if (task.operation === 'plain_chat') {
      // A chat task may carry an explicitly selected historical image as a visual
      // reference (for example, reproducing a webpage style in HTML). It remains
      // a chat task, not an image-generation request.
      return !files.length
        && hasOnlyResourceTypes(boundResources, ['image', 'message'])
        && images.every(resource => resource.source !== 'current' && ['reference', 'style_reference'].includes(resource.role))
        && messages.every(resource => resource.source === 'history' && resource.role === 'context' && baseKeys.has(resource.key));
    }
    if (task.operation === 'text_to_image') {
      // A quoted/history message can be the textual source for a generation
      // request (for example, “base the image on the quoted cat description”).
      // It is an executable binding just like a historical image reference,
      // but it must be explicitly selected as a patch baseline.  Do not treat
      // arbitrary context/history messages as implicit prompt text.
      const messagePromptResourcesAreValid = messages.every(resource =>
        ['history', 'quoted'].includes(resource.source)
        && ['context', 'reference'].includes(resource.role)
        && baseKeys.has(resource.key)
      );
      return !files.length
        && hasOnlyResourceTypes(boundResources, ['image', 'message'])
        && hasOnlyResourceRoles(images, ['reference'])
        && images.every(resource => resource.source !== 'current')
        && messagePromptResourcesAreValid;
    }

    if (task.operation === 'file_qa') {
      return files.length > 0
        && !images.length
        && hasOnlyResourceTypes(boundResources, ['file'])
        && hasOnlyResourceRoles(files, ['attachment']);
    }

    if (task.operation === 'multimodal_qa') {
      return images.length > 0
        && files.length > 0
        && hasOnlyResourceTypes(boundResources, ['image', 'file'])
        && hasOnlyResourceRoles(images, ['source'])
        && hasOnlyResourceRoles(files, ['attachment']);
    }

    if (task.operation === 'image_qa' || task.operation === 'ocr') {
      return images.length > 0
        && hasOnlyResourceTypes(boundResources, ['image'])
        && hasOnlyResourceRoles(images, ['source']);
    }

    if (task.operation === 'image_compare') {
      const roles = new Set(images.map(resource => resource.role));
      return images.length === 2
        && hasOnlyResourceTypes(boundResources, ['image'])
        && roles.size === 2
        && roles.has('compare_a')
        && roles.has('compare_b');
    }

    if (task.operation === 'edit_image') {
      const targets = images.filter(resource => resource.role === 'target');
      return directive.mode === 'patch'
        && images.length > 0
        && !files.length
        && hasOnlyResourceTypes(boundResources, ['image'])
        && hasOnlyResourceRoles(images, ['target', 'mask'])
        && targets.length > 0
        && images.every(resource => baseKeys.has(resource.key));
    }

    if (task.operation === 'image_reference_gen') {
      const references = images.filter(resource => ['reference', 'style_reference'].includes(resource.role));
      return directive.mode === 'patch'
        && images.length > 0
        && !files.length
        && hasOnlyResourceTypes(boundResources, ['image'])
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
      if (!/^r[1-9]\d*$/.test(resource.key) || resourceKeys.has(resource.key)) return false;
      resourceKeys.add(resource.key);
      if (!VALID_RESOURCE_TYPES.has(resource.type) || !VALID_RESOURCE_SOURCES.has(resource.source) || !VALID_RESOURCE_ROLES.has(resource.role)) return false;
      if (!Number.isInteger(resource.index) || resource.index < 1) return false;
      if (typeof resource.id !== 'string' || typeof resource.reference_id !== 'string' || resource.missing !== false) return false;
      if (value.relation === 'new' && resource.source !== 'current') return false;
    }

    const clarification = value.clarification;
    if (typeof clarification.question !== 'string' || typeof clarification.resume_operation !== 'string' || !Array.isArray(clarification.unresolved_resources)) return false;
    const unresolvedKeys = new Set();
    for (const slot of clarification.unresolved_resources) {
      if (!hasOnlyFields(slot, UNRESOLVED_RESOURCE_FIELDS)) return false;
      if (!/^r[1-9]\d*$/.test(slot.key) || resourceKeys.has(slot.key) || unresolvedKeys.has(slot.key)) return false;
      unresolvedKeys.add(slot.key);
      if (!VALID_RESOURCE_TYPES.has(slot.type) || !VALID_RESOURCE_ROLES.has(slot.role) || !VALID_UNRESOLVED_REASONS.has(slot.reason) || !Array.isArray(slot.choices)) return false;
      if (slot.reason === 'missing' && slot.choices.length !== 0) return false;
      if (slot.reason === 'ambiguous' && slot.choices.length < 2) return false;
      const choiceKeys = new Set();
      const choiceBindings = new Set();
      for (const choice of slot.choices) {
        if (!hasOnlyFields(choice, CLARIFICATION_CHOICE_FIELDS)) return false;
        if (!/^c[1-9]\d*$/.test(choice.key) || choiceKeys.has(choice.key)) return false;
        choiceKeys.add(choice.key);
        if (!VALID_RESOURCE_SOURCES.has(choice.source) || !Number.isInteger(choice.index) || choice.index < 1) return false;
        if (typeof choice.id !== 'string' || typeof choice.reference_id !== 'string' || typeof choice.label !== 'string' || !choice.label.trim()) return false;
        if (slot.type === 'file' && choice.reference_id) return false;
        if (value.relation === 'new' && choice.source !== 'current') return false;
        const binding = `${choice.source}:${choice.index}:${choice.id}:${choice.reference_id}`;
        if (choiceBindings.has(binding)) return false;
        choiceBindings.add(binding);
      }
    }

    if (value.operation === 'clarify') {
      if (!clarification.question.trim() || !VALID_OPERATIONS.has(clarification.resume_operation) || clarification.resume_operation === 'clarify' || !clarification.unresolved_resources.length) return false;
    } else if (clarification.question || clarification.resume_operation || clarification.unresolved_resources.length) {
      return false;
    }

    const directive = value.directive;
    if (!VALID_DIRECTIVE_MODES.has(directive.mode) || !VALID_UNMENTIONED_POLICIES.has(directive.unmentioned_policy)) return false;
    if (!Array.isArray(directive.base_resource_keys) || !Array.isArray(directive.operations) || !Array.isArray(directive.constraints)) return false;
    const declaredResourceKeys = new Set([...resourceKeys, ...(value.operation === 'clarify' ? unresolvedKeys : [])]);
    if (directive.base_resource_keys.some(key => typeof key !== 'string' || !declaredResourceKeys.has(key))) return false;
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

    const baselineResources = value.operation === 'clarify'
      ? [...value.resources, ...clarification.unresolved_resources.flatMap(slot => slot.choices.map(choice => clarificationChoiceResource(slot, choice, value.relation)))]
      : value.resources;
    if (baselineResources.some(resource => ['quoted', 'history', 'context'].includes(resource.source) && !directive.base_resource_keys.includes(resource.key))) return false;

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
        messageIndex: Number(entry?.message_index || entry?.messageIndex) || 0,
        messageId: String(entry?.message_id || entry?.messageId || ''),
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
    const context = options.context || {};
    const quote = context?.quoted_message && typeof context.quoted_message === 'object'
      ? context.quoted_message
      : null;
    const hasExplicitQuote = Number.isInteger(Number(quote?.index)) && Number(quote.index) >= 1;
    const quoteId = String(quote?.display_item_id || quote?.displayItemId || quote?.id || quote?.message_id || quote?.messageId || '');
    const candidates = mediaCandidates(type, context, options.attachments || [], options.operation || '');
    const matches = candidates.filter(candidate => {
      const indexes = [candidate.index, ...(candidate.attachmentIndexAliases || [])];
      const ids = [candidate.id, ...(candidate.attachmentIdAliases || [])];
      // An explicit UI quote is a concrete history resource. Some route models
      // describe that resource as `history`, while the UI exposes it as
      // `quoted` so the downstream request can preserve quote semantics. Keep
      // both descriptions bound to this exact candidate only; never apply this
      // alias to ordinary history, current, or context resources.
      const sourceMatches = candidate.source === resource.source
        || candidate.source === 'quoted'
          && resource.source === 'history'
          && hasExplicitQuote
          && (() => {
            const candidateMessageIndex = Number(candidate.messageIndex);
            const candidateMessageId = String(candidate.messageId || '');
            if (candidateMessageId && quoteId && candidateMessageId !== quoteId) return false;
            // A quoted media candidate without message metadata is only
            // unambiguous in the compact one-quote context (index 1). When
            // metadata is present, bind it to the exact quoted message.
            if (Number.isInteger(candidateMessageIndex) && candidateMessageIndex > 0) return candidateMessageIndex === Number(quote.index);
            return Number(quote.index) === 1;
          })();
      if (!sourceMatches || !indexes.includes(Number(resource.index))) return false;
      if (resource.id && !ids.includes(resource.id)) return false;
      if (resource.reference_id && candidate.referenceId !== resource.reference_id) return false;
      return true;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function messageCandidates(context = {}) {
    const recent = Array.isArray(context?.recent_messages) ? context.recent_messages : [];
    const quote = context?.quoted_message && typeof context.quoted_message === 'object' ? context.quoted_message : null;
    const candidates = recent.map((message, fallbackIndex) => {
      const index = Number(message?.index) || fallbackIndex + 1;
      return {
        index,
        source: 'history',
        id: String(message?.display_item_id || message?.displayItemId || message?.id || message?.message_id || message?.messageId || (Number(quote?.index) === index ? quote?.display_item_id || quote?.displayItemId || quote?.id || quote?.message_id || quote?.messageId || '' : '')),
        role: String(message?.role || ''),
      };
    }).filter(candidate => Number.isInteger(candidate.index) && candidate.index >= 1);
    const quotedIndex = Number(quote?.index);
    if (Number.isInteger(quotedIndex) && quotedIndex >= 1 && !candidates.some(candidate => candidate.index === quotedIndex)) {
      candidates.push({ index: quotedIndex, source: 'history', id: String(quote?.display_item_id || quote?.displayItemId || quote?.id || quote?.message_id || quote?.messageId || ''), role: String(quote?.role || '') });
    }
    return candidates;
  }

  function resolveMessageResource(resource = {}, options = {}) {
    if (resource?.type !== 'message' || resource.missing) return null;
    const context = options.context || {};
    const quote = context?.quoted_message && typeof context.quoted_message === 'object' ? context.quoted_message : null;
    const quoteIndex = Number(quote?.index);
    const quoteId = String(quote?.display_item_id || quote?.displayItemId || quote?.id || quote?.message_id || quote?.messageId || '');
    const isExplicitQuote = candidate => Number.isInteger(quoteIndex)
      && quoteIndex >= 1
      && candidate.index === quoteIndex
      && (!quoteId || !candidate.id || candidate.id === quoteId);
    const matches = messageCandidates(context).filter(candidate => {
      // The model may call the explicitly quoted message `quoted`, while the
      // route context exposes it as the concrete history candidate.  Permit
      // that alias only for the one UI-selected message, preserving exact
      // index/id uniqueness for every other history resource.
      const sourceMatches = candidate.source === resource.source
        || resource.source === 'quoted' && candidate.source === 'history' && isExplicitQuote(candidate);
      if (!sourceMatches || candidate.index !== Number(resource.index)) return false;
      return !resource.id || candidate.id === resource.id;
    });
    if (matches.length !== 1) return null;
    return resource.source === 'quoted' ? { ...matches[0], source: 'quoted' } : matches[0];
  }

  function hasResolvedResourceBindings(task = {}, options = {}) {
    if (!hasExactContractShape(task)) return false;
    const resolved = [];
    const operation = task.operation === 'clarify' ? task.clarification.resume_operation : task.operation;
    const choiceResources = task.operation === 'clarify'
      ? task.clarification.unresolved_resources.flatMap(slot => slot.choices.map(choice => clarificationChoiceResource(slot, choice, task.relation)))
      : [];
    for (const resource of [...(task.resources || []), ...choiceResources]) {
      if (!EXECUTION_BOUND_RESOURCE_TYPES.has(resource.type)) continue;
      const candidate = resource.type === 'message'
        ? resolveMessageResource(resource, options)
        : resolveResourceCandidate(resource, resource.type, { ...options, operation });
      if (!candidate) return false;
      resolved.push({ resource, candidate });
    }
    if (operation === 'image_compare' && task.operation !== 'clarify') {
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

  function messageRefs(task, options = {}) {
    const strict = options.requireCandidateMatch === true;
    return task.resources.filter(item => item.type === 'message' && !item.missing).map(item => {
      const candidate = resolveMessageResource(item, options);
      if (strict && !candidate) throw new TypeError(`Unresolved message resource: ${item.key}`);
      const resolved = candidate || { index: Number(item.index), source: item.source, id: item.id || '', role: '' };
      return {
        key: item.key,
        role: resolved.role,
        message_id: resolved.id,
        index: resolved.index,
        source: resolved.source,
      };
    });
  }

  function taskContractToExecutionPlan(task = {}, options = {}) {
    if (!hasExactContractShape(task)) throw new TypeError('A valid task_contract.v4 is required');
    if (options.requireCandidateMatch === true && !hasResolvedResourceBindings(task, options)) throw new TypeError('Task resources must resolve to unique candidates');
    const input = String(options.input || '').trim();
    const imageRefs = resourceRefs(task, 'image', options);
    const fileRefs = resourceRefs(task, 'file', options);
    const selectedMessageRefs = messageRefs(task, options);
    const selectedImageIndexes = [...new Set(imageRefs.map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1))];
    const selectedFileIndexes = [...new Set(fileRefs.map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1))];
    const api = contractApi(task);
    const common = {
      api,
      relation: task.relation,
      resources: task.resources,
      imageRefs,
      fileRefs,
      messageRefs: selectedMessageRefs,
      directiveAudit: task.directive,
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
      const slots = task.clarification.unresolved_resources.map(slot => ({
        ...slot,
        choices: slot.choices.map(choice => ({ ...choice })),
      }));
      const choiceLines = slots.flatMap((slot, slotIndex) => {
        if (!slot.choices.length) return [];
        const heading = slots.length > 1 ? [`${slotIndex + 1}. ${slot.key}`] : [];
        return [...heading, ...slot.choices.map((choice, choiceIndex) => `${slots.length > 1 ? '   ' : ''}${choiceIndex + 1}. ${choice.label}`)];
      });
      const clarificationQuestion = [task.clarification.question.trim(), choiceLines.join('\n')].filter(Boolean).join('\n');
      return {
        ...common,
        mode: 'chat',
        target: 'none',
        needClarification: true,
        clarificationQuestion,
        clarificationSlots: slots,
        resumeOperation: task.clarification.resume_operation,
        selectedIndexes: [],
        selectedImageIndexes: [],
        selectedFileIndexes: [],
        selectedReferenceId: '',
        selectedImageIds: [],
        imageRefs: [],
        fileRefs: [],
        messageRefs: [],
        intent: 'clarify',
      };
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

  function resolveClarificationContract(task = {}, selections = [], attachments = []) {
    if (!hasExactContractShape(task) || task.operation !== 'clarify' || !Array.isArray(selections) || !Array.isArray(attachments)) return null;
    const selectionMap = new Map();
    for (const selection of selections) {
      if (!hasOnlyFields(selection, ['resource_key', 'choice_key'])) return null;
      if (typeof selection.resource_key !== 'string' || typeof selection.choice_key !== 'string' || selectionMap.has(selection.resource_key)) return null;
      selectionMap.set(selection.resource_key, selection.choice_key);
    }

    const missingSlotsByType = new Map();
    for (const slot of task.clarification.unresolved_resources.filter(item => item.reason === 'missing')) {
      if (!['image', 'file'].includes(slot.type)) return null;
      const slots = missingSlotsByType.get(slot.type) || [];
      slots.push(slot);
      missingSlotsByType.set(slot.type, slots);
    }
    const attachmentResources = new Map();
    for (const [type, slots] of missingSlotsByType) {
      const candidates = attachments.filter(item => type === 'image' ? item?.is_image === true : item?.is_image !== true);
      if (candidates.length !== slots.length) return null;
      slots.forEach((slot, index) => {
        const candidate = candidates[index];
        attachmentResources.set(slot.key, {
          key: slot.key,
          type,
          source: 'current',
          role: slot.role,
          index: Number(candidate.media_index || candidate.mediaIndex) || index + 1,
          id: String(type === 'image' ? candidate.image_id || candidate.imageId || candidate.id || '' : candidate.file_id || candidate.fileId || candidate.id || ''),
          reference_id: '',
          missing: false,
        });
      });
    }

    const selectedResources = [];
    for (const slot of task.clarification.unresolved_resources) {
      const choiceKey = selectionMap.get(slot.key);
      if (slot.reason === 'missing') {
        if (choiceKey || !attachmentResources.has(slot.key)) return null;
        selectedResources.push(attachmentResources.get(slot.key));
        continue;
      }
      const choice = slot.choices.find(item => item.key === choiceKey);
      if (!choice) return null;
      selectedResources.push(clarificationChoiceResource(slot, choice, task.relation));
    }
    if (selectionMap.size !== task.clarification.unresolved_resources.filter(slot => slot.reason === 'ambiguous').length) return null;

    const resolved = {
      ...task,
      operation: task.clarification.resume_operation,
      resources: [...task.resources, ...selectedResources],
      clarification: { question: '', resume_operation: '', unresolved_resources: [] },
    };
    if (!hasExactContractShape(resolved)) return null;
    if (resolved.operation === 'image_compare') {
      const bindings = resolved.resources.filter(resource => resource.type === 'image').map(resource => `${resource.source}:${resource.index}:${resource.id}:${resource.reference_id}`);
      if (new Set(bindings).size !== 2) return null;
    }
    return resolved;
  }

  const api = Object.freeze({
    SCHEMA_VERSION,
    contractApi,
    hasExactContractShape,
    hasResolvedResourceBindings,
    resolveResourceCandidate,
    resolveMessageResource,
    messageCandidates,
    resolveClarificationContract,
    taskContractToExecutionPlan,
    needsIntentReview,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUICoreIntentContract = api;
  if (root?.window) root.window.ChatUICoreIntentContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
