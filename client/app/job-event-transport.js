(function initChatUIAppJobEventTransport(root) {
  'use strict';

  const MAX_RECONNECT_FAILURES = 8;

  function resolveAggregate(rootLike = root, provided) {
    if (provided) return provided;
    const moduleRegistry = rootLike?.[Symbol.for('chatui.module-registry.v1')]?.get?.('moduleRegistry');
    const registered = moduleRegistry?.resolve?.('jobEventAggregate');
    if (registered) return registered;
    if (typeof require === 'function') return require('../core/job-event-aggregate');
    throw new Error('Job event aggregate module is required');
  }

  function createJobEventTransport(options = {}) {
    const aggregate = resolveAggregate(options.root || root, options.aggregate);
    const EventSourceRef = options.EventSource;
    if (typeof EventSourceRef !== 'function') throw new TypeError('EventSource is required for job event transport');
    const records = options.records;
    if (!records || typeof records.get !== 'function') throw new TypeError('records map is required');
    const endpoint = String(options.endpoint || '/api/chat-jobs').replace(/\/+$/, '');
    const setTimeoutRef = options.setTimeout || root?.setTimeout || setTimeout;
    const clearTimeoutRef = options.clearTimeout || root?.clearTimeout || clearTimeout;
    const randomRef = options.random || Math.random;
    const pageUnloading = options.pageUnloading || options.isPageUnloading || (() => false);
    const applyPayload = options.applyPayload || (() => ({ valid: true, changed: false }));
    const onFollowerUnavailable = options.onFollowerUnavailable || (() => {});
    let closed = false;
    let lastBuiltUrl = '';

    function buildTarget(record) {
      const message = aggregate.messageFromAggregate(record?.aggregate);
      const contentLength = aggregate.lengthOf(message.content);
      const reasoningLength = aggregate.lengthOf(message.reasoning_content);
      return endpoint + '/' + encodeURIComponent(record.id) + '/events?contentLength=' + contentLength + '&reasoningLength=' + reasoningLength;
    }

    function clearReconnect(record) {
      if (record?.reconnectTimer == null) return;
      clearTimeoutRef(record.reconnectTimer);
      record.reconnectTimer = null;
    }

    function closeSource(record) {
      const source = record?.source;
      if (!source) return;
      record.source = null;
      record.epoch += 1;
      try {
        source.onopen = null;
        source.onerror = null;
        source.onmessage = null;
        source.close?.();
      } catch {}
    }

    function removeRecord(record) {
      if (!record || records.get(record.id) !== record) return;
      records.delete(record.id);
      clearReconnect(record);
      closeSource(record);
      record.transport = 'closed';
    }

    function reconnectDelay(attempt) {
      const base = Math.min(1000 * (2 ** Math.max(0, attempt - 1)), 5000);
      const jitter = 0.8 + Math.max(0, Math.min(1, Number(randomRef()) || 0)) * 0.4;
      return Math.max(1000, Math.min(5000, Math.round(base * jitter)));
    }

    function handleFailure(record, source) {
      if (closed || (source && record.source !== source)) return;
      closeSource(record);
      if (pageUnloading()) return;
      record.failureCount += 1;
      if (record.failureCount >= MAX_RECONNECT_FAILURES) {
        onFollowerUnavailable(record);
        return;
      }
      clearReconnect(record);
      record.reconnectTimer = setTimeoutRef(() => {
        record.reconnectTimer = null;
        connect(record);
      }, reconnectDelay(record.failureCount));
      record.reconnectTimer?.unref?.();
    }

    function handleMessage(record, source, epoch, event) {
      if (closed || record.source !== source || record.epoch !== epoch) return;
      let payload;
      try { payload = JSON.parse(event?.data || ''); } catch { return handleFailure(record, source); }
      const update = applyPayload(record, payload);
      if (!update?.valid) return handleFailure(record, source);
      record.failureCount = 0;
    }

    function connect(record) {
      if (closed || !record || records.get(record.id) !== record || record.source) return;
      const url = buildTarget(record);
      lastBuiltUrl = url;
      let source;
      try { source = new EventSourceRef(url); } catch { handleFailure(record); return; }
      const epoch = record.epoch + 1;
      record.epoch = epoch;
      record.source = source;
      record.transport = 'sse';
      source.onopen = () => {};
      source.onerror = () => handleFailure(record, source);
      source.onmessage = event => handleMessage(record, source, epoch, event);
    }

    function reconcile() {
      if (closed) return;
      for (const record of records.values()) {
        if (record.transport === 'pending' || !record.source) connect(record);
      }
    }

    function close() {
      if (closed) return;
      closed = true;
      for (const record of records.values()) {
        clearReconnect(record);
        closeSource(record);
      }
    }

    function buildUrl() {
      const record = records.values().next().value;
      if (!record) return '';
      lastBuiltUrl = buildTarget(record);
      return lastBuiltUrl;
    }

    function getState() {
      return {
        connectionCount: records.size,
        connections: [...records.values()].map(record => ({
          sessionId: String(record.sessionId || ''),
          jobId: record.id,
          sourceOpen: !!record.source,
          failureCount: record.failureCount,
          url: buildTarget(record),
        })),
        recordCount: records.size,
        lastBuiltUrl,
      };
    }

    return Object.freeze({ buildUrl, close, getState, reconcile, removeRecord });
  }

  const api = Object.freeze({ createJobEventTransport });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  registry?.register?.('jobEventTransport', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
