(function initChatUIAppJobEventMultiplex(root) {
  'use strict';

  const CHAT_JOB_EVENT_URL = /^\/api\/chat-jobs\/([^/?#]+)\/events(?:\?.*)?$/;
  const MAX_SHARDS = 4;
  const MAX_IDS_PER_SHARD = 64;
  const MAX_TARGET_BYTES = 6144;
  const POLL_CONCURRENCY = 4;
  const POLL_INTERVAL_MS = 2500;
  const POLL_TIMEOUT_MS = 5000;
  const MAX_POLL_FAILURES = 60;
  const MAX_RECONNECT_FAILURES = 8;
  const MAX_OFFSET_DIGITS = 16;

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

  function lengthOf(value) {
    return String(value ?? '').length;
  }

  function messageFromAggregate(aggregate) {
    return aggregate?.data?.choices?.[0]?.message || {};
  }

  function isTerminalStatus(status) {
    return status === 'done' || status === 'error';
  }

  function eventOwn(event, key) {
    return Object.prototype.hasOwnProperty.call(event, key);
  }

  function textByteLength(value) {
    const text = String(value ?? '');
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
    if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') return Buffer.byteLength(text, 'utf8');
    return unescape(encodeURIComponent(text)).length;
  }

  function stableSortIds(ids) {
    return [...new Set(ids.map(id => String(id || '').trim()).filter(Boolean))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
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

  function initialAggregate(resumeOffsets = {}) {
    const content = String(resumeOffsets.baseContent ?? '');
    const reasoning = String(resumeOffsets.baseReasoning ?? '');
    if (!content && !reasoning) return null;
    return {
      status: 'running',
      data: { choices: [{ message: { content, reasoning_content: reasoning } }] },
      metrics: {},
    };
  }

  function defaultParseResponseJson(response) {
    if (response && typeof response.json === 'function') return response.json();
    return response?.text?.().then(text => {
      try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
    });
  }

  function makeHttpError(response, payload) {
    const message = payload?.error?.message || payload?.message || `请求失败（${Number(response?.status) || 0}）`;
    const error = new Error(message);
    error.statusCode = Number(response?.status) || 0;
    error.status = error.statusCode;
    error.code = payload?.error?.code || payload?.code || '';
    return error;
  }

  function resolveDefaultPollJob(options, jobId, context = {}) {
    const service = options.jobService
      || root?.ChatUIJobService
      || (typeof require === 'function' ? (() => { try { return require('../services/job-service'); } catch { return null; } })() : null);
    if (service?.getChatJob) {
      return service.getChatJob({
        jobId,
        fetchImpl: options.fetchImpl || root?.fetch,
        signal: context.signal,
        parseResponseJson: options.parseResponseJson,
        normalizeError: options.normalizeError,
      });
    }
    const fetchImpl = options.fetchImpl || root?.fetch || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl !== 'function') return Promise.reject(new Error('Chat Job GET polling is unavailable'));
    const url = `/api/chat-jobs/${encodeURIComponent(jobId)}`;
    return Promise.resolve(fetchImpl(url, { method: 'GET', signal: context.signal }))
      .then(async response => {
        const payload = await (options.parseResponseJson || defaultParseResponseJson)(response);
        if (!response?.ok) throw makeHttpError(response, payload);
        return payload;
      });
  }

  function createJobEventMultiplexer(options = {}) {
    const EventSourceRef = options.EventSource || root?.EventSource;
    if (typeof EventSourceRef !== 'function') throw new TypeError('EventSource is required for job multiplexing');
    const endpoint = String(options.endpoint || '/api/chat-jobs/events');
    const setTimeoutRef = options.setTimeout || root?.setTimeout || setTimeout;
    const clearTimeoutRef = options.clearTimeout || root?.clearTimeout || clearTimeout;
    const randomRef = options.random || Math.random;
    const pageUnloading = options.pageUnloading || options.isPageUnloading || (() => false);
    const records = new Map();
    const shards = [];
    const pollRecords = new Set();
    let nextShardId = 1;
    let closed = false;
    let reconcileTimer = null;
    let pollTimer = null;
    let activePolls = 0;
    let lastBuiltUrl = '';
    const pageListeners = [];

    function targetPrefix() {
      return endpoint.includes('?') ? `${endpoint}&` : `${endpoint}?`;
    }

    function buildTarget(ids, reserveOffsetDigits = false) {
      const sortedIds = stableSortIds(ids);
      const params = typeof URLSearchParams === 'function' ? new URLSearchParams() : null;
      if (params) {
        params.set('ids', sortedIds.join(','));
        for (const id of sortedIds) {
          const record = records.get(id);
          const message = messageFromAggregate(record?.aggregate);
          const contentLength = reserveOffsetDigits ? '9'.repeat(MAX_OFFSET_DIGITS) : lengthOf(message.content);
          const reasoningLength = reserveOffsetDigits ? '9'.repeat(MAX_OFFSET_DIGITS) : lengthOf(message.reasoning_content);
          params.append('offset', `${id}:${contentLength}:${reasoningLength}`);
        }
        return `${targetPrefix()}${params.toString()}`;
      }
      const query = [`ids=${encodeURIComponent(sortedIds.join(','))}`];
      for (const id of sortedIds) {
        const record = records.get(id);
        const message = messageFromAggregate(record?.aggregate);
        const contentLength = reserveOffsetDigits ? '9'.repeat(MAX_OFFSET_DIGITS) : lengthOf(message.content);
        const reasoningLength = reserveOffsetDigits ? '9'.repeat(MAX_OFFSET_DIGITS) : lengthOf(message.reasoning_content);
        query.push(`offset=${encodeURIComponent(`${id}:${contentLength}:${reasoningLength}`)}`);
      }
      return `${targetPrefix()}${query.join('&')}`;
    }

    function shardCanFit(shard, id) {
      if (!shard || shard.mode !== 'sse' || shard.ids.has(id)) return false;
      if (shard.ids.size >= MAX_IDS_PER_SHARD) return false;
      return textByteLength(buildTarget([...shard.ids, id], true)) <= MAX_TARGET_BYTES;
    }

    function closeSource(shard) {
      if (!shard?.source) return;
      const source = shard.source;
      shard.source = null;
      shard.epoch += 1;
      try {
        source.onopen = null;
        source.onerror = null;
        source.close?.();
      } catch {}
    }

    function clearShardTimer(shard) {
      if (!shard?.timer) return;
      clearTimeoutRef(shard.timer);
      shard.timer = null;
    }

    function removeShard(shard) {
      if (!shard) return;
      clearShardTimer(shard);
      if (shard.recoveryTimer) {
        clearTimeoutRef(shard.recoveryTimer);
        shard.recoveryTimer = null;
      }
      closeSource(shard);
      const index = shards.indexOf(shard);
      if (index >= 0) shards.splice(index, 1);
      for (const id of [...shard.ids]) {
        const record = records.get(id);
        if (record?.shard === shard) record.shard = null;
        shard.ids.delete(id);
      }
    }

    function scheduleReconcile(delayMs = 0) {
      if (closed || reconcileTimer !== null) return;
      reconcileTimer = setTimeoutRef(() => {
        reconcileTimer = null;
        reconcileAssignments();
      }, Math.max(0, Number(delayMs) || 0));
    }

    function scheduleShardRebuild(shard) {
      if (!shard || closed || shard.rebuildTimer) return;
      shard.rebuildTimer = setTimeoutRef(() => {
        shard.rebuildTimer = null;
        if (closed || !shard.ids.size || !shards.includes(shard)) {
          if (!shard.ids.size) removeShard(shard);
          return;
        }
        // Invalidate and close before constructing the replacement EventSource.
        clearShardTimer(shard);
        closeSource(shard);
        if (shard.mode === 'sse') connectShard(shard);
      }, 0);
    }

    function chooseShard(record) {
      const id = record.id;
      for (const shard of shards) {
        if (shardCanFit(shard, id)) return shard;
      }
      if (shards.length < MAX_SHARDS && textByteLength(buildTarget([id])) <= MAX_TARGET_BYTES) {
        const shard = { id: nextShardId++, ids: new Set(), source: null, epoch: 0, failureCount: 0, opened: false, mode: 'sse', timer: null, rebuildTimer: null, recoveryTimer: null };
        shards.push(shard);
        return shard;
      }
      return null;
    }

    function stopPollingRecord(record) {
      pollRecords.delete(record);
      record.transport = 'pending';
      record.pollToken += 1;
      if (record.pollAbortController) {
        try { record.pollAbortController.abort(); } catch {}
        record.pollAbortController = null;
      }
    }

    function assignRecordToShard(record, shard) {
      if (!record || !shard) return false;
      stopPollingRecord(record);
      record.shard = shard;
      record.transport = 'sse';
      shard.ids.add(record.id);
      return true;
    }

    function assignRecordToPolling(record) {
      if (!record) return;
      if (record.shard) {
        record.shard.ids.delete(record.id);
        record.shard = null;
      }
      record.transport = 'poll';
      pollRecords.add(record);
      schedulePoll();
    }

    function assignRecord(record) {
      const shard = chooseShard(record);
      if (shard) {
        const hadSource = !!shard.source;
        assignRecordToShard(record, shard);
        if (hadSource) scheduleShardRebuild(shard);
        return;
      }
      assignRecordToPolling(record);
    }

    function reconcileAssignments() {
      if (closed) return;
      for (const record of [...records.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
        if (record.transport !== 'pending') continue;
        assignRecord(record);
      }
      for (const shard of [...shards]) {
        if (!shard.ids.size) removeShard(shard);
        else if (!shard.source && shard.mode === 'sse') connectShard(shard);
      }
      for (const record of records.values()) {
        if (record.transport === 'poll') schedulePoll();
      }
    }

    function reconnectDelay(attempt) {
      const base = Math.min(1000 * (2 ** Math.max(0, attempt - 1)), 5000);
      const jitter = 0.8 + Math.max(0, Math.min(1, Number(randomRef()) || 0)) * 0.4;
      return Math.max(1000, Math.min(5000, Math.round(base * jitter)));
    }

    function demoteShardToPolling(shard) {
      if (!shard || shard.mode === 'poll' || closed) return;
      clearShardTimer(shard);
      closeSource(shard);
      shard.mode = 'poll';
      for (const id of [...shard.ids]) {
        const record = records.get(id);
        if (!record) continue;
        record.transport = 'poll';
        pollRecords.add(record);
      }
      schedulePoll();
      scheduleShardRecovery(shard);
    }

    function scheduleShardRecovery(shard) {
      if (!shard || closed || shard.recoveryTimer || shard.mode !== 'poll') return;
      shard.recoveryTimer = setTimeoutRef(() => {
        shard.recoveryTimer = null;
        if (closed || !shards.includes(shard) || shard.mode !== 'poll' || !shard.ids.size) return;
        const recordsInShard = [...shard.ids].map(id => records.get(id)).filter(Boolean);
        if (recordsInShard.some(record => record.pollInFlight)) return scheduleShardRecovery(shard);
        shard.mode = 'sse';
        shard.failureCount = 0;
        for (const record of recordsInShard) {
          pollRecords.delete(record);
          record.transport = 'sse';
        }
        connectShard(shard);
      }, POLL_INTERVAL_MS);
    }

    function handleShardFailure(shard, source) {
      if (closed || (source && shard.source !== source)) return;
      if (source) closeSource(shard);
      if (pageUnloading()) return;
      shard.failureCount += 1;
      if (shard.failureCount >= MAX_RECONNECT_FAILURES) return demoteShardToPolling(shard);
      clearShardTimer(shard);
      shard.timer = setTimeoutRef(() => {
        shard.timer = null;
        if (!closed && shard.mode === 'sse' && shard.ids.size) connectShard(shard);
      }, reconnectDelay(shard.failureCount));
    }

    function statusForEvent(current, event, hasData, hasDelta) {
      if (event.e !== undefined && event.e !== null && event.e !== '') return 'error';
      if (event.done) return 'done';
      if (event.status === 'done' || event.status === 'error') return event.status;
      if (typeof event.status === 'string' && event.status) return event.status;
      if (hasDelta || hasData) return 'running';
      return current?.status || 'running';
    }

    function applyEvent(record, incoming) {
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { valid: false };
      const current = record.aggregate && typeof record.aggregate === 'object' ? record.aggregate : {
        status: 'running',
        data: { choices: [{ message: { content: '', reasoning_content: '' } }] },
        metrics: {},
      };
      const hasData = eventOwn(incoming, 'data') && incoming.data && typeof incoming.data === 'object';
      const hasDelta = eventOwn(incoming, 'd') || eventOwn(incoming, 'r');
      const currentMessage = messageFromAggregate(current);
      const next = { ...current, ...incoming };
      delete next.id;
      const status = statusForEvent(current, incoming, hasData, hasDelta);
      if (isTerminalStatus(current.status) && !isTerminalStatus(status)) return { valid: true, changed: false, aggregate: current };
      if (hasData) {
        // A full snapshot is authoritative for the output fields it carries.
        next.data = incoming.data;
      } else {
        const message = { ...currentMessage };
        if (eventOwn(incoming, 'd')) message.content = String(message.content ?? '') + String(incoming.d ?? '');
        if (eventOwn(incoming, 'r')) message.reasoning_content = String(message.reasoning_content ?? '') + String(incoming.r ?? '');
        next.data = {
          ...(current.data && typeof current.data === 'object' ? current.data : {}),
          choices: [{ message }],
        };
      }
      next.status = status;
      next.metrics = {
        ...(current.metrics && typeof current.metrics === 'object' ? current.metrics : {}),
        ...(incoming.metrics && typeof incoming.metrics === 'object' ? incoming.metrics : {}),
        ...(Number.isFinite(incoming.ft) ? { firstTokenMs: incoming.ft } : {}),
        ...(Number.isFinite(incoming.rt) ? { durationMs: incoming.rt } : {}),
      };
      if (status === 'error') {
        next.error = typeof incoming.error === 'object' && incoming.error
          ? incoming.error
          : { message: String(incoming.e || (typeof incoming.error === 'string' ? incoming.error : incoming.error?.message) || current.error?.message || 'Managed job failed') };
      } else if (!eventOwn(incoming, 'error')) {
        next.error = current.error;
      }
      record.aggregate = next;
      if (record.shard) lastBuiltUrl = buildTarget([...record.shard.ids]);
      return { valid: true, changed: true, aggregate: next };
    }

    function finishWaiter(record, waiter, settle, value) {
      if (!waiter || waiter.done) return;
      waiter.done = true;
      record.waiters.delete(waiter);
      waiter.signal?.removeEventListener?.('abort', waiter.abortListener);
      settle(value);
      if (!record.waiters.size) removeRecord(record);
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
      const aggregate = record.aggregate || {};
      const terminal = aggregate.status === 'done' || aggregate.status === 'error';
      if (!terminal) return;
      const waiters = [...record.waiters];
      for (const waiter of waiters) {
        if (!deliver(record, waiter, aggregate)) continue;
        if (aggregate.status === 'done') {
          const data = aggregate.data && typeof aggregate.data === 'object'
            ? { ...aggregate.data, metrics: aggregate.metrics || aggregate.data.metrics || {} }
            : aggregate.data;
          finishWaiter(record, waiter, waiter.resolve, data);
        } else {
          finishWaiter(record, waiter, waiter.reject, terminalJobError(aggregate.error?.message || 'Managed job failed'));
        }
      }
    }

    function removeRecord(record) {
      if (!record || records.get(record.id) !== record) return;
      records.delete(record.id);
      stopPollingRecord(record);
      const shard = record.shard;
      record.shard = null;
      if (shard) {
        shard.ids.delete(record.id);
        if (!shard.ids.size) removeShard(shard);
        else if (shard.mode === 'sse') scheduleShardRebuild(shard);
        else scheduleShardRecovery(shard);
      }
      tryAssignOverflow();
      if (!pollRecords.size && pollTimer !== null) {
        clearTimeoutRef(pollTimer);
        pollTimer = null;
      }
    }

    function handleEnvelope(shard, source, epoch, envelope) {
      if (closed || shard.source !== source || shard.epoch !== epoch) return;
      const id = String(envelope?.id || '').trim();
      if (!id) return handleShardFailure(shard, source);
      const record = records.get(id);
      if (!record || record.transport !== 'sse' || record.shard !== shard) return;
      shard.failureCount = 0;
      const payload = { ...envelope };
      delete payload.id;
      const update = applyEvent(record, payload);
      if (!update.valid) return handleShardFailure(shard, source);
      if (!update.changed) return;
      if (isTerminalStatus(update.aggregate.status)) settleRecord(record);
      else for (const waiter of [...record.waiters]) deliver(record, waiter, update.aggregate);
    }

    function connectShard(shard) {
      if (closed || !shard || !shards.includes(shard) || shard.mode !== 'sse' || !shard.ids.size || shard.source) return;
      const url = buildTarget([...shard.ids]);
      lastBuiltUrl = url;
      let source;
      try {
        source = new EventSourceRef(url);
      } catch {
        handleShardFailure(shard);
        return;
      }
      const epoch = shard.epoch + 1;
      shard.epoch = epoch;
      shard.source = source;
      shard.opened = false;
      source.onopen = () => {
        if (closed || shard.source !== source || shard.epoch !== epoch || pageUnloading()) return;
        shard.opened = true;
      };
      source.onerror = () => handleShardFailure(shard, source);
      source.addEventListener('job', event => {
        if (closed || shard.source !== source || shard.epoch !== epoch) return;
        let envelope;
        try { envelope = JSON.parse(event?.data || ''); } catch { return handleShardFailure(shard, source); }
        handleEnvelope(shard, source, epoch, envelope);
      });
    }

    function schedulePoll() {
      if (closed || !pollRecords.size || pollTimer !== null) return;
      pollTimer = setTimeoutRef(() => {
        pollTimer = null;
        pumpPolls();
        if (pollRecords.size) schedulePoll();
      }, POLL_INTERVAL_MS);
    }

    function isServerPollError(error) {
      const status = Number(error?.statusCode || error?.status || 0);
      return error?.terminalJob === true || status === 404 || status >= 400;
    }

    async function runPoll(record) {
      if (closed || !record || records.get(record.id) !== record || record.transport !== 'poll' || record.pollInFlight) return;
      record.pollInFlight = true;
      activePolls += 1;
      const token = ++record.pollToken;
      const AbortControllerRef = root?.AbortController || (typeof AbortController === 'function' ? AbortController : null);
      const controller = AbortControllerRef ? new AbortControllerRef() : null;
      record.pollAbortController = controller;
      let timeoutId = null;
      let timedOut = false;
      try {
        const pollJob = record.pollJob || options.pollJob;
        const result = await new Promise((resolve, reject) => {
          timeoutId = setTimeoutRef(() => {
            timedOut = true;
            try { controller?.abort(); } catch {}
            reject(new Error('Chat Job GET polling timed out'));
          }, POLL_TIMEOUT_MS);
          Promise.resolve(typeof pollJob === 'function'
            ? pollJob(record.id, { signal: controller?.signal })
            : resolveDefaultPollJob(options, record.id, { signal: controller?.signal }))
            .then(resolve, reject);
        });
        if (closed || token !== record.pollToken || records.get(record.id) !== record || record.transport !== 'poll') return;
        if (!result || typeof result !== 'object') throw new Error('Invalid Chat Job polling response');
        record.pollFailures = 0;
        const payload = { ...result };
        delete payload.id;
        const update = applyEvent(record, payload);
        if (!update.valid) throw new Error('Invalid Chat Job polling response');
        if (update.changed) {
          if (isTerminalStatus(update.aggregate.status)) settleRecord(record);
          else for (const waiter of [...record.waiters]) deliver(record, waiter, update.aggregate);
        }
      } catch (error) {
        if (closed || token !== record.pollToken || records.get(record.id) !== record || record.transport !== 'poll') return;
        if (timedOut || error?.name === 'AbortError') {
          record.pollFailures += 1;
        } else if (isServerPollError(error)) {
          record.aggregate = { ...(record.aggregate || {}), status: 'error', error: { message: error.message || '任务不存在或服务已失败' } };
          settleRecord(record);
          return;
        } else {
          record.pollFailures += 1;
        }
        if (record.pollFailures >= MAX_POLL_FAILURES) {
          const unavailable = followerUnavailableError();
          for (const waiter of [...record.waiters]) {
            try { waiter.onFollowerStopped?.(unavailable, waiter.metadata); } catch {}
            finishWaiter(record, waiter, waiter.reject, unavailable);
          }
        }
      } finally {
        if (timeoutId !== null) clearTimeoutRef(timeoutId);
        if (record.pollAbortController === controller) record.pollAbortController = null;
        record.pollInFlight = false;
        activePolls = Math.max(0, activePolls - 1);
      }
    }

    function pumpPolls() {
      if (closed) return;
      for (const record of [...pollRecords].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
        if (activePolls >= POLL_CONCURRENCY) break;
        if (!record.pollInFlight) runPoll(record);
      }
    }

    function tryAssignOverflow() {
      if (closed) return;
      const waiting = [...pollRecords].filter(record => record.transport === 'poll').sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      for (const record of waiting) {
        const shard = chooseShard(record);
        if (!shard) continue;
        stopPollingRecord(record);
        assignRecordToShard(record, shard);
        if (!shard.source) connectShard(shard);
        else scheduleShardRebuild(shard);
      }
      if (pollRecords.size) schedulePoll();
    }

    function subscribe(jobId, onUpdate = () => {}, subscribeOptions = {}) {
      const id = String(jobId || '').trim();
      if (!id) return Promise.reject(new TypeError('jobId is required'));
      if (closed) return Promise.reject(abortError('任务事件管理器已关闭'));
      const existing = records.get(id);
      const requestedSessionId = String(subscribeOptions.sessionId || '');
      if (existing?.sessionId && requestedSessionId && existing.sessionId !== requestedSessionId) {
        return Promise.reject(sessionConflictError(id, existing.sessionId, requestedSessionId));
      }
      if (existing && !existing.sessionId && requestedSessionId) existing.sessionId = requestedSessionId;
      const record = existing || {
        id,
        aggregate: initialAggregate(subscribeOptions.resumeOffsets || {}),
        waiters: new Set(),
        sessionId: requestedSessionId,
        shard: null,
        transport: 'pending',
        pollJob: subscribeOptions.pollJob || null,
        pollFailures: 0,
        pollInFlight: false,
        pollAbortController: null,
        pollToken: 0,
      };
      if (!existing) records.set(id, record);
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
      if (!waiter.done && record.transport === 'pending') scheduleReconcile(0);
      return promise.finally(() => waiter.signal?.removeEventListener?.('abort', waiter.abortListener));
    }

    function close() {
      if (closed) return;
      closed = true;
      if (reconcileTimer !== null) clearTimeoutRef(reconcileTimer);
      reconcileTimer = null;
      if (pollTimer !== null) clearTimeoutRef(pollTimer);
      pollTimer = null;
      for (const shard of [...shards]) removeShard(shard);
      for (const record of [...records.values()]) {
        for (const waiter of [...record.waiters]) finishWaiter(record, waiter, waiter.reject, abortError());
      }
      records.clear();
      pollRecords.clear();
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

    function buildUrl() {
      const shard = shards.find(item => item.ids.size);
      if (!shard) return '';
      lastBuiltUrl = buildTarget([...shard.ids]);
      return lastBuiltUrl;
    }

    function getState() {
      return {
        closed,
        shardCount: shards.length,
        shards: shards.map(shard => ({
          id: shard.id,
          ids: stableSortIds([...shard.ids]),
          mode: shard.mode,
          sourceOpen: !!shard.source,
          failureCount: shard.failureCount,
          url: shard.ids.size ? buildTarget([...shard.ids]) : '',
        })),
        overflowJobIds: [...pollRecords].filter(record => record.transport === 'poll').map(record => record.id).sort(),
        pollConcurrency: activePolls,
        recordCount: records.size,
        lastBuiltUrl,
      };
    }

    return Object.freeze({ subscribe, close, buildUrl, getState, isClosed: () => closed });
  }

  const api = Object.freeze({ createJobEventMultiplexer, jobIdFromEventUrl });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  registry?.register?.('jobEventMultiplex', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
