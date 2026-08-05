(function initChatUIRoutePayload(root) {
  'use strict';

  function createRoutePayloadBuilder({
    assertInputWithinUnifiedLimit = () => {},
    buildRouteResourceCandidates = () => [],
    publicRouteResourceCandidates = value => value,
    messageIdentity = () => '',
    repairInvariantSnapshot = () => null,
    readRouteReadiness = () => '',
    routeSystemPrompt = '',
    intentRepairSystemPrompt = '',
    routeResponseFormat = null,
  } = {}) {
  function routeAttachmentType(item = {}) {
    const mime = String(item?.type || item?.mime || item?.file?.type || '').toLowerCase();
    const isImage = item?.is_image === true || item?.isImage === true || mime.startsWith('image/');
    return isImage ? 'image' : 'file';
  }

  function routeAttachmentDescriptor(item = {}, type = routeAttachmentType(item), fallbackIndex = 0) {
    const image = type === 'image';
    return {
      type,
      id: String(image
        ? item?.image_id || item?.imageId || item?.id || item?.attachmentId || item?.attachment_id || ''
        : item?.file_id || item?.fileId || item?.id || item?.attachmentId || item?.attachment_id || ''),
      referenceId: String(item?.reference_id || item?.referenceId || ''),
      sourceIndex: Number(image
        ? item?.media_index || item?.mediaIndex || item?.source_index || item?.sourceIndex
        : item?.source_index || item?.sourceIndex || item?.media_index || item?.mediaIndex) || fallbackIndex,
      name: String(item?.name || item?.filename || item?.file?.name || '').trim().toLocaleLowerCase(),
    };
  }

  function routeContextCandidateDescriptor(item = {}, type = '') {
    return {
      type,
      id: String(type === 'image'
        ? item?.image_id || item?.imageId || ''
        : item?.file_id || item?.fileId || item?.id || ''),
      referenceId: String(item?.reference_id || item?.referenceId || ''),
      sourceIndex: Number(item?.source_index || item?.sourceIndex || item?.index) || 0,
      name: String(item?.name || item?.filename || '').trim().toLocaleLowerCase(),
    };
  }

  function routeAttachmentMatchesCandidate(attachment = {}, candidate = {}) {
    if (attachment.type !== candidate.type) return false;
    if (attachment.id && candidate.id && attachment.id === candidate.id) return true;
    if (attachment.referenceId && candidate.referenceId
        && attachment.referenceId === candidate.referenceId
        && attachment.sourceIndex === candidate.sourceIndex) return true;
    return attachment.sourceIndex > 0
      && attachment.sourceIndex === candidate.sourceIndex
      && !!attachment.name
      && attachment.name === candidate.name;
  }

  function markedCurrentUserMessageIndex(messages = [], currentTurn = null) {
    if (!currentTurn || typeof currentTurn !== 'object') return 0;
    const expectedIndex = Number(currentTurn.message_index ?? currentTurn.messageIndex);
    const expectedId = String(currentTurn.message_id || currentTurn.messageId || currentTurn.id || '');
    if (expectedId) {
      const byId = messages.find(message => message?.role === 'user' && messageIdentity(message) === expectedId);
      if (byId && (!Number.isInteger(expectedIndex) || expectedIndex < 1 || Number(byId.index) === expectedIndex)) {
        return Number(byId.index) || 0;
      }
    }
    if (!Number.isInteger(expectedIndex) || expectedIndex < 1) return 0;
    const byIndex = messages.find(message => message?.role === 'user' && Number(message?.index) === expectedIndex);
    // Context trimming may remove the message row before its media candidates.
    // An explicit caller marker still identifies those candidates by stable index.
    if (!byIndex) return expectedIndex;
    const actualId = messageIdentity(byIndex);
    return expectedId && actualId && expectedId !== actualId ? 0 : expectedIndex;
  }

  function exactInputCurrentUserMessageIndex(messages = [], input = '') {
    const currentInput = String(input || '').trim();
    if (!currentInput) return 0;
    const latestUser = [...messages].reverse().find(message => message?.role === 'user');
    if (!latestUser || String(latestUser.content || '').trim() !== currentInput) return 0;
    const messageIndex = Number(latestUser.index);
    return Number.isInteger(messageIndex) && messageIndex > 0 ? messageIndex : 0;
  }

  function attachmentMatchedCurrentUserMessageIndex(context = {}, messages = [], attachments = []) {
    const descriptors = (Array.isArray(attachments) ? attachments : [])
      .map((item, index) => routeAttachmentDescriptor(item, routeAttachmentType(item), index + 1));
    if (!descriptors.length) return 0;
    const latestUser = [...messages].reverse().find(message => message?.role === 'user');
    const messageIndex = Number(latestUser?.index);
    if (!Number.isInteger(messageIndex) || messageIndex < 1) return 0;
    const contextual = [
      ...(Array.isArray(context?.image_candidates) ? context.image_candidates.map(item => ({ item, type: 'image' })) : []),
      ...(Array.isArray(context?.file_candidates) ? context.file_candidates.map(item => ({ item, type: 'file' })) : []),
    ].filter(({ item }) => Number(item?.message_index || item?.messageIndex) === messageIndex)
      .map(({ item, type }) => routeContextCandidateDescriptor(item, type));
    if (!contextual.length) return 0;
    const used = new Set();
    for (const attachment of descriptors) {
      const matchIndex = contextual.findIndex((candidate, index) => !used.has(index) && routeAttachmentMatchesCandidate(attachment, candidate));
      if (matchIndex < 0) return 0;
      used.add(matchIndex);
    }
    return messageIndex;
  }

  function currentTurnCandidate(candidate = {}, type = '', currentMessageIndex = 0, attachments = []) {
    const messageIndex = Number(candidate?.message_index || candidate?.messageIndex) || 0;
    if (currentMessageIndex && messageIndex === currentMessageIndex) return true;
    if (String(candidate?.source || '') !== 'current') return false;
    const descriptor = routeContextCandidateDescriptor(candidate, type);
    return (Array.isArray(attachments) ? attachments : []).some((item, index) => (
      routeAttachmentMatchesCandidate(routeAttachmentDescriptor(item, routeAttachmentType(item), index + 1), descriptor)
    ));
  }

  function buildFileCandidatesFromAttachments(attachments = []) {
    return (attachments || [])
      .filter(item => item && routeAttachmentType(item) === 'file')
      .map((item, index) => {
        const extractedText = item.has_extracted_text ?? item.hasExtractedText;
        const inputFileAvailable = item.input_file_available === true || item.inputFileAvailable === true;
        return {
          index: Number(item.media_index || item.mediaIndex) || index + 1,
          source_index: Number(item.source_index || item.sourceIndex) || index + 1,
          source: ['quoted', 'history', 'context'].includes(String(item.routeSource || item.route_source || ''))
            ? String(item.routeSource || item.route_source)
            : 'current',
          target: 'uploaded',
          file_id: item.file_id || item.id || item.attachmentId || item.attachment_id || '',
          name: item.name || 'attachment',
          type: item.type || '',
          size: Number(item.size) || 0,
          ...(extractedText !== undefined ? { has_extracted_text: !!extractedText } : {}),
          ...(inputFileAvailable ? { input_file_available: true } : {}),
          unsupported_reason: item.unsupported_reason || item.unsupportedReason || '',
        };
      });
  }

  function compactRoutePayloadContext(context = {}, input = '', attachments = [], currentTurn = null) {
    const next = context && typeof context === 'object' ? { ...context } : {};
    const currentFiles = buildFileCandidatesFromAttachments(attachments);
    let messages = Array.isArray(next.recent_messages) ? [...next.recent_messages] : [];
    // The caller-supplied turn marker is authoritative. Attachment identity is a
    // safe fallback for direct service callers and attachment-only turns. Prompt
    // attachment placeholders or prefixes are deliberately not parsed as identity:
    // empty text and formatting differences must not turn the current upload into history.
    // Exact text equality remains only as a compatibility fallback for direct callers.
    const currentMessageIndex = markedCurrentUserMessageIndex(messages, currentTurn)
      || attachmentMatchedCurrentUserMessageIndex(next, messages, attachments)
      || exactInputCurrentUserMessageIndex(messages, input);
    if (currentMessageIndex) {
      messages = messages.filter(message => !(message?.role === 'user' && Number(message?.index) === currentMessageIndex));
    }
    const historicalImages = Array.isArray(next.image_candidates)
      ? next.image_candidates
        .filter(candidate => !currentTurnCandidate(candidate, 'image', currentMessageIndex, attachments))
        .map(candidate => candidate?.source === 'user_message'
          ? { ...candidate, source: 'history' }
          : candidate)
      : [];
    const historicalFiles = Array.isArray(next.file_candidates)
      ? next.file_candidates
        .filter(candidate => !currentTurnCandidate(candidate, 'file', currentMessageIndex, attachments))
        .map(candidate => candidate?.source === 'user_message'
          ? { ...candidate, source: 'history' }
          : candidate)
      : [];
    // Current attachments are catalogued from the authoritative attachment list.
    // Their persisted message candidates are removed above so candidate keys stay
    // stable and one physical upload cannot appear as both history and current.
    next.image_candidates = historicalImages;
    next.file_candidates = currentFiles.length ? [...historicalFiles, ...currentFiles] : historicalFiles;
    next.recent_messages = messages;
    return next;
  }

  function catalogCandidateMatchesResource(candidate = {}, resource = {}) {
    if (String(candidate.type || '') !== String(resource.type || '')) return false;
    const candidateId = String(candidate.id || '');
    const resourceId = String(resource.id || '');
    if (candidateId && resourceId) return candidateId === resourceId;
    const candidateReference = String(candidate.reference_id || '');
    const resourceReference = String(resource.reference_id || '');
    if (candidateReference && resourceReference) {
      return candidateReference === resourceReference
        && Number(candidate.index) === Number(resource.index);
    }
    if ((candidateId || candidateReference) && (resourceId || resourceReference)) return false;
    return String(candidate.source || '') === String(resource.source || '')
      && Number(candidate.index) === Number(resource.index);
  }

  function pendingPublicContext(clarification = {}, catalog = []) {
    const pending = clarification?.pending_task && typeof clarification.pending_task === 'object'
      ? clarification.pending_task
      : null;
    if (!pending) return null;
    const prior = pending.prior_task_contract && typeof pending.prior_task_contract === 'object'
      ? pending.prior_task_contract
      : null;
    const priorSemantic = pending.prior_semantic_task && typeof pending.prior_semantic_task === 'object'
      ? pending.prior_semantic_task
      : null;
    const candidateFor = resource => {
      const matches = catalog.filter(candidate => catalogCandidateMatchesResource(candidate, resource));
      return matches.length === 1 ? matches[0] : null;
    };
    const bindings = (Array.isArray(prior?.resources) ? prior.resources : [])
      .filter(resource => resource && resource.type !== 'text' && resource.missing !== true)
      .map(resource => ({ resource, candidate: candidateFor(resource) }))
      .filter(item => item.candidate)
      .map(({ resource, candidate }) => ({
        kind: String(resource.type || ''),
        purpose: String(resource.role || ''),
        candidate_key: candidate.candidate_key,
      }));
    const unresolvedSource = Array.isArray(pending.unresolved_resources)
      ? pending.unresolved_resources
      : Array.isArray(prior?.clarification?.unresolved_resources) ? prior.clarification.unresolved_resources : [];
    const unresolved = unresolvedSource.map(slot => {
      const choices = (Array.isArray(slot?.choices) ? slot.choices : [])
        .map(choice => candidateFor({ ...choice, type: slot.type }))
        .filter(Boolean)
        .map(candidate => ({ candidate_key: candidate.candidate_key, label: candidate.label }));
      return {
        kind: String(slot?.type || ''),
        purpose: String(slot?.role || ''),
        resolution: choices.length >= 2 ? 'ambiguous' : String(slot?.reason || 'missing'),
        candidate_keys: choices.map(choice => choice.candidate_key),
        labels: choices.map(choice => choice.label),
      };
    });
    const requirements = (Array.isArray(priorSemantic?.slots) ? priorSemantic.slots : [])
      .filter(slot => slot && slot.resolution !== 'bound')
      .map(slot => ({
        kind: String(slot.kind || ''),
        purpose: String(slot.purpose || ''),
        label: String(slot.label || ''),
        resolution: String(slot.resolution || ''),
      }));
    return {
      schema_version: String(clarification.schema_version || ''),
      pending_task: {
        base_input: String(pending.base_input || ''),
        supplements: Array.isArray(pending.supplements) ? pending.supplements.map(value => String(value || '')) : [],
        question: String(pending.question || ''),
        prior_actions: Array.isArray(priorSemantic?.actions) ? priorSemantic.actions.map(value => String(value || '')) : [],
        established_bindings: bindings,
        requirements,
        unresolved,
        established_changes: Array.isArray(prior?.directive?.operations)
          ? prior.directive.operations.map(change => ({ ...change }))
          : [],
        established_constraints: Array.isArray(prior?.directive?.constraints)
          ? prior.directive.constraints.map(value => String(value || ''))
          : [],
      },
    };
  }

  function publicRouteContext(context = {}, catalog = []) {
    const next = context && typeof context === 'object' ? { ...context } : {};
    if (next.clarification_context) {
      const clarification = pendingPublicContext(next.clarification_context, catalog);
      if (clarification) next.clarification_context = clarification;
      else delete next.clarification_context;
    }
    return next;
  }

  function compactRouteUserPayload({ input = '', attachments = [], context = {}, currentMode = 'chat', autoMode = true, currentTurn = null } = {}) {
    const currentInput = String(input || '');
    assertInputWithinUnifiedLimit(currentInput);
    const routeContext = compactRoutePayloadContext(context, currentInput, attachments, currentTurn);
    const payload = { current_input: currentInput };
    const normalizedMode = ['chat', 'image', 'edit_image'].includes(currentMode) ? currentMode : 'chat';
    if (autoMode === false) {
      payload.current_mode = normalizedMode;
      payload.auto_mode = false;
    }
    if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
    const resourceCandidates = buildRouteResourceCandidates({ attachments, context: routeContext });
    if (resourceCandidates.length) payload.resource_candidates = publicRouteResourceCandidates(resourceCandidates);
    const modelContext = publicRouteContext(routeContext, resourceCandidates);
    const compactContext = Object.fromEntries(Object.entries(modelContext || {}).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      if (!value) return false;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return true;
    }));
    if (Object.keys(compactContext).length) payload.context = compactContext;
    return payload;
  }

  function buildRoutePayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, currentTurn = null, systemPrompt = routeSystemPrompt, responseFormat = routeResponseFormat } = {}) {
    const userPayload = compactRouteUserPayload({ input, attachments, context, currentMode, autoMode, currentTurn });
    return {
      model,
      temperature: 0,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
    };
  }

  function buildIntentRepairPayload({ model, previousOutput = '', validationReason = 'contract_shape', responseFormat = routeResponseFormat } = {}) {
    const repairInvariants = repairInvariantSnapshot(previousOutput);
    if (!repairInvariants) throw new TypeError('A complete semantic invariant is required for repair');
    const payload = {
      previous_semantic_output: String(previousOutput || ''),
      validation_error: String(validationReason || 'contract_shape'),
      repair_invariants: repairInvariants,
    };
    return {
      model,
      temperature: 0,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      messages: [
        { role: 'system', content: intentRepairSystemPrompt },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    };
  }

  function extractRouteText(response = {}) {
    return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
  }

    return Object.freeze({
      buildFileCandidatesFromAttachments,
      compactRoutePayloadContext,
      publicRouteContext,
      compactRouteUserPayload,
      buildRoutePayload,
      buildIntentRepairPayload,
      extractRouteText,
    });
  }

  const api = Object.freeze({ createRoutePayloadBuilder });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routePayload', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
