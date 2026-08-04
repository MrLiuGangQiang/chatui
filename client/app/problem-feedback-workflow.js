(function initChatUIProblemFeedbackWorkflow(root) {
  'use strict';

  const registry = root?.[Symbol.for('chatui.module-registry.v1')];
  const core = registry?.get('problemFeedbackCore')
    || (typeof require === 'function' ? require('../core/problem-feedback') : {});
  const EVENT_NAME = 'chatui:problem-feedback';
  const FETCH_WRAPPER = Symbol.for('chatui.problem-feedback.fetch-wrapper.v1');
  const DEDUPE_WINDOW_MS = 2500;
  const FEEDBACK_DELAY_MS = 5000;
  const MAX_PENDING = 8;
  const FAILURE_MESSAGE_RE = /失败|错误|异常|不可用|不存在|无效|超时|断开|无法|拒绝|未正常/i;

  function createProblemFeedbackWorkflow(options = {}) {
    const browser = options.root || root;
    const now = options.now || Date.now;
    const schedule = options.setTimeout || browser?.setTimeout?.bind(browser) || setTimeout;
    const feedbackDelayMs = Math.max(0, Number(options.feedbackDelayMs ?? FEEDBACK_DELAY_MS));
    const pending = [];
    const recentFingerprints = new Map();
    let getActiveSession = () => null;
    let installed = false;
    let sequence = 0;

    function configure(config = {}) {
      if (typeof config.getActiveSession === 'function') getActiveSession = config.getActiveSession;
      return api;
    }

    function currentSession() {
      try { return getActiveSession?.() || null; } catch { return null; }
    }

    function isFunctionalRequest(input = {}) {
      const method = String(input.method || 'GET').trim().toUpperCase();
      const url = core.sanitizeRequestUrl?.(input.url || '', browser?.location?.href || '') || String(input.url || '');
      if (/^\/api(?:\/|$)/.test(url)) return true;
      return !['GET', 'HEAD', 'OPTIONS'].includes(method);
    }

    function shouldIgnore(input = {}) {
      const error = input.error;
      const message = String(input.message || error?.message || error || '');
      if (error?.name === 'AbortError' || /\babort(?:ed)?\b|用户停止|主动停止|页面卸载/i.test(message)) return true;
      if (input.kind === 'resource') return true;
      if (input.source === 'fetch' && !isFunctionalRequest(input)) return true;
      const url = core.sanitizeRequestUrl?.(input.url || '', browser?.location?.href || '') || String(input.url || '');
      return /\/api\/usage\/feedback(?:\/|$)/.test(url);
    }

    function pruneRecent(timestamp) {
      for (const [key, value] of recentFingerprints) {
        if (timestamp - value > DEDUPE_WINDOW_MS) recentFingerprints.delete(key);
      }
    }

    function isDuplicate(incident, timestamp) {
      pruneRecent(timestamp);
      const fingerprint = core.incidentFingerprint?.(incident) || String(incident.message || '');
      if (recentFingerprints.has(fingerprint)) return true;
      const normalizedMessage = String(incident.message || '').trim().toLowerCase();
      if (normalizedMessage) {
        for (const [key, value] of recentFingerprints) {
          if (timestamp - value <= DEDUPE_WINDOW_MS && key.endsWith(`|${normalizedMessage}`)) return true;
        }
      }
      recentFingerprints.set(fingerprint, timestamp);
      return false;
    }

    function dispatch(incident) {
      if (typeof browser?.dispatchEvent !== 'function') return;
      try {
        const CustomEventCtor = browser.CustomEvent || globalThis.CustomEvent;
        if (typeof CustomEventCtor === 'function') browser.dispatchEvent(new CustomEventCtor(EVENT_NAME, { detail: incident }));
        else browser.dispatchEvent({ type: EVENT_NAME, detail: incident });
      } catch {}
    }

    function report(input = {}) {
      if (shouldIgnore(input)) return null;
      const timestamp = now();
      const normalized = core.normalizeIncident?.({ ...input, occurredAt: input.occurredAt || timestamp, baseUrl: browser?.location?.href || '' }) || { ...input };
      if (isDuplicate(normalized, timestamp)) return null;
      const incident = Object.freeze({
        ...normalized,
        id: normalized.id || `incident-${timestamp.toString(36)}-${(++sequence).toString(36)}`,
        deliverAt: timestamp + feedbackDelayMs,
      });
      pending.push(incident);
      if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
      schedule(() => {
        if (pending.some(item => item.id === incident.id)) dispatch(incident);
      }, feedbackDelayMs);
      return incident;
    }

    function reportError(error, context = {}) {
      return report({ ...context, error, message: context.message || error?.message || String(error || ''), kind: context.kind || 'runtime' });
    }

    function reportUserVisibleMessage(message, context = {}) {
      const text = String(message || '').trim();
      if (!text || !FAILURE_MESSAGE_RE.test(text)) return null;
      return report({ ...context, kind: context.kind || 'ui', message: text });
    }

    function createDraft(incident) {
      return core.buildIncidentDraft?.(incident, currentSession()) || { problem: '', reproduction: '', expected: '' };
    }

    function createManualDraft() {
      const reproduction = core.buildConversationExcerpt?.(currentSession(), {
        maxRounds: core.DEFAULT_RECENT_ROUNDS || 3,
        maxChars: 1320,
        messageMaxChars: 180,
      }) || '';
      return {
        problem: '',
        reproduction,
        expected: '',
      };
    }

    function acknowledge(id = '') {
      const index = pending.findIndex(item => item.id === id);
      if (index >= 0) pending.splice(index, 1);
    }

    function consumePending() {
      return pending.splice(0, pending.length);
    }

    function consumeReadyPending() {
      const timestamp = now();
      const ready = [];
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (Number(pending[index]?.deliverAt || 0) > timestamp) continue;
        ready.unshift(...pending.splice(index, 1));
      }
      return ready;
    }

    function requestDetails(resource, init = {}) {
      const request = typeof Request !== 'undefined' && resource instanceof Request ? resource : null;
      return {
        method: String(init?.method || request?.method || 'GET').toUpperCase(),
        url: core.sanitizeRequestUrl?.(request?.url || resource?.url || resource || '', browser?.location?.href || '') || String(resource || ''),
      };
    }

    function monitorFetch() {
      const currentFetch = browser?.fetch;
      if (typeof currentFetch !== 'function' || currentFetch[FETCH_WRAPPER]) return;
      const originalFetch = currentFetch.bind(browser);
      const monitoredFetch = async function monitoredFetch(resource, init) {
        const request = requestDetails(resource, init);
        try {
          const response = await originalFetch(resource, init);
          if (!response?.ok) {
            const base = {
              kind: 'http',
              source: 'fetch',
              ...request,
              status: response?.status,
              statusText: response?.statusText,
            };
            if (shouldIgnore(base)) return response;
            try {
              const clone = response.clone?.();
              if (clone?.text) {
                clone.text()
                  .then(text => report({ ...base, responseText: text, message: core.responseMessage?.(text) || '' }))
                  .catch(() => report(base));
              } else report(base);
            } catch {
              report(base);
            }
          }
          return response;
        } catch (error) {
          report({ kind: 'network', source: 'fetch', ...request, error, message: error?.message || '网络请求失败' });
          throw error;
        }
      };
      Object.defineProperty(monitoredFetch, FETCH_WRAPPER, { value: true });
      try { browser.fetch = monitoredFetch; } catch {}
    }

    function monitorRuntimeErrors() {
      if (typeof browser?.addEventListener !== 'function') return;
      browser.addEventListener('error', event => {
        if (event?.error) {
          reportError(event.error, { source: event.filename || 'window.error', kind: 'runtime' });
          return;
        }
        // Element resource failures are intentionally ignored here. Images,
        // styles, and optional dependencies have their own recovery paths and are
        // not reliable evidence of a user-visible functional failure.
      }, true);
      browser.addEventListener('unhandledrejection', event => {
        reportError(event?.reason || new Error('未处理的 Promise 拒绝'), { source: 'unhandledrejection', kind: 'runtime' });
      });
    }

    function install() {
      if (installed) return api;
      installed = true;
      monitorFetch();
      monitorRuntimeErrors();
      return api;
    }

    const api = Object.freeze({
      EVENT_NAME,
      configure,
      install,
      report,
      reportError,
      reportUserVisibleMessage,
      createDraft,
      createManualDraft,
      acknowledge,
      consumePending,
      consumeReadyPending,
      isFunctionalRequest,
      shouldIgnore,
    });
    return api;
  }

  const api = createProblemFeedbackWorkflow();
  registry?.get('moduleRegistry')?.register('problemFeedbackWorkflow', api);
  if (typeof window !== 'undefined' && root === window) api.install();

  if (typeof module !== 'undefined' && module.exports) module.exports = { createProblemFeedbackWorkflow, EVENT_NAME, FEEDBACK_DELAY_MS };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
