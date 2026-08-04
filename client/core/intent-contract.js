(function initChatUIIntentContract(root) {
  'use strict';

  const attachmentsCore = root?.ChatUICoreAttachments
    || (typeof require === 'function' ? require('./attachments') : {});

  const routeProtocol = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeProtocol')
    || root?.ChatUICore?.routeProtocol
    || (typeof require === 'function' ? require('./route-protocol') : {});
  const {
    SCHEMA_VERSION,
    VALID_RELATIONS,
    VALID_OPERATIONS,
    VALID_READINESS,
    VALID_RESOURCE_TYPES,
    VALID_RESOURCE_SOURCES,
    VALID_RESOURCE_ROLES,
    VALID_PATCH_OPERATIONS,
    VALID_UNRESOLVED_REASONS,
  } = routeProtocol;

  const VALID_DIRECTIVE_MODES = new Set(['standalone', 'patch']);
  const VALID_UNMENTIONED_POLICIES = new Set(['preserve', 'allow_change']);
  const MEDIA_TYPES = new Set(['image', 'file']);
  const EXECUTION_BOUND_RESOURCE_TYPES = new Set(['image', 'file', 'message']);
  const EXECUTION_RESOURCE_PROJECTION_VERSION = 'execution_resources.v1';

  const TOP_LEVEL_FIELDS = ['schema_version', 'readiness', 'operation', 'relation', 'resources', 'directive', 'clarification', 'confidence', 'review_reasons', 'rationale'];
  const RESOURCE_FIELDS = ['key', 'type', 'source', 'role', 'index', 'id', 'reference_id', 'missing'];
  const DIRECTIVE_FIELDS = ['mode', 'base_resource_keys', 'unmentioned_policy', 'operations', 'constraints'];
  const PATCH_OPERATION_FIELDS = ['op', 'target', 'value'];
  const CLARIFICATION_FIELDS = ['question', 'unresolved_resources'];
  const UNRESOLVED_RESOURCE_FIELDS = ['key', 'type', 'role', 'reason', 'choices'];
  const CLARIFICATION_CHOICE_FIELDS = ['key', 'source', 'index', 'id', 'reference_id', 'label'];

  const API_BY_OPERATION = Object.freeze({
    plain_chat: 'chat',
    file_qa: 'chat',
    multimodal_qa: 'chat',
    image_qa: 'vision',
    image_compare: 'vision',
    ocr: 'vision',
    text_to_image: 'image_generation',
    // Reference generation consumes image inputs, so it must use the multipart
    // image-edits transport even though its product is a newly composed image.
    image_reference_gen: 'image_edit',
    edit_image: 'image_edit',
  });

  const MODE_BY_OPERATION = Object.freeze({
    plain_chat: 'chat',
    file_qa: 'chat',
    multimodal_qa: 'chat',
    image_qa: 'chat',
    image_compare: 'chat',
    ocr: 'chat',
    text_to_image: 'image',
    image_reference_gen: 'image',
    edit_image: 'edit_image',
  });

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => keys.includes(field));
  }

  function contractApi(task = {}) {
    return API_BY_OPERATION[task.operation] || '';
  }

  function contractMode(task = {}) {
    return MODE_BY_OPERATION[task.operation] || '';
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
      source: choice.source || (slot.type === 'text' ? 'current' : relation === 'new' ? 'current' : 'context'),
      role: slot.role,
      index: Number(choice.index) || 1,
      id: String(choice.id || ''),
      reference_id: String(choice.reference_id || ''),
      missing: false,
    };
  }

  function normalizeContractVersion(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    if (value.schema_version !== 'task_contract.v4') return value;
    const legacyFields = ['schema_version', 'operation', 'relation', 'resources', 'directive', 'clarification', 'confidence', 'review_reasons', 'rationale'];
    if (!hasOnlyFields(value, legacyFields)) return value;
    const clarification = value.clarification && typeof value.clarification === 'object' ? value.clarification : {};
    if (!hasOnlyFields(clarification, ['question', 'resume_operation', 'unresolved_resources'])) return value;
    const declaredClarification = value.operation === 'clarify'
      || String(clarification.question || '').trim()
      || String(clarification.resume_operation || '').trim()
      || Array.isArray(clarification.unresolved_resources) && clarification.unresolved_resources.length;
    // Version migration preserves every semantic binding and only separates
    // the legacy lifecycle marker from the real operation. The migrated value
    // still passes through the complete v5 shape and candidate validators.
    return {
      schema_version: SCHEMA_VERSION,
      readiness: declaredClarification ? 'needs_clarification' : 'ready',
      operation: value.operation === 'clarify' ? String(clarification.resume_operation || '') : value.operation,
      relation: value.relation,
      resources: value.resources,
      directive: value.directive,
      clarification: { question: String(clarification.question || ''), unresolved_resources: clarification.unresolved_resources || [] },
      confidence: value.confidence,
      review_reasons: value.review_reasons,
      rationale: value.rationale,
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
    if (task.readiness === 'needs_clarification') {
      return hasOperationResourceShape({
        ...task,
        readiness: 'ready',
        resources: [...resources, ...projectedClarificationResources(task)],
        clarification: { question: '', unresolved_resources: [] },
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
        && messages.every(resource => ['history', 'quoted'].includes(resource.source) && resource.role === 'context' && baseKeys.has(resource.key));
    }
    if (task.operation === 'text_to_image') {
      // Pure text-to-image generation does not consume an existing image.  A
      // request that uses an existing image is image_reference_gen instead.
      // A quoted/history message may still be selected as textual source, but
      // it must be an explicit patch baseline rather than implicit history.
      const messagePromptResourcesAreValid = messages.every(resource =>
        ['history', 'quoted'].includes(resource.source)
        && ['context', 'reference'].includes(resource.role)
        && baseKeys.has(resource.key)
      );
      return !files.length
        && !images.length
        && hasOnlyResourceTypes(boundResources, ['message'])
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
      const masks = images.filter(resource => resource.role === 'mask');
      const imageInputs = images.filter(resource => resource.role !== 'mask');
      // Image edits may use additional content/style references while retaining
      // one explicit target. This matches the multipart image-edit boundary,
      // which already preserves every role independently in image_role_map.
      return directive.mode === 'patch'
        && images.length > 0
        && !files.length
        && hasOnlyResourceTypes(boundResources, ['image'])
        && hasOnlyResourceRoles(images, ['target', 'reference', 'style_reference', 'mask'])
        && targets.length === 1
        && imageInputs[0]?.role === 'target'
        && masks.length <= 1
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
    value = normalizeContractVersion(value);
    if (!hasOnlyFields(value, TOP_LEVEL_FIELDS)) return false;
    if (value.schema_version !== SCHEMA_VERSION || !VALID_READINESS.has(value.readiness) || !VALID_OPERATIONS.has(value.operation) || !VALID_RELATIONS.has(value.relation)) return false;
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
    if (typeof clarification.question !== 'string' || !Array.isArray(clarification.unresolved_resources)) return false;
    const unresolvedKeys = new Set();
    for (const slot of clarification.unresolved_resources) {
      if (!hasOnlyFields(slot, UNRESOLVED_RESOURCE_FIELDS)) return false;
      if (!/^r[1-9]\d*$/.test(slot.key) || resourceKeys.has(slot.key) || unresolvedKeys.has(slot.key)) return false;
      unresolvedKeys.add(slot.key);
      if (!VALID_RESOURCE_TYPES.has(slot.type) || !VALID_RESOURCE_ROLES.has(slot.role) || !VALID_UNRESOLVED_REASONS.has(slot.reason) || !Array.isArray(slot.choices)) return false;
      if ((slot.reason === 'missing' || slot.reason === 'unavailable') && slot.choices.length !== 0) return false;
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

    if (value.readiness === 'needs_clarification') {
      if (!clarification.question.trim() || !clarification.unresolved_resources.length) return false;
    } else if (clarification.question || clarification.unresolved_resources.length) {
      return false;
    }

    const directive = value.directive;
    if (!VALID_DIRECTIVE_MODES.has(directive.mode) || !VALID_UNMENTIONED_POLICIES.has(directive.unmentioned_policy)) return false;
    if (!Array.isArray(directive.base_resource_keys) || !Array.isArray(directive.operations) || !Array.isArray(directive.constraints)) return false;
    const declaredResourceKeys = new Set([...resourceKeys, ...(value.readiness === 'needs_clarification' ? unresolvedKeys : [])]);
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

    const baselineResources = value.readiness === 'needs_clarification'
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

  function isInputFileAvailable(item = {}) {
    const checker = root?.ChatUICoreAttachments?.isInputFileAvailable
      || attachmentsCore?.isInputFileAvailable;
    return typeof checker === 'function'
      ? checker(item)
      : item?.input_file_available === true || item?.inputFileAvailable === true;
  }

  function fileCandidateUnavailable(item = {}) {
    if (String(item?.unsupported_reason || item?.unsupportedReason || '').trim()) return true;
    const extractedText = typeof item?.has_extracted_text === 'boolean'
      ? item.has_extracted_text
      : typeof item?.hasExtractedText === 'boolean' ? item.hasExtractedText : undefined;
    return extractedText === false && !isInputFileAvailable(item);
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
        unavailable: type === 'file' && fileCandidateUnavailable(entry),
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
        unavailable: type === 'file' && fileCandidateUnavailable(attachment),
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
        if (type === 'file' && candidate.unavailable) canonical.unavailable = true;
      } else {
        candidates.push(candidate);
      }
    }
    return type === 'file' ? candidates.filter(candidate => !candidate.unavailable) : candidates;
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

  function candidateIdentityIds(candidate = {}) {
    return [candidate.id, ...(candidate.attachmentIdAliases || [])].map(value => String(value || '')).filter(Boolean);
  }

  function uniqueMediaCandidateByIdentity(binding = {}, type = '', options = {}) {
    if (!MEDIA_TYPES.has(type)) return null;
    const candidates = mediaCandidates(type, options.context || {}, options.attachments || [], options.operation || '');
    const declaredId = String(binding.id || '');
    const declaredReferenceId = String(binding.reference_id || '');
    if (!declaredId && !declaredReferenceId) return null;
    let matches = candidates.filter(candidate => {
      const sourceMatches = candidate.source === binding.source || (() => {
        if (candidate.source !== 'quoted' || binding.source !== 'history') return false;
        const probe = resolveResourceCandidate({ ...binding, index: candidate.index }, type, options);
        return !!probe
          && probe.index === candidate.index
          && String(probe.id || '') === String(candidate.id || '')
          && String(probe.referenceId || '') === String(candidate.referenceId || '');
      })();
      if (!sourceMatches) return false;
      if (declaredId && !candidateIdentityIds(candidate).includes(declaredId)) return false;
      if (declaredReferenceId && String(candidate.referenceId || '') !== declaredReferenceId) return false;
      return true;
    });
    if (matches.length > 1) {
      const declaredIndex = Number(binding.index);
      const exactHints = matches.filter(candidate => {
        const indexes = [candidate.index, ...(candidate.attachmentIndexAliases || [])];
        return candidate.source === binding.source && indexes.includes(declaredIndex);
      });
      if (exactHints.length === 1) matches = exactHints;
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function canonicalizeResourceBinding(resource = {}, options = {}) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return resource;
    if (MEDIA_TYPES.has(resource.type)) {
      // Stable opaque ids carry resource identity. Candidate indexes are display
      // positions and can change when route context is compacted, so the runtime
      // owns them and rewrites them from the uniquely identified candidate.
      const candidate = uniqueMediaCandidateByIdentity(resource, resource.type, options)
        || resolveResourceCandidate(resource, resource.type, options);
      if (!candidate) return { ...resource };
      return {
        ...resource,
        source: candidate.source,
        index: candidate.index,
        id: candidate.id || String(resource.id || ''),
        reference_id: resource.type === 'image' ? candidate.referenceId || String(resource.reference_id || '') : '',
      };
    }
    if (resource.type === 'message') {
      const candidate = resolveMessageResource(resource, options);
      if (!candidate) return { ...resource };
      return { ...resource, source: candidate.source, index: candidate.index, id: candidate.id || String(resource.id || '') };
    }
    return { ...resource };
  }

  function canonicalizeContractBindings(task = {}, options = {}) {
    const normalized = normalizeContractVersion(task);
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
    const operation = String(normalized.operation || '');
    const bindingOptions = { ...options, operation };
    const resources = Array.isArray(normalized.resources)
      ? normalized.resources.map(resource => canonicalizeResourceBinding(resource, bindingOptions))
      : normalized.resources;
    const clarification = normalized.clarification && typeof normalized.clarification === 'object' && !Array.isArray(normalized.clarification)
      ? {
          ...normalized.clarification,
          unresolved_resources: Array.isArray(normalized.clarification.unresolved_resources)
            ? normalized.clarification.unresolved_resources.map(slot => ({
                ...slot,
                choices: Array.isArray(slot?.choices) ? slot.choices.map(choice => {
                  const resource = clarificationChoiceResource(slot, choice, normalized.relation);
                  const canonical = canonicalizeResourceBinding(resource, bindingOptions);
                  return {
                    ...choice,
                    source: canonical.source,
                    index: canonical.index,
                    id: canonical.id,
                    reference_id: canonical.reference_id,
                  };
                }) : slot?.choices,
              }))
            : normalized.clarification.unresolved_resources,
        }
      : normalized.clarification;
    return { ...normalized, resources, clarification };
  }

  function projectFields(value = {}, fields = []) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(fields.map(field => [field, source[field]]));
  }

  function canonicalClarificationDirective(task = {}) {
    const resources = Array.isArray(task.resources) ? task.resources : [];
    const slots = Array.isArray(task.clarification?.unresolved_resources) ? task.clarification.unresolved_resources : [];
    const baselineKeys = [];
    const seen = new Set();
    for (const resource of [...resources, ...slots]) {
      const key = String(resource?.key || '');
      if (resource?.type === 'text' || !/^r[1-9]\d*$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      baselineKeys.push(key);
    }
    const hasHistoricalBinding = resources.some(resource => ['quoted', 'history', 'context'].includes(resource?.source))
      || slots.some(slot => (slot?.choices || []).some(choice => ['quoted', 'history', 'context'].includes(choice?.source)));
    const operationRequiresPatch = ['edit_image', 'image_reference_gen'].includes(task.operation);
    const requestedPatch = task.directive?.mode === 'patch' && baselineKeys.length > 0;
    const mode = operationRequiresPatch || hasHistoricalBinding || requestedPatch ? 'patch' : 'standalone';
    const constraints = Array.isArray(task.directive?.constraints)
      ? task.directive.constraints.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
      : [];
    if (mode === 'standalone') {
      return { mode, base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints };
    }
    const operations = Array.isArray(task.directive?.operations)
      ? task.directive.operations.filter(operation => {
          if (!hasOnlyFields(operation, PATCH_OPERATION_FIELDS)) return false;
          if (!VALID_PATCH_OPERATIONS.has(operation.op) || typeof operation.target !== 'string' || !operation.target.trim() || typeof operation.value !== 'string') return false;
          if ((operation.op === 'add' || operation.op === 'replace') && !operation.value.trim()) return false;
          return !((operation.op === 'remove' || operation.op === 'preserve') && operation.value !== '');
        }).map(operation => ({ ...operation, target: operation.target.trim(), value: operation.value.trim() }))
      : [];
    const unmentionedPolicy = VALID_UNMENTIONED_POLICIES.has(task.directive?.unmentioned_policy)
      ? task.directive.unmentioned_policy
      : 'preserve';
    return { mode, base_resource_keys: baselineKeys, unmentioned_policy: unmentionedPolicy, operations, constraints };
  }

  function canonicalizeClarificationContract(task = {}, options = {}) {
    const normalized = normalizeContractVersion(task);
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized) || normalized.readiness !== 'needs_clarification') return normalized;
    const resources = Array.isArray(normalized.resources)
      ? normalized.resources.map(resource => projectFields(resource, RESOURCE_FIELDS))
      : normalized.resources;
    const unresolvedResources = Array.isArray(normalized.clarification?.unresolved_resources)
      ? normalized.clarification.unresolved_resources.map(slot => ({
          ...projectFields(slot, UNRESOLVED_RESOURCE_FIELDS),
          choices: Array.isArray(slot?.choices)
            ? slot.choices.map(choice => projectFields(choice, CLARIFICATION_CHOICE_FIELDS))
            : slot?.choices,
        }))
      : normalized.clarification?.unresolved_resources;
    const candidate = {
      schema_version: normalized.schema_version,
      readiness: 'needs_clarification',
      operation: normalized.operation,
      relation: normalized.relation,
      resources,
      directive: canonicalClarificationDirective({
        ...normalized,
        resources,
        clarification: { question: normalized.clarification?.question, unresolved_resources: unresolvedResources },
      }),
      clarification: {
        question: typeof normalized.clarification?.question === 'string' ? normalized.clarification.question : '',
        unresolved_resources: unresolvedResources,
      },
      confidence: Number.isFinite(normalized.confidence) ? Math.max(0, Math.min(1, normalized.confidence)) : 0,
      review_reasons: Array.isArray(normalized.review_reasons)
        ? normalized.review_reasons.filter(reason => typeof reason === 'string' && reason.trim()).map(reason => reason.trim())
        : [],
      rationale: typeof normalized.rationale === 'string' ? normalized.rationale : '',
    };
    return canonicalizeContractBindings(candidate, options);
  }

  function hasResolvedResourceBindings(task = {}, options = {}) {
    task = normalizeContractVersion(task);
    if (!hasExactContractShape(task)) return false;
    const resolved = [];
    const operation = task.operation;
    const choiceResources = task.readiness === 'needs_clarification'
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
    if (operation === 'image_compare' && task.readiness === 'ready') {
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
        identity_aliases: candidateIdentityIds(resolved).filter(id => id !== String(resolved.id || '')),
        index_aliases: (resolved.attachmentIndexAliases || []).map(Number).filter(index => Number.isInteger(index) && index >= 1),
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

  function taskContractToExecutionResources(task = {}, options = {}) {
    task = normalizeContractVersion(task);
    if (!hasExactContractShape(task) || task.readiness !== 'ready') {
      throw new TypeError('A ready task_contract.v5 is required for execution resources');
    }
    if (options.requireCandidateMatch === true && !hasResolvedResourceBindings(task, options)) {
      throw new TypeError('Task resources must resolve to unique candidates');
    }
    const resolvedImages = Array.isArray(options.imageRefs)
      ? options.imageRefs
      : resourceRefs(task, 'image', options);
    const resolvedFiles = Array.isArray(options.fileRefs)
      ? options.fileRefs
      : resourceRefs(task, 'file', options);
    const resolvedMessages = Array.isArray(options.messageRefs)
      ? options.messageRefs
      : messageRefs(task, options);
    const canonicalMediaResource = (resource, type) => ({
      key: String(resource.key || ''),
      type,
      source: String(resource.source || ''),
      role: String(resource.role || ''),
      index: Number(resource.index),
      id: String(type === 'image' ? resource.image_id || resource.imageId || resource.id || '' : resource.file_id || resource.fileId || resource.id || ''),
      reference_id: type === 'image' ? String(resource.reference_id || resource.referenceId || '') : '',
      identity_aliases: [...new Set((resource.identity_aliases || resource.identityAliases || []).map(value => String(value || '')).filter(Boolean))],
      index_aliases: [...new Set((resource.index_aliases || resource.indexAliases || []).map(Number).filter(index => Number.isInteger(index) && index >= 1))],
    });
    const images = resolvedImages.map(resource => canonicalMediaResource(resource, 'image'));
    const files = resolvedFiles.map(resource => canonicalMediaResource(resource, 'file'));
    const messages = resolvedMessages.map(resource => ({
      key: String(resource.key || ''),
      type: 'message',
      source: String(resource.source || ''),
      role: String(resource.role || ''),
      index: Number(resource.index),
      id: String(resource.message_id || resource.messageId || resource.id || ''),
      reference_id: '',
      identity_aliases: [],
      index_aliases: [],
    }));
    const targets = images.filter(resource => resource.role === 'target');
    const masks = images.filter(resource => resource.role === 'mask');
    const references = images.filter(resource => ['reference', 'style_reference'].includes(resource.role));
    return {
      version: EXECUTION_RESOURCE_PROJECTION_VERSION,
      operation: task.operation,
      api: contractApi(task),
      relation: task.relation,
      images,
      files,
      messages,
      targets,
      masks,
      references,
      // These are the only media groups that the formal request builders may
      // consume.  They are deliberately role-specific; a mask can never be
      // silently promoted to an ordinary image input.
      imageInputs: [...targets, ...references],
      chatImages: images,
      chatFiles: files,
      selectedMessageRefs: messages,
    };
  }

  function clarificationSlotHeading(slot = {}, slotIndex = 0) {
    const labels = (slot.choices || []).map(choice => String(choice?.label || '').trim()).filter(Boolean);
    const imageSuffix = slot.type === 'image' ? '图片' : '候选项';
    if (labels.length > 1) {
      const englishWords = labels.map(label => new Set((label.toLowerCase().match(/[a-z0-9]+/g) || []).filter(word => word.length > 1)));
      const commonEnglish = [...englishWords[0] || []].filter(word => englishWords.every(words => words.has(word))).sort((left, right) => right.length - left.length)[0];
      if (commonEnglish) return `${commonEnglish} ${imageSuffix}`;
      const ignoredCharacters = new Set(['图', '片', '画', '原', '始', '彩', '绘', '版', '一', '只', '条', '张', '的', '要', '手', '色']);
      const firstCharacters = [...new Set(labels[0].match(/[\u4e00-\u9fff]/g) || [])];
      const commonCharacter = firstCharacters.find(character => !ignoredCharacters.has(character) && labels.every(label => label.includes(character)));
      if (commonCharacter) return `${commonCharacter}${imageSuffix}`;
    }
    return `第 ${slotIndex + 1} 组${imageSuffix}`;
  }

  function taskContractToExecutionPlan(task = {}, options = {}) {
    task = normalizeContractVersion(task);
    if (!hasExactContractShape(task)) throw new TypeError('A valid task_contract.v5 is required');
    if (options.requireCandidateMatch === true && !hasResolvedResourceBindings(task, options)) throw new TypeError('Task resources must resolve to unique candidates');
    const input = String(options.input || '').trim();
    const imageRefs = resourceRefs(task, 'image', options);
    const fileRefs = resourceRefs(task, 'file', options);
    const selectedMessageRefs = messageRefs(task, options);
    const executionResources = task.readiness === 'ready'
      ? taskContractToExecutionResources(task, { ...options, imageRefs, fileRefs, messageRefs: selectedMessageRefs })
      : null;
    const selectedImageIndexes = [...new Set(imageRefs.map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1))];
    const selectedFileIndexes = [...new Set(fileRefs.map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1))];
    const operationApi = contractApi(task);
    const operationMode = contractMode(task);
    const dispatchAuthorized = task.readiness === 'ready';
    const common = {
      api: dispatchAuthorized ? operationApi : 'clarify',
      operationApi,
      operationMode,
      readiness: task.readiness,
      dispatchAuthorized,
      relation: task.relation,
      resources: task.resources,
      imageRefs,
      fileRefs,
      messageRefs: selectedMessageRefs,
      executionResources,
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

    if (task.readiness === 'needs_clarification') {
      const slots = task.clarification.unresolved_resources.map(slot => ({
        ...slot,
        choices: slot.choices.map(choice => ({ ...choice })),
      }));
      const choiceLines = slots.flatMap((slot, slotIndex) => {
        // Image candidates are rendered as numbered thumbnail cards by the
        // presentation layer.  Keeping their labels out of the question avoids
        // duplicating semantic metadata as an unreadable wall of text.
        if (slot.type === 'image' || !slot.choices.length) return [];
        const heading = slots.length > 1 ? [clarificationSlotHeading(slot, slotIndex)] : [];
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
        resumeOperation: task.operation,
        resumeApi: operationApi,
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
    if (operationMode === 'image' && operationApi === 'image_generation') {
      return { ...common, mode: 'image', target: 'new', contextualImagePrompt: input, intent: task.operation };
    }
    if (operationApi === 'image_edit') {
      if (task.operation === 'image_reference_gen') {
        const firstReference = imageRefs[0];
        return {
          ...common,
          // Reference generation produces a new image.  It uses the image-edit
          // multipart transport only because that endpoint carries input media;
          // the product/runtime mode must remain the image-generation family.
          mode: 'image',
          target: 'new',
          editInstruction: input,
          intent: 'image_reference_gen',
          selectedReferenceId: firstReference?.reference_id || '',
          selectedImageIds: imageRefs.map(ref => ref.image_id).filter(Boolean),
          selectedIndexes: imageRefs.map(ref => ref.index),
          selectedImageIndexes: imageRefs.map(ref => ref.index),
          usePreviousImage: imageRefs.some(ref => ref.target === 'previous'),
        };
      }
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

  const api = Object.freeze({
    SCHEMA_VERSION,
    normalizeContractVersion,
    canonicalizeContractBindings,
    canonicalizeClarificationContract,
    contractApi,
    contractMode,
    hasExactContractShape,
    hasResolvedResourceBindings,
    mediaCandidates,
    resolveResourceCandidate,
    resolveMessageResource,
    messageCandidates,
    taskContractToExecutionResources,
    taskContractToExecutionPlan,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUICoreIntentContract = api;
  if (root?.window) root.window.ChatUICoreIntentContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
