(function initChatUIAppJobEventStream(root) {
  'use strict';

  const CHAT_JOB_EVENT_URL = /^\/api\/chat-jobs\/([^/?#]+)\/events(?:\?.*)?$/;

  function resolveModule(rootLike, name, fallbackPath) {
    const moduleRegistry = rootLike?.[Symbol.for('chatui.module-registry.v1')]?.get?.('moduleRegistry');
    const registered = moduleRegistry?.resolve?.(name);
    if (registered) return registered;
    if (typeof require === 'function') return require(fallbackPath);
    throw new Error(`${name} module is required`);
  }

  function jobIdFromEventUrl(url = '') {
    const match = String(url || '').match(CHAT_JOB_EVENT_URL);
    if (!match) return '';
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  }

  function terminalJobError(message = 'Managed job failed') {
    const error = new Error(message || 'Managed job failed');
    error.name = 'JobTerminalError';
    error.terminalJob = true;
    return error;
  }

  function abortError(message = '已停止') {
    try { return new DOMException(message, 'AbortError'); } catch {
      const error = new Error(message);
      error.name = 'AbortError';
      return error;
    }
  }

  function followerUnavailableError() {
    const error = new Error('任务事件暂时不可用，任务仍会保留，可刷新页面继续恢复');
    error.name = 'JobFollowerUnavailableError';
    error.preserveRecoveryOwner = true;
    error.terminalJob = false;
    return error;
  }

  function sessionConflictError(jobId, existingSessionId, requestedSessionId) {
    const error = new Error('任务已绑定到其他会话，未接管该任务');
    error.name = 'JobSessionConflictError';
    error.code = 'JOB_SESSION_CONFLICT';
    error.jobId = jobId;
    error.existingSessionId = existingSessionId;
    error.requestedSessionId = requestedSessionId;
    error.terminalJob = false;
    return error;
  }

  function makeMetadata(jobId, options = {}) {
    return Object.freeze({
      jobId: String(jobId),
      sessionId: String(options.sessionId || ''),
      displayItemId: String(options.displayItemId || ''),
      responseIndex: options.responseIndex === undefined ? null : options.responseIndex,
      liveItemId: String(options.liveItemId || ''),
      submissionId: String(options.submissionId || ''),
      ownerToken: String(options.ownerToken || options.runToken || ''),
    });
  }

  function createJobEventStream(options = {}) {
    const EventSourceRef = options.EventSource || root?.EventSource;
    if (typeof EventSourceRef !== 'function') throw new TypeError('EventSource is required for job streaming');
    const aggregate = resolveModule(root, 'jobEventAggregate', '../core/job-event-aggregate');
    const transportModule = resolveModule(root, 'jobEventTransport', './job-event-transport');
    const setTimeoutRef = options.setTimeout || root?.setTimeout || setTimeout;
    const records = new Map();
    const sessionRecords = new Map();
    let closed = false;
    const pageListeners = [];
    let transport;

    function isTerminalStatus(status) {
      return aggregate.isTerminalStatus(status);
    }

    function finishWaiter(record, waiter, settle, value) {
      if (!waiter || waiter.done) return;
      waiter.done = true;
      record.waiters.delete(waiter);
      waiter.signal?.removeEventListener?.('abort', waiter.abortListener);
      settle(value);
      if (!record.waiters.size) {
        if (record.sessionId && sessionRecords.get(record.sessionId) === record) sessionRecords.delete(record.sessionId);
        transport.removeRecord(record);
      }
    }

    function deliver(record, waiter, event) {
      if (!waiter || waiter.done) return false;
      if (typeof waiter.guard === 'function' && !waiter.guard(waiter.metadata, event)) {
        finishWaiter(record, waiter, waiter.reject, abortError('任务已切换或显示项已失效'));
        return false;
      }
      try {
        waiter.onUpdate?.(event, waiter.metadata);
      } catch (error) {
        finishWaiter(record, waiter, waiter.reject, error);
        return false;
      }
      return true;
    }

    function settleRecord(record) {
      const aggregateState = record.aggregate || {};
      if (!isTerminalStatus(aggregateState.status)) return;
      const waiters = [...record.waiters];
      for (const waiter of waiters) {
        if (!deliver(record, waiter, aggregateState)) continue;
        if (aggregateState.status === 'done') {
          const data = aggregateState.data && typeof aggregateState.data === 'object'
            ? { ...aggregateState.data, metrics: aggregateState.metrics || aggregateState.data.metrics || {} }
            : aggregateState.data;
          finishWaiter(record, waiter, waiter.resolve, data);
        } else {
          finishWaiter(record, waiter, waiter.reject, terminalJobError(aggregateState.error?.message || 'Managed job failed'));
        }
      }
    }

    function applyPayload(record, payload) {
      const update = aggregate.applyEvent(record, payload);
      if (!update.valid) return update;
      if (!update.changed) return update;
      if (isTerminalStatus(update.aggregate.status)) settleRecord(record);
      else for (const waiter of [...record.waiters]) deliver(record, waiter, update.aggregate);
      return update;
    }

    transport = transportModule.createJobEventTransport({
      ...options,
      EventSource: EventSourceRef,
      root,
      records,
      applyPayload,
      onFollowerUnavailable(record) {
        const unavailable = followerUnavailableError();
        for (const waiter of [...record.waiters]) {
          try { waiter.onFollowerStopped?.(unavailable, waiter.metadata); } catch {}
          finishWaiter(record, waiter, waiter.reject, unavailable);
        }
      },
    });

    function subscribe(jobId, onUpdate = () => {}, subscribeOptions = {}) {
      const id = String(jobId || '').trim();
      if (!id) return Promise.reject(new TypeError('jobId is required'));
      if (closed) return Promise.reject(abortError('任务事件管理器已关闭'));
      const requestedSessionId = String(subscribeOptions.sessionId || '').trim();
      if (!requestedSessionId) return Promise.reject(new TypeError('sessionId is required for chat job events'));
      const existing = records.get(id);
      if (existing?.sessionId && existing.sessionId !== requestedSessionId) {
        return Promise.reject(sessionConflictError(id, existing.sessionId, requestedSessionId));
      }
      const sessionRecord = sessionRecords.get(requestedSessionId);
      if (sessionRecord && sessionRecord.id !== id) {
        return Promise.reject(sessionConflictError(id, sessionRecord.id, requestedSessionId));
      }
      const record = existing || {
        id,
        aggregate: aggregate.initialAggregate(subscribeOptions.resumeOffsets || {}),
        waiters: new Set(),
        sessionId: requestedSessionId,
        transport: 'pending',
        source: null,
        epoch: 0,
        failureCount: 0,
        reconnectTimer: null,
      };
      if (!existing) records.set(id, record);
      sessionRecords.set(requestedSessionId, record);
      const metadata = makeMetadata(id, subscribeOptions);
      let waiter;
      const promise = new Promise((resolve, reject) => {
        waiter = {
          metadata,
          onUpdate,
          onFollowerStopped: subscribeOptions.onFollowerStopped,
          guard: subscribeOptions.isFollowerCurrent || subscribeOptions.guard,
          resolve,
          reject,
          signal: subscribeOptions.signal,
          abortListener: null,
          done: false,
        };
        waiter.abortListener = () => finishWaiter(record, waiter, reject, abortError());
        record.waiters.add(waiter);
        subscribeOptions.signal?.addEventListener?.('abort', waiter.abortListener, { once: true });
        if (subscribeOptions.signal?.aborted) waiter.abortListener();
      });
      if (existing && record.aggregate && !waiter.done) {
        Promise.resolve().then(() => {
          if (!waiter.done && records.get(id) === record) {
            deliver(record, waiter, record.aggregate);
            settleRecord(record);
          }
        });
      }
      if (!waiter.done && record.transport === 'pending') transport.reconcile();
      return promise.finally(() => waiter.signal?.removeEventListener?.('abort', waiter.abortListener));
    }

    function close() {
      if (closed) return;
      closed = true;
      transport.close();
      for (const record of [...records.values()]) {
        for (const waiter of [...record.waiters]) finishWaiter(record, waiter, waiter.reject, abortError());
      }
      records.clear();
      sessionRecords.clear();
      for (const [target, type, listener] of pageListeners.splice(0)) {
        try { target.removeEventListener?.(type, listener); } catch {}
      }
    }

    function onPageUnload() {
      close();
    }

    const pageTarget = options.pageEventTarget || root;
    if (options.listenPageUnload !== false && pageTarget?.addEventListener) {
      for (const type of ['pagehide', 'beforeunload']) {
        pageTarget.addEventListener(type, onPageUnload);
        pageListeners.push([pageTarget, type, onPageUnload]);
      }
    }

    function getState() {
      return { closed, ...transport.getState() };
    }

    return Object.freeze({
      subscribe,
      close,
      buildUrl: transport.buildUrl,
      getState,
      isClosed: () => closed,
    });
  }

  const api = Object.freeze({ createJobEventStream, jobIdFromEventUrl });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  registry?.register?.('jobEventStream', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
