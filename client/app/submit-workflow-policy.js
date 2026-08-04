(function initChatUISubmitWorkflowPolicy(root) {
  'use strict';

  const INTENT_PIPELINE_DEADLINE_MS = 60000;

  function parseOptionalMessageIndex(value) {
    if (value === null || value === undefined || typeof value === 'string' && !value.trim()) return null;
    const index = Number(value);
    return Number.isFinite(index) && index >= 0 ? index : null;
  }

  function createIntentPipelineTimeout() {
    const error = new Error('ROUTE_INTENT_TIMEOUT');
    error.code = 'ROUTE_INTENT_TIMEOUT';
    error.routeTimedOut = true;
    error.timeoutMs = INTENT_PIPELINE_DEADLINE_MS;
    return error;
  }

  function createBoundedIntentRequest(parentSignal = null, deadlineAt = 0) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let disposed = false;
    let rejectTerminal = null;
    const abortFromParent = () => controller?.abort?.();
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });
    const terminal = new Promise((resolve, reject) => { rejectTerminal = reject; });
    terminal.catch(() => {});
    const remaining = Math.max(0, Number(deadlineAt) - Date.now());
    const timer = setTimeout(() => {
      if (disposed) return;
      controller?.abort?.();
      rejectTerminal?.(createIntentPipelineTimeout());
    }, remaining);
    return {
      signal: controller?.signal || parentSignal || null,
      race: promise => Promise.race([Promise.resolve(promise), terminal]),
      dispose() {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        parentSignal?.removeEventListener?.('abort', abortFromParent);
      },
    };
  }

  function createPendingTransition(pending = null, decision = null) {
    return Object.freeze({
      pendingId: String(pending?.id || ''),
      consumeOnHandoff: !!pending && decision?.shouldClearPending === true,
    });
  }

  function buildPendingAssistancePresentation({
    pending = null,
    assistantReply = '',
    clarificationService = null,
    presentationApi = null,
    presentationOptions = {},
  } = {}) {
    const fallbackText = String(assistantReply || '').trim();
    const routeInfo = clarificationService?.pendingClarificationRouteInfo?.(pending);
    const presentation = fallbackText && routeInfo
      ? presentationApi?.buildClarificationPresentation?.({
        ...routeInfo,
        clarificationQuestion: fallbackText,
      }, presentationOptions)
      : null;
    const html = presentation?.hasImageChoices === true ? String(presentation.html || '') : '';
    const rawText = String(presentation?.rawText || fallbackText);
    return Object.freeze({
      displayContent: html || rawText,
      rawText,
      html,
      hasImageChoices: !!html,
    });
  }

  const api = Object.freeze({
    parseOptionalMessageIndex,
    createBoundedIntentRequest,
    createPendingTransition,
    buildPendingAssistancePresentation,
    INTENT_PIPELINE_DEADLINE_MS,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('submitWorkflowPolicy', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
