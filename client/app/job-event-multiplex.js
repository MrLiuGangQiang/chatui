(function initChatUIAppJobEventMultiplex(root) {
  'use strict';

  const CHAT_JOB_EVENT_URL = /^\/api\/chat-jobs\/([^/?#]+)\/events(?:\?.*)?$/;

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

  function lengthOf(value) {
    return String(value || '').length;
  }

  function messageFromAggregate(aggregate) {
    return aggregate?.data?.choices?.[0]?.message || {};
  }

  function createJobEventMultiplexer(options = {}) {
    const EventSourceRef = options.EventSource || root?.EventSource;
    if (typeof EventSourceRef !== 'function') throw new TypeError('EventSource is required for job multiplexing');
    const endpoint = String(options.endpoint || '/api/chat-jobs/events');
    const setTimeoutRef = options.setTimeout || root?.setTimeout || setTimeout;
    const clearTimeoutRef = options.clearTimeout || root?.clearTimeout || clearTimeout;
    const subscribers = new Map();
    let source = null;
    let connectTimer = null;
    let reconnectAttempt = 0;
    let closed = false;

    function aggregateOffset(record) {
      const message = messageFromAggregate(record.aggregateEvent);
      return {
        contentLength: lengthOf(message.content),
        reasoningLength: lengthOf(message.reasoning_content),
      };
    }

    function groupOffset(jobId) {
      const records = [...(subscribers.get(jobId) || [])];
      if (!records.length) return { contentLength: 0, reasoningLength: 0 };
      return records.reduce((result, record, index) => {
        const offset = aggregateOffset(record);
        if (index === 0) return offset;
        return {
          contentLength: Math.min(result.contentLength, offset.contentLength),
          reasoningLength: Math.min(result.reasoningLength, offset.reasoningLength),
        };
      }, { contentLength: 0, reasoningLength: 0 });
    }

    function buildUrl() {
      const ids = [...subscribers.keys()].sort();
      if (typeof URLSearchParams === 'function') {
        const params = new URLSearchParams();
        params.set('ids', ids.join(','));
        for (const id of ids) {
          const offset = groupOffset(id);
          params.append('offset', `${id}:${offset.contentLength}:${offset.reasoningLength}`);
        }
        return `${endpoint}?${params.toString()}`;
      }
      const query = [`ids=${encodeURIComponent(ids.join(','))}`];
      for (const id of ids) {
        const offset = groupOffset(id);
        query.push(`offset=${encodeURIComponent(`${id}:${offset.contentLength}:${offset.reasoningLength}`)}`);
      }
      return `${endpoint}?${query.join('&')}`;
    }

    function clearConnectTimer() {
      if (connectTimer === null) return;
      clearTimeoutRef(connectTimer);
      connectTimer = null;
    }

    function closeSource() {
      if (!source) return;
      const current = source;
      source = null;
      try {
        current.onopen = null;
        current.onerror = null;
        current.close?.();
      } catch {}
    }

    function scheduleConnect(delayMs = 0) {
      if (closed || !subscribers.size || connectTimer !== null) return;
      connectTimer = setTimeoutRef(() => {
        connectTimer = null;
        connect();
      }, Math.max(0, Number(delayMs) || 0));
    }

    function normalizeRecordUpdate(record, event) {
      if (!event || typeof event !== 'object') return event;
      const hasDelta = Object.prototype.hasOwnProperty.call(event, 'd') || Object.prototype.hasOwnProperty.call(event, 'r');
      const isCompact = hasDelta || event.done || event.e || Object.prototype.hasOwnProperty.call(event, 'ft');
      if (!isCompact || event.data) {
        record.aggregateEvent = event;
        return event;
      }
      const base = record.aggregateEvent && typeof record.aggregateEvent === 'object'
        ? record.aggregateEvent
        : {
            status: 'running',
            data: { choices: [{ message: { content: '', reasoning_content: '' } }] },
            metrics: {},
          };
      const message = { ...messageFromAggregate(base) };
      if (event.d) message.content = String(message.content || '') + String(event.d || '');
      if (event.r) message.reasoning_content = String(message.reasoning_content || '') + String(event.r || '');
      record.aggregateEvent = {
        ...base,
        status: event.e ? 'error' : event.done ? 'done' : 'running',
        data: { choices: [{ message }] },
        metrics: {
          ...(base.metrics || {}),
          ...(Number.isFinite(event.ft) ? { firstTokenMs: event.ft } : {}),
          ...(Number.isFinite(event.rt) ? { durationMs: event.rt } : {}),
        },
        error: event.e ? { message: event.e } : base.error || null,
      };
      return record.aggregateEvent;
    }

    function removeRecord(jobId, record) {
      const records = subscribers.get(jobId);
      if (!records) return;
      records.delete(record);
      if (!records.size) subscribers.delete(jobId);
      if (!subscribers.size) {
        clearConnectTimer();
        closeSource();
        reconnectAttempt = 0;
      }
    }

    function finishRecord(record, settle, value) {
      if (!record || record.done) return;
      record.done = true;
      removeRecord(record.jobId, record);
      settle(value);
    }

    function handleEnvelope(envelope) {
      const jobId = String(envelope?.id || '');
      if (!jobId) return;
      const records = subscribers.get(jobId);
      if (!records?.size) return;
      const payload = { ...envelope };
      delete payload.id;
      for (const record of [...records]) {
        const event = normalizeRecordUpdate(record, payload);
        try {
          record.onUpdate?.(event);
        } catch (error) {
          finishRecord(record, record.reject, error);
          continue;
        }
        if (event?.status === 'done') {
          const data = event.data && typeof event.data === 'object'
            ? { ...event.data, metrics: event.metrics || event.data.metrics || {} }
            : event.data;
          finishRecord(record, record.resolve, data);
        } else if (event?.status === 'error') {
          finishRecord(record, record.reject, terminalJobError(event.error?.message));
        }
      }
    }

    function connect() {
      if (closed || !subscribers.size) return;
      closeSource();
      let next = null;
      try {
        next = new EventSourceRef(buildUrl());
      } catch (error) {
        reconnectAttempt += 1;
        scheduleConnect(Math.min(1000 + 250 * reconnectAttempt, 5000));
        if (!subscribers.size) throw error;
        return;
      }
      source = next;
      next.onopen = () => { reconnectAttempt = 0; };
      next.addEventListener('job', event => {
        let envelope = null;
        try { envelope = JSON.parse(event?.data || '{}'); } catch { return; }
        handleEnvelope(envelope);
      });
      next.onerror = () => {
        if (source === next) source = null;
        try { next.close?.(); } catch {}
        if (closed || !subscribers.size) return;
        reconnectAttempt += 1;
        scheduleConnect(Math.min(1000 + 250 * reconnectAttempt, 5000));
      };
    }

    function subscribe(jobId, onUpdate = () => {}, subscribeOptions = {}) {
      const id = String(jobId || '').trim();
      if (!id) return Promise.reject(new TypeError('jobId is required'));
      const existing = subscribers.get(id);
      const hadJob = Boolean(existing?.size);
      let record = null;
      const promise = new Promise((resolve, reject) => {
        const offsets = subscribeOptions.resumeOffsets || {};
        const aggregateEvent = offsets.baseContent || offsets.baseReasoning
          ? {
              status: 'running',
              data: {
                choices: [{
                  message: {
                    content: String(offsets.baseContent || ''),
                    reasoning_content: String(offsets.baseReasoning || ''),
                  },
                }],
              },
              metrics: {},
            }
          : null;
        record = {
          jobId: id,
          aggregateEvent,
          done: false,
          onUpdate,
          resolve,
          reject,
          abortListener: null,
        };
        const records = subscribers.get(id) || new Set();
        records.add(record);
        subscribers.set(id, records);
        const signal = subscribeOptions.signal;
        record.abortListener = () => finishRecord(record, reject, new DOMException('已停止', 'AbortError'));
        if (signal?.aborted) return record.abortListener();
        signal?.addEventListener('abort', record.abortListener, { once: true });
        if (!hadJob) scheduleConnect(0);
      });
      return promise.finally(() => {
        const signal = subscribeOptions.signal;
        if (signal && record?.abortListener) signal.removeEventListener('abort', record.abortListener);
      });
    }

    function close() {
      closed = true;
      clearConnectTimer();
      closeSource();
      for (const [jobId, records] of [...subscribers]) {
        for (const record of [...records]) finishRecord(record, record.reject, new DOMException('已停止', 'AbortError'));
        subscribers.delete(jobId);
      }
    }

    return Object.freeze({ subscribe, close, buildUrl });
  }

  const api = Object.freeze({ createJobEventMultiplexer, jobIdFromEventUrl });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  registry?.register?.('jobEventMultiplex', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
