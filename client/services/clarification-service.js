(function initChatUIClarificationService(root) {
  'use strict';

  const CLARIFICATION_CONTEXT_VERSION = 'clarification_context.v3';
  const CLARIFICATION_REPLAY_VERSION = 'clarification_replay.v1';

  function textOfMessage(message = {}) {
    return String(message.rawText || message.content || '').trim();
  }

  function latestUserMessage(messages = []) {
    for (let index = (Array.isArray(messages) ? messages.length : 0) - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === 'user') return { message, index, text: textOfMessage(message) };
    }
    return null;
  }

  function routeClarificationSlots(routeInfo = null) {
    if (!routeInfo || typeof routeInfo !== 'object' || Array.isArray(routeInfo)) return [];
    const direct = routeInfo.clarificationSlots;
    if (Array.isArray(direct) && direct.length) return direct;
    const contractSlots = routeInfo.taskContract?.clarification?.unresolved_resources;
    return Array.isArray(contractSlots) ? contractSlots : [];
  }

  function pendingUnresolvedResources(value = null) {
    const pending = normalizePendingClarification(value);
    return routeClarificationSlots(pending?.routeInfo);
  }

  function compactRouteInfo(routeInfo = null) {
    if (!routeInfo || typeof routeInfo !== 'object' || Array.isArray(routeInfo)) return null;
    return {
      mode: String(routeInfo.mode || ''),
      api: String(routeInfo.api || ''),
      operationType: String(routeInfo.operationType || routeInfo.operation_type || ''),
      relation: String(routeInfo.relation || ''),
      readiness: String(routeInfo.readiness || ''),
      needClarification: routeInfo.needClarification === true,
      clarificationQuestion: String(routeInfo.clarificationQuestion || ''),
      clarificationSlots: routeClarificationSlots(routeInfo),
      taskContract: routeInfo.taskContract && typeof routeInfo.taskContract === 'object'
        ? routeInfo.taskContract
        : null,
      semanticTask: routeInfo.semanticTask && typeof routeInfo.semanticTask === 'object'
        ? routeInfo.semanticTask
        : null,
      clarificationDegraded: routeInfo.clarificationDegraded === true,
      requiresRerouteAfterClarification: routeInfo.requiresRerouteAfterClarification === true,
    };
  }

  function pendingClarificationRouteInfo(value = null) {
    const pending = normalizePendingClarification(value);
    if (!pending) return null;
    const routeInfo = pending.routeInfo || {};
    return {
      ...routeInfo,
      needClarification: true,
      clarificationQuestion: pending.clarificationText
        || routeInfo.clarificationQuestion
        || routeInfo.taskContract?.clarification?.question
        || '',
      clarificationSlots: routeClarificationSlots(routeInfo),
    };
  }

  function matchesPendingClarificationMessage(value = null, { message = null, userText = '' } = {}) {
    const pending = normalizePendingClarification(value);
    if (!pending || !message || message.role !== 'assistant') return false;
    const messageClarificationId = String(message.clarificationId || message.clarification_id || '').trim();
    if (messageClarificationId) return messageClarificationId === pending.id;
    const messageText = textOfMessage(message);
    return !!messageText
      && messageText === pending.clarificationText
      && String(userText || '').trim() === pending.originalText;
  }

  function attachmentContextObject(value = null) {
    if (!value || typeof value !== 'object' && typeof value !== 'string') return null;
    if (typeof value === 'object') return Array.isArray(value) ? null : value;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function normalizePendingAttachmentContexts(value = null, fallback = null) {
    const candidates = [
      ...(Array.isArray(value) ? value : value ? [value] : []),
      ...(fallback ? [fallback] : []),
    ];
    const seen = new Set();
    const contexts = [];
    for (const candidate of candidates) {
      const context = attachmentContextObject(candidate);
      if (!Array.isArray(context?.attachments) || !context.attachments.length) continue;
      const key = JSON.stringify(context);
      if (seen.has(key)) continue;
      seen.add(key);
      contexts.push(context);
    }
    return contexts;
  }

  function attachmentIds(context = null) {
    return new Set((Array.isArray(context?.attachments) ? context.attachments : [])
      .map(item => String(item?.id || item?.attachmentId || item?.attachment_id || item?.fileId || item?.file_id || '').trim())
      .filter(Boolean));
  }

  function pendingRouteFileIds(routeInfo = null) {
    const taskContract = compactRouteInfo(routeInfo)?.taskContract || routeInfo?.taskContract || null;
    const ids = new Set();
    for (const resource of Array.isArray(taskContract?.resources) ? taskContract.resources : []) {
      if (resource?.type === 'file' && ['history', 'context'].includes(String(resource.source || '')) && resource.id) ids.add(String(resource.id));
    }
    for (const slot of routeClarificationSlots(routeInfo)) {
      if (slot?.type !== 'file') continue;
      for (const choice of Array.isArray(slot.choices) ? slot.choices : []) {
        if (['history', 'context'].includes(String(choice?.source || '')) && choice.id) ids.add(String(choice.id));
      }
    }
    return ids;
  }

  function collectPendingAttachmentContexts({ messages = [], routeInfo = null, sourceAttachmentContext = null } = {}) {
    const currentContexts = normalizePendingAttachmentContexts(sourceAttachmentContext);
    const requiredIds = pendingRouteFileIds(routeInfo);
    if (!requiredIds.size) return currentContexts;
    const historicalContexts = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.role !== 'user') continue;
      const context = attachmentContextObject(message.attachmentContext || message.attachment_context);
      const ids = attachmentIds(context);
      if ([...requiredIds].some(id => ids.has(id))) historicalContexts.push(context);
    }
    return normalizePendingAttachmentContexts([...currentContexts, ...historicalContexts]);
  }

  let clarificationIdSequence = 0;

  function createClarificationId() {
    const randomUuid = root?.crypto?.randomUUID?.();
    if (randomUuid) return `clarify-${randomUuid}`;
    clarificationIdSequence = (clarificationIdSequence + 1) % 0x100000;
    return `clarify-${Date.now().toString(36)}-${clarificationIdSequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizePendingClarification(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const originalText = String(value.originalText ?? value.original_text ?? value.baseTask ?? value.base_task ?? '').trim();
    const routeInfo = compactRouteInfo(value.routeInfo || value.route_info || null);
    if (!originalText && !routeInfo?.taskContract) return null;
    const sourceAttachmentContext = value.sourceAttachmentContext || value.source_attachment_context || null;
    return {
      // Normalization is intentionally identity-neutral. New pending records get
      // an id at creation, while imported legacy records are assigned one once by
      // migratePendingClarification and immediately persisted by the caller.
      id: String(value.id || ''),
      originalText,
      baseTaskText: String(value.baseTaskText || value.base_task_text || originalText).trim(),
      clarificationText: String(value.clarificationText || value.clarification_text || '').trim(),
      routeInfo,
      sourceImageContext: value.sourceImageContext || value.source_image_context || null,
      sourceAttachmentContext,
      sourceAttachmentContexts: normalizePendingAttachmentContexts(value.sourceAttachmentContexts || value.source_attachment_contexts || null, sourceAttachmentContext),
      sourceQuoteContext: value.sourceQuoteContext || value.source_quote_context || null,
      assistanceHistory: Array.isArray(value.assistanceHistory || value.assistance_history)
        ? (value.assistanceHistory || value.assistance_history).slice(-4)
        : [],
      supplements: Array.isArray(value.supplements)
        ? value.supplements.map(item => String(item || '').trim()).filter(Boolean).slice(-8)
        : [],
      createdAt: Number(value.createdAt || value.created_at) || Date.now(),
      updatedAt: Number(value.updatedAt || value.updated_at) || Date.now(),
      rounds: Math.max(1, Number(value.rounds || 1) || 1),
    };
  }

  function migratePendingClarification(value = null) {
    const normalized = normalizePendingClarification(value);
    if (!normalized || normalized.id) return normalized;
    return { ...normalized, id: createClarificationId() };
  }

  function createPendingClarification({
    messages = [],
    clarificationText = '',
    routeInfo = null,
    sourceImageContext = null,
    sourceAttachmentContext = null,
    sourceQuoteContext = null,
  } = {}) {
    const latestUser = latestUserMessage(messages);
    const attachmentContext = sourceAttachmentContext || latestUser?.message?.attachmentContext || latestUser?.message?.attachment_context || null;
    return normalizePendingClarification({
      id: createClarificationId(),
      originalText: latestUser?.text || '',
      baseTaskText: latestUser?.text || '',
      clarificationText,
      routeInfo,
      sourceImageContext: sourceImageContext || latestUser?.message?.imageContext || latestUser?.message?.image_context || null,
      sourceAttachmentContext: attachmentContext,
      sourceAttachmentContexts: collectPendingAttachmentContexts({ messages, routeInfo, sourceAttachmentContext: attachmentContext }),
      sourceQuoteContext: sourceQuoteContext || latestUser?.message?.quoteContext || latestUser?.message?.quote_context || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rounds: 1,
    });
  }

  function mergePendingInput(pending, { promptText = '' } = {}) {
    const normalized = normalizePendingClarification(pending);
    const supplementText = String(promptText || '').trim();
    if (!normalized || !supplementText) return { promptText: supplementText, merged: false, pending: normalized };
    const supplements = [...normalized.supplements, supplementText].filter(Boolean).slice(-8);
    const baseTaskText = normalized.baseTaskText || normalized.originalText;
    const executionInput = [baseTaskText, ...supplements].filter(Boolean).join('\n\n');
    const nextPending = normalizePendingClarification({
      ...normalized,
      originalText: normalized.originalText || baseTaskText,
      baseTaskText,
      supplements,
      updatedAt: Date.now(),
      rounds: normalized.rounds + 1,
    });
    return {
      promptText: executionInput,
      originalPromptText: normalized.originalText,
      supplementText,
      resolvedInput: executionInput,
      merged: true,
      pending: nextPending,
    };
  }

  function pendingAttachmentContexts(value = null) {
    return normalizePendingClarification(value)?.sourceAttachmentContexts || [];
  }

  function normalizeClarificationReplay(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const resolvedInput = String(value.resolvedInput || value.resolved_input || '').trim();
    if (!resolvedInput) return null;
    return {
      schemaVersion: CLARIFICATION_REPLAY_VERSION,
      originalInput: String(value.originalInput || value.original_input || value.baseTaskText || value.base_task_text || resolvedInput).trim(),
      resolvedInput,
      supplements: Array.isArray(value.supplements)
        ? value.supplements.map(item => String(item || '').trim()).filter(Boolean).slice(-8)
        : [],
      clarificationRouteContext: value.clarificationRouteContext || value.clarification_route_context || null,
      taskContract: value.taskContract && typeof value.taskContract === 'object' ? value.taskContract : null,
      routeMode: String(value.routeMode || value.route_mode || ''),
      api: String(value.api || ''),
      sourceImageContext: value.sourceImageContext || value.source_image_context || null,
      sourceAttachmentContext: value.sourceAttachmentContext || value.source_attachment_context || null,
      sourceQuoteContext: value.sourceQuoteContext || value.source_quote_context || null,
      createdAt: Number(value.createdAt || value.created_at) || Date.now(),
    };
  }

  function createClarificationReplay({ pending = null, merge = null, routeInfo = null, clarificationRouteContext = null } = {}) {
    const normalized = normalizePendingClarification(pending);
    const resolvedInput = String(merge?.resolvedInput || merge?.promptText || '').trim();
    if (!normalized || !resolvedInput) return null;
    return normalizeClarificationReplay({
      originalInput: normalized.baseTaskText || normalized.originalText,
      resolvedInput,
      supplements: merge?.pending?.supplements || normalized.supplements,
      clarificationRouteContext,
      taskContract: routeInfo?.taskContract || null,
      routeMode: routeInfo?.mode || '',
      api: routeInfo?.api || '',
      sourceImageContext: normalized.sourceImageContext,
      sourceAttachmentContext: normalized.sourceAttachmentContext,
      sourceQuoteContext: normalized.sourceQuoteContext,
      createdAt: Date.now(),
    });
  }

  function reviseClarificationReplay(replay, replacement = '') {
    const normalized = normalizeClarificationReplay(replay);
    const next = String(replacement || '').trim();
    if (!normalized || !next) return normalized;
    const supplements = normalized.supplements.length
      ? [...normalized.supplements.slice(0, -1), next]
      : [next];
    return normalizeClarificationReplay({
      ...normalized,
      supplements,
      // This is deliberately plain user text. The complete router still decides execution.
      resolvedInput: [normalized.originalInput, ...supplements].filter(Boolean).join('\n\n'),
      createdAt: Date.now(),
    });
  }

  function retainPendingAfterAssistance(pending, { promptText = '', assistantReply = '' } = {}) {
    const normalized = normalizePendingClarification(pending);
    const reply = String(assistantReply || '').trim();
    if (!normalized || !reply) return null;
    return normalizePendingClarification({
      ...normalized,
      assistanceHistory: [
        ...normalized.assistanceHistory,
        { prompt: String(promptText || '').trim(), reply, at: Date.now() },
      ].slice(-4),
      updatedAt: Date.now(),
      rounds: normalized.rounds + 1,
    });
  }

  function candidateIdentity(candidate = {}, type = '') {
    const id = type === 'image'
      ? candidate.image_id || candidate.imageId || ''
      : candidate.file_id || candidate.fileId || candidate.id || '';
    return [candidate.source || '', id, candidate.reference_id || candidate.referenceId || '', candidate.source_index || candidate.sourceIndex || ''].join('|');
  }

  function mergeCandidates(base = [], quoted = [], type = '') {
    const result = [];
    const seen = new Set();
    for (const candidate of [...(Array.isArray(base) ? base : []), ...(Array.isArray(quoted) ? quoted : [])]) {
      if (!candidate || typeof candidate !== 'object') continue;
      const identity = candidateIdentity(candidate, type);
      if (identity && seen.has(identity)) continue;
      if (identity) seen.add(identity);
      result.push({ ...candidate, index: result.length + 1 });
    }
    return result;
  }

  function mergeQuotedMessageContext(baseContext = {}, quotedContext = null) {
    const context = { ...baseContext };
    if (!quotedContext || typeof quotedContext !== 'object') return context;
    const recent = Array.isArray(context.recent_messages) ? [...context.recent_messages] : [];
    const quote = quotedContext.quoted_message && typeof quotedContext.quoted_message === 'object'
      ? quotedContext.quoted_message
      : null;
    if (quote) {
      const quoteId = String(quote.id || quote.display_item_id || quote.displayItemId || '');
      let match = quoteId ? recent.find(message => String(message?.id || message?.display_item_id || message?.displayItemId || '') === quoteId) : null;
      if (!match) {
        const quotedMessage = Array.isArray(quotedContext.recent_messages) ? quotedContext.recent_messages[0] : null;
        if (quotedMessage) {
          const nextIndex = recent.reduce((max, message) => Math.max(max, Number(message?.index) || 0), 0) + 1;
          match = { ...quotedMessage, index: nextIndex, ...(quoteId ? { id: quoteId } : {}) };
          recent.push(match);
        }
      }
      if (match) context.quoted_message = { ...quote, index: Number(match.index), ...(quoteId ? { id: quoteId } : {}) };
    }
    context.recent_messages = recent;
    context.image_candidates = mergeCandidates(context.image_candidates, quotedContext.image_candidates, 'image');
    context.file_candidates = mergeCandidates(context.file_candidates, quotedContext.file_candidates, 'file');
    return context;
  }

  function priorResourceSources(taskContract = null, fallbackUnresolved = []) {
    const contract = taskContract && typeof taskContract === 'object' ? taskContract : null;
    const bound = Array.isArray(contract?.resources) ? contract.resources : [];
    const contractUnresolved = contract?.clarification?.unresolved_resources;
    const unresolved = Array.isArray(contractUnresolved) && contractUnresolved.length
      ? contractUnresolved
      : Array.isArray(fallbackUnresolved) ? fallbackUnresolved : [];
    return [
      ...bound.map(resource => ({
        resource_key: String(resource?.key || ''), type: String(resource?.type || ''), role: String(resource?.role || ''),
        source: String(resource?.source || ''), index: Number(resource?.index) || 0,
        id: String(resource?.id || ''), reference_id: String(resource?.reference_id || ''),
      })),
      ...unresolved.flatMap(slot => (Array.isArray(slot?.choices) ? slot.choices : []).map(choice => ({
        resource_key: String(slot?.key || ''), type: String(slot?.type || ''), role: String(slot?.role || ''),
        source: String(choice?.source || ''), index: Number(choice?.index) || 0,
        id: String(choice?.id || ''), reference_id: String(choice?.reference_id || ''),
      }))),
    ];
  }

  function pendingResourceOrigins(value = null) {
    const normalized = normalizePendingClarification(value);
    if (!normalized) return [];
    const resources = priorResourceSources(
      normalized.routeInfo?.taskContract,
      pendingUnresolvedResources(normalized),
    );
    const seen = new Set();
    return resources.filter(resource => {
      const source = resource.source === 'current' ? 'history' : resource.source;
      resource.source = ['quoted', 'history', 'context'].includes(source) ? source : 'history';
      const identity = [resource.type, resource.id, resource.reference_id, resource.index, resource.role].join('|');
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }

  function buildClarificationRouteContext({
    baseContext = {},
    quotedContext = null,
    pending,
  } = {}) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized) return null;
    const context = mergeQuotedMessageContext(
      baseContext && typeof baseContext === 'object' ? baseContext : {},
      quotedContext,
    );
    context.clarification_context = {
      schema_version: CLARIFICATION_CONTEXT_VERSION,
      pending_task: {
        base_input: normalized.baseTaskText || normalized.originalText,
        supplements: [...normalized.supplements],
        question: normalized.clarificationText,
        prior_semantic_task: normalized.routeInfo?.semanticTask || null,
        prior_task_contract: normalized.routeInfo?.taskContract || null,
        unresolved_resources: pendingUnresolvedResources(normalized),
      },
    };
    return context;
  }

  const api = Object.freeze({
    CLARIFICATION_CONTEXT_VERSION,
    CLARIFICATION_REPLAY_VERSION,
    createClarificationId,
    normalizePendingClarification,
    migratePendingClarification,
    collectPendingAttachmentContexts,
    pendingAttachmentContexts,
    createPendingClarification,
    pendingClarificationRouteInfo,
    matchesPendingClarificationMessage,
    mergePendingInput,
    retainPendingAfterAssistance,
    normalizeClarificationReplay,
    createClarificationReplay,
    reviseClarificationReplay,
    pendingResourceOrigins,
    buildClarificationRouteContext,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIClarificationService = api;
  if (root?.window) root.window.ChatUIClarificationService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
