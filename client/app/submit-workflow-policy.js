(function initChatUISubmitWorkflowPolicy(root) {
  'use strict';

  const INTENT_PIPELINE_DEADLINE_MS = 60000;

  function parseOptionalMessageIndex(value) {
    if (value === null || value === undefined || typeof value === 'string' && !value.trim()) return null;
    const index = Number(value);
    return Number.isFinite(index) && index >= 0 ? index : null;
  }

  function createIntentPipelineTimeout(deadlineAt = 0) {
    const error = new Error('ROUTE_INTENT_TIMEOUT');
    error.code = 'ROUTE_INTENT_TIMEOUT';
    error.routeTimedOut = true;
    error.timeoutMs = Math.max(0, Number(deadlineAt) - Date.now());
    return error;
  }

  function createIntentPipelineCancellation() {
    const error = new Error('Intent recognition cancelled');
    error.name = 'AbortError';
    error.code = 'ROUTE_INTENT_CANCELLED';
    error.routeCancelled = true;
    return error;
  }

  function createBoundedIntentRequest(parentSignal = null, deadlineAt = 0) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const normalizedDeadlineAt = Number(deadlineAt) > 0
      ? Number(deadlineAt)
      : Date.now() + INTENT_PIPELINE_DEADLINE_MS;
    let disposed = false;
    let timedOut = false;
    let cancelled = false;
    let rejectTerminal = null;
    const terminal = new Promise((resolve, reject) => { rejectTerminal = reject; });
    terminal.catch(() => {});

    const rejectTerminalOnce = error => {
      if (disposed) return;
      rejectTerminal?.(error);
      rejectTerminal = null;
    };
    const abortFromParent = () => {
      if (disposed || cancelled || timedOut) return;
      cancelled = true;
      controller?.abort?.();
      rejectTerminalOnce(createIntentPipelineCancellation());
    };
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });

    const expire = () => {
      if (disposed || cancelled || timedOut) return false;
      timedOut = true;
      controller?.abort?.();
      rejectTerminalOnce(createIntentPipelineTimeout(normalizedDeadlineAt));
      return true;
    };
    const timer = setTimeout(() => {
      expire();
    }, Math.max(0, normalizedDeadlineAt - Date.now()));

    const assertActive = () => {
      if (cancelled || parentSignal?.aborted) {
        abortFromParent();
        throw createIntentPipelineCancellation();
      }
      if (timedOut || Date.now() >= normalizedDeadlineAt) {
        expire();
        throw createIntentPipelineTimeout(normalizedDeadlineAt);
      }
    };
    return {
      signal: controller?.signal || parentSignal || null,
      deadlineAt: normalizedDeadlineAt,
      get timedOut() { return timedOut; },
      get cancelled() { return cancelled; },
      isExpired: () => timedOut || Date.now() >= normalizedDeadlineAt,
      assertActive,
      race: promise => {
        try {
          assertActive();
        } catch (error) {
          // The caller may have created the attempt before this final deadline
          // check. Observe its rejection so the canonical timeout does not
          // become an unhandled rejection.
          if (promise && typeof promise.then === 'function') {
            try { Promise.resolve(promise).catch(() => {}); } catch {}
          }
          return Promise.reject(error);
        }
        return Promise.race([Promise.resolve(promise), terminal]);
      },
      raceFactory: factory => {
        try {
          assertActive();
        } catch (error) {
          return Promise.reject(error);
        }
        let promise;
        try {
          promise = typeof factory === 'function' ? factory() : factory;
        } catch (error) {
          promise = Promise.reject(error);
        }
        return Promise.race([Promise.resolve(promise), terminal]);
      },
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
    createIntentPipelineTimeout,
    createIntentPipelineCancellation,
    createPendingTransition,
    buildPendingAssistancePresentation,
    INTENT_PIPELINE_DEADLINE_MS,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('submitWorkflowPolicy', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
