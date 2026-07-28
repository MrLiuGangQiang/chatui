(function initChatUIAppJobWorkflow(root) {
  'use strict';

  function readJsonStorage(key, storage = root.localStorage, fallback = null) {
    try { const raw = storage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { try { storage.removeItem(key); } catch {} return fallback; }
  }

  const PENDING_SUBMIT_VERSION = 2;

  function saveJob(sessionId, job, deps = {}, kind = 'chat') {
    if (deps.isSessionDisposed?.(sessionId)) return null;
    const keyFn = kind === 'image' ? deps.sessionImageJobKey : deps.sessionChatJobKey;
    if (!keyFn) throw new Error('session job key helper is required');
    return deps.safeSetJobStorage(keyFn(sessionId), job);
  }

  function loadJob(sessionId, deps = {}, kind = 'chat') {
    const keyFn = kind === 'image' ? deps.sessionImageJobKey : deps.sessionChatJobKey;
    if (!keyFn) throw new Error('session job key helper is required');
    return readJsonStorage(keyFn(sessionId), deps.storage || root.localStorage);
  }

  function clearJob(sessionId, deps = {}, kind = 'chat') {
    const keyFn = kind === 'image' ? deps.sessionImageJobKey : deps.sessionChatJobKey;
    if (!keyFn) throw new Error('session job key helper is required');
    return (deps.storage || root.localStorage).removeItem(keyFn(sessionId));
  }

  function pendingSubmitKey(sessionId = '') {
    return `openapi-chat-image-pending-submit-v1:${sessionId || 'default'}`;
  }

  function makeSubmissionId(now = Date.now, random = Math.random) {
    return `submit-${Number(now()).toString(36)}-${Number(random()).toString(36).slice(2, 10)}`;
  }

  function pendingSubmitDisplayId(pendingSubmit = {}) {
    const liveItemId = String(pendingSubmit?.liveItemId || '').trim();
    if (liveItemId) return liveItemId;
    const submissionId = String(pendingSubmit?.submissionId || '').trim();
    return submissionId ? `pending-submit-${submissionId}` : '';
  }

  function normalizePendingSubmit(pendingSubmit) {
    if (!pendingSubmit || typeof pendingSubmit !== 'object' || Array.isArray(pendingSubmit)) return null;
    const normalized = {
      ...pendingSubmit,
      version: Number(pendingSubmit.version || pendingSubmit.schemaVersion || 1) || 1,
      submissionId: String(pendingSubmit.submissionId || ''),
      stage: String(pendingSubmit.stage || 'routing'),
      attachmentCount: Math.max(0, Number(pendingSubmit.attachmentCount || 0) || 0),
    };
    if (pendingSubmit.userCommitted !== undefined) normalized.userCommitted = !!pendingSubmit.userCommitted;
    return normalized;
  }

  function pendingSubmitHasRecoverableInput(pendingSubmit) {
    const pending = normalizePendingSubmit(pendingSubmit);
    if (!pending) return false;
    return !!String(pending.promptText || pending.rawPromptText || '').trim()
      || !!pending.imageContext
      || !!pending.attachmentContext
      || pending.attachmentCount > 0;
  }

  function findPendingSubmissionMessage(messages = [], pendingSubmit = {}) {
    const pending = normalizePendingSubmit(pendingSubmit);
    if (!pending || !Array.isArray(messages)) return null;
    if (pending.submissionId) {
      const match = messages.find((message) => message?.role === 'user' && message.submissionId === pending.submissionId);
      if (match) return match;
    }
    const rawIndex = pending.messageIndex;
    if (rawIndex === null || rawIndex === undefined || typeof rawIndex === 'string' && !rawIndex.trim()) return null;
    const index = Number(rawIndex);
    if (!Number.isFinite(index) || index < 0 || messages[index]?.role !== 'user') return null;
    const message = messages[index];
    const expectedText = String(pending.rawPromptText || pending.promptText || '').trim();
    const actualText = String(message.rawText || (typeof message.content === 'string' ? message.content : '') || '').trim();
    return !expectedText || expectedText === actualText ? message : null;
  }

  function isPendingSubmissionCommitted(messages = [], pendingSubmit = {}) {
    if (findPendingSubmissionMessage(messages, pendingSubmit)) return true;
    const pending = normalizePendingSubmit(pendingSubmit);
    // Legacy pending-submit records were only written after the user message was
    // appended. Preserve that contract while allowing v2 records to represent the
    // earlier accepted/capturing phase explicitly.
    return pending?.userCommitted !== false;
  }

  function loadPendingSubmit(sessionId = '', deps = {}) {
    return normalizePendingSubmit(readJsonStorage(pendingSubmitKey(sessionId), deps.storage || root.localStorage, null));
  }

  function savePendingSubmit(sessionId = '', pendingSubmit = {}, deps = {}) {
    if (deps.isSessionDisposed?.(sessionId)) return false;
    const normalized = normalizePendingSubmit({
      ...pendingSubmit,
      version: PENDING_SUBMIT_VERSION,
      savedAt: Date.now(),
    });
    (deps.storage || root.localStorage).setItem(pendingSubmitKey(sessionId), JSON.stringify(normalized));
    return true;
  }

  function mergePendingSubmit(sessionId = '', patch = {}, deps = {}) {
    const current = loadPendingSubmit(sessionId, deps) || {};
    return savePendingSubmit(sessionId, { ...current, ...patch }, deps);
  }

  function clearPendingSubmit(sessionId = '', deps = {}) {
    return (deps.storage || root.localStorage).removeItem(pendingSubmitKey(sessionId));
  }

  function isRecoverableJobSnapshot(savedJob, expectedJob = {}) {
    if (!savedJob?.id || savedJob.id !== expectedJob?.id) return false;
    if (expectedJob.submissionId && savedJob.submissionId !== expectedJob.submissionId) return false;
    return !!savedJob.payload && typeof savedJob.payload === 'object' && !Array.isArray(savedJob.payload);
  }

  function findPendingSubmitHandoffJob(pendingSubmit, { chatJob = null, imageJob = null } = {}) {
    const pending = normalizePendingSubmit(pendingSubmit);
    if (!pending || pending.stage !== 'handoff' || !pending.jobId) return null;
    const candidates = pending.jobKind === 'image'
      ? [['image', imageJob]]
      : pending.jobKind === 'chat'
        ? [['chat', chatJob]]
        : [['chat', chatJob], ['image', imageJob]];
    for (const [kind, job] of candidates) {
      if (isRecoverableJobSnapshot(job, { id: pending.jobId, submissionId: pending.submissionId })) return { kind, job };
    }
    return null;
  }

  function shouldPreservePendingSubmitOnError(err, state = {}, run = {}) {
    return !!state.pageUnloading || err?.preservePendingSubmit === true || (err?.name === 'AbortError' && !run.stopped);
  }

  function loadDisplayChatJob(sessionId, deps = {}) {
    const session = (deps.sessions || []).find(item => item.id === sessionId);
    const hasCompletedAssistantForResponse = deps.hasCompletedAssistantForResponse || (() => false);
    const item = [...(session?.display || [])].reverse().find(item => (
      item?.pending === '1' &&
      item.jobId &&
      !deps.isImagePendingDisplayItem(item) &&
      !hasCompletedAssistantForResponse(session, item.responseIndex)
    ));
    return item?.jobId ? {
      id: item.jobId,
      prompt: '',
      payload: null,
      startedAt: Date.now(),
      displayItemId: item.id || '',
      responseIndex: item.responseIndex !== '' && item.responseIndex !== undefined ? item.responseIndex : null,
    } : null;
  }

  function sameResponseIndex(left, right) {
    if (left === undefined || left === null || left === '' || right === undefined || right === null || right === '') return false;
    return String(left) === String(right);
  }

  function chatJobMatchesDisplay(stored, display) {
    if (!stored?.id || !display?.id) return false;
    return stored.id === display.id
      || !!(stored.displayItemId && display.displayItemId && String(stored.displayItemId) === String(display.displayItemId))
      || sameResponseIndex(stored.responseIndex, display.responseIndex);
  }

  function loadLatestChatJob(sessionId, deps = {}) {
    const stored = loadJob(sessionId, deps, 'chat');
    const display = loadDisplayChatJob(sessionId, deps);
    if (!stored?.id) return display;
    if (!display?.id) return stored;
    // The localStorage job contains the only resumable request payload. IndexedDB
    // display snapshots can lag behind it while a tab is switched or reloaded, so
    // never replace a durable job with a payload-less display fallback just because
    // their ids differ. Only use display fields to rebind the matching UI item.
    if (!chatJobMatchesDisplay(stored, display)) return stored;
    return {
      ...stored,
      displayItemId: display.displayItemId || stored.displayItemId || '',
      responseIndex: display.responseIndex ?? stored.responseIndex,
    };
  }

  function makeTerminalJobError(message = 'Managed job failed') {
    const error = new Error(message || 'Managed job failed');
    error.name = 'JobTerminalError';
    error.terminalJob = true;
    return error;
  }

  function appendResumeOffsets(url, aggregateEvent, options = {}) {
    const message = aggregateEvent?.data?.choices?.[0]?.message || {};
    const fallback = options.resumeOffsets || {};
    const contentLength = String(message.content || '').length || Math.max(0, Number(fallback.contentLength) || 0);
    const reasoningLength = String(message.reasoning_content || '').length || Math.max(0, Number(fallback.reasoningLength) || 0);
    if (!contentLength && !reasoningLength) return url;
    try {
      const parsed = new URL(url, root.location?.origin || 'http://localhost');
      parsed.searchParams.set('contentLength', String(contentLength));
      parsed.searchParams.set('reasoningLength', String(reasoningLength));
      return parsed.pathname + parsed.search + parsed.hash;
    } catch { return url; }
  }

  function waitJobEvent(url, onUpdate = () => {}, options = {}) {
    let abortListener = null;
    let retryTimer = null;
    let softTimeoutTimer = null;
    const signal = options.signal;
    const pollJob = options.pollJob;
    const EventSourceRef = options.EventSource || root.EventSource;
    const isPageUnloading = options.isPageUnloading || (() => false);
    return new Promise((resolve, reject) => {
      let source = null;
      let done = false;
      let retries = 0;
      let opened = false;
      const initialOffsets = options.resumeOffsets || {};
      let aggregateEvent = initialOffsets.baseContent || initialOffsets.baseReasoning ? {
        status: 'running',
        data: { choices: [{ message: { content: String(initialOffsets.baseContent || ''), reasoning_content: String(initialOffsets.baseReasoning || '') } }] },
        metrics: {},
      } : null;
      const normalizeCompactUpdate = event => {
        if (!event || typeof event !== 'object') return event;
        const isMinimal = Object.prototype.hasOwnProperty.call(event, 'd') || Object.prototype.hasOwnProperty.call(event, 'r') || event.done || event.e || Object.prototype.hasOwnProperty.call(event, 'ft');
        if (!isMinimal || event.data) {
          aggregateEvent = event;
          return event;
        }
        const base = aggregateEvent && typeof aggregateEvent === 'object' ? aggregateEvent : {
          status: 'running',
          data: { choices: [{ message: { content: '', reasoning_content: '' } }] },
          metrics: {},
        };
        const message = { ...(base.data?.choices?.[0]?.message || {}) };
        if (event.d) message.content = String(message.content || '') + String(event.d || '');
        if (event.r) message.reasoning_content = String(message.reasoning_content || '') + String(event.r || '');
        aggregateEvent = {
          ...base,
          status: event.e ? 'error' : event.done ? 'done' : 'running',
          data: { choices: [{ message }] },
          metrics: { ...(base.metrics || {}), ...(Number.isFinite(event.ft) ? { firstTokenMs: event.ft } : {}), ...(Number.isFinite(event.rt) ? { durationMs: event.rt } : {}) },
          error: event.e ? { message: event.e } : base.error || null,
        };
        return aggregateEvent;
      };
      const finish = (handler, value) => {
        if (done) return;
        done = true;
        clearTimeout(retryTimer);
        clearTimeout(softTimeoutTimer);
        try { source?.close(); } catch {}
        handler(value);
      };
      const handleUpdate = rawEvent => {
        const event = normalizeCompactUpdate(rawEvent);
        onUpdate(event);
        if (event.status === 'done') {
          const data = event.data && typeof event.data === 'object' ? { ...event.data, metrics: event.metrics || event.data.metrics || {} } : event.data;
          finish(resolve, data);
        } else if (event.status === 'error') finish(reject, makeTerminalJobError(event.error?.message));
      };
      const poll = async () => {
        if (done || !pollJob || isPageUnloading()) return;
        try { handleUpdate(await pollJob()); } catch {}
        if (!done) retryTimer = setTimeout(poll, 2500);
      };
      abortListener = () => { if (!done) finish(reject, new DOMException('已停止', 'AbortError')); };
      if (signal?.aborted) return abortListener();
      signal?.addEventListener('abort', abortListener, { once: true });
      const softTimeoutMs = Math.max(0, Number(options.softTimeoutMs || 0) || 0);
      if (softTimeoutMs > 0) {
        softTimeoutTimer = setTimeout(() => {
          const err = new Error(options.softTimeoutMessage || '任务仍在后台处理中，可稍后刷新或切换会话恢复查看');
          err.name = 'JobSoftTimeoutError';
          finish(reject, err);
        }, softTimeoutMs);
      }
      poll();
      const connect = () => {
        if (done) return;
        source = new EventSourceRef(appendResumeOffsets(url, aggregateEvent, options));
        source.onopen = () => { opened = true; retries = 0; };
        source.addEventListener('update', event => {
          opened = true;
          handleUpdate(JSON.parse(event.data || '{}'));
        });
        source.onerror = () => {
          source.close();
          if (done || isPageUnloading()) return;
          if (!opened && !pollJob) return finish(reject, new Error('任务不存在或服务已重启，请重新发送'));
          retries += 1;
          if (retries > 60 && !pollJob) return finish(reject, new Error('任务事件连接中断，请刷新页面恢复任务；如果仍失败，请重新发送'));
          setTimeout(connect, Math.min(1000 + 250 * retries, 5000));
        };
      };
      connect();
    }).finally(() => {
      clearTimeout(retryTimer);
      clearTimeout(softTimeoutTimer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    });
  }

  const api = Object.freeze({ PENDING_SUBMIT_VERSION, readJsonStorage, saveJob, loadJob, clearJob, loadDisplayChatJob, loadLatestChatJob, pendingSubmitKey, makeSubmissionId, pendingSubmitDisplayId, normalizePendingSubmit, pendingSubmitHasRecoverableInput, findPendingSubmissionMessage, isPendingSubmissionCommitted, loadPendingSubmit, savePendingSubmit, mergePendingSubmit, clearPendingSubmit, isRecoverableJobSnapshot, findPendingSubmitHandoffJob, shouldPreservePendingSubmitOnError, makeTerminalJobError, waitJobEvent });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppJobWorkflow = api;
  if (root?.window) root.window.ChatUIAppJobWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
