(function initChatUIStreamCheckpointStore(root) {
  'use strict';

  const DB_NAME = 'openapi-chat-stream-checkpoint-db-v1';
  const STORE_NAME = 'stream_checkpoints';
  const DB_VERSION = 1;
  const CHECKPOINT_VERSION = 1;
  const DEFAULT_CONTENT_TAIL_LIMIT = 65536;
  const DEFAULT_REASONING_TAIL_LIMIT = 32768;
  const DEFAULT_MAX_ITEMS = 32;
  const DEFAULT_MAX_TOTAL_CHARS = 131072;
  const DEFAULT_READ_TIMEOUT_MS = 750;
  const DEFAULT_FLUSH_WAIT_MS = 2000;
  const DEFAULT_RETRY_BASE_MS = 500;
  const DEFAULT_RETRY_MAX_MS = 5000;
  const DEFAULT_WRITE_BATCH_SIZE = 8;

  function cloneValue(value) {
    if (!value) return value;
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
    } catch {}
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  }

  function boundedText(value, limit) {
    const text = String(value || '');
    if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
    return text.slice(-Math.floor(limit));
  }

  function sanitizeCheckpointText(value) {
    const text = String(value || '');
    if (!text.includes('data:')) return text;
    return text.replace(/data:[^\s"'()<>]{2048,}/gi, '[inline-media-omitted]');
  }

  function boundedMetadata(value, limit = 8192) {
    return boundedText(sanitizeCheckpointText(value), limit);
  }

  function checkpointItemKey(item = {}) {
    if (item.id) return `id:${item.id}`;
    if (item.jobId) return `job:${item.jobId}`;
    if (item.responseIndex !== undefined && item.responseIndex !== null && String(item.responseIndex) !== '') {
      return `response:${item.responseIndex}`;
    }
    return '';
  }

  function copyCheckpointItem(item = {}, {
    contentTailLimit = DEFAULT_CONTENT_TAIL_LIMIT,
    reasoningTailLimit = DEFAULT_REASONING_TAIL_LIMIT,
    remainingChars = DEFAULT_MAX_TOTAL_CHARS,
  } = {}) {
    const rawText = String(item.rawText || '');
    const reasoningText = String(item.reasoningText || '');
    const contentBudget = Math.max(0, Math.min(contentTailLimit, remainingChars));
    const contentTail = sanitizeCheckpointText(boundedText(rawText, contentBudget));
    const reasoningBudget = Math.max(0, Math.min(reasoningTailLimit, remainingChars - contentTail.length));
    const reasoningTail = sanitizeCheckpointText(boundedText(reasoningText, reasoningBudget));
    const copied = {
      id: String(item.id || ''),
      role: item.role || 'assistant',
      rawText: contentTail,
      reasoningText: reasoningTail,
      html: '',
      keepReasoning: !!item.keepReasoning && !!reasoningTail,
      messageIndex: item.messageIndex === undefined || item.messageIndex === null ? '' : String(item.messageIndex),
      responseIndex: item.responseIndex === undefined || item.responseIndex === null ? '' : String(item.responseIndex),
      messageId: String(item.messageId || ''),
      turnId: String(item.turnId || ''),
      replyToMessageId: String(item.replyToMessageId || ''),
      jobId: String(item.jobId || ''),
      imageContext: boundedMetadata(item.imageContext),
      attachmentContext: boundedMetadata(item.attachmentContext),
      quoteContext: boundedMetadata(item.quoteContext),
      metaText: boundedMetadata(item.metaText, 2048),
      outputStarted: !!item.outputStarted,
      pending: '1',
      streamCheckpoint: {
        version: CHECKPOINT_VERSION,
        contentLength: rawText.length,
        reasoningLength: reasoningText.length,
        contentTailStart: Math.max(0, rawText.length - contentBudget),
        reasoningTailStart: Math.max(0, reasoningText.length - reasoningBudget),
        tailOnly: rawText.length > contentBudget || reasoningText.length > reasoningBudget || contentTail.includes('[inline-media-omitted]') || reasoningTail.includes('[inline-media-omitted]'),
      },
    };
    return {
      item: copied,
      chars: contentTail.length + reasoningTail.length,
    };
  }

  function buildStreamCheckpoint(sessionId, items = [], options = {}) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const contentTailLimit = Math.max(0, Number(options.contentTailLimit ?? DEFAULT_CONTENT_TAIL_LIMIT) || 0);
    const reasoningTailLimit = Math.max(0, Number(options.reasoningTailLimit ?? DEFAULT_REASONING_TAIL_LIMIT) || 0);
    const maxItems = Math.max(1, Number(options.maxItems ?? DEFAULT_MAX_ITEMS) || DEFAULT_MAX_ITEMS);
    let remainingChars = Math.max(0, Number(options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS) || 0);
    const compacted = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || compacted.length >= maxItems) continue;
      const result = copyCheckpointItem(item, {
        contentTailLimit,
        reasoningTailLimit,
        remainingChars,
      });
      remainingChars = Math.max(0, remainingChars - result.chars);
      compacted.push(result.item);
    }
    return Object.freeze({
      version: CHECKPOINT_VERSION,
      sessionId: id,
      updatedAt: Math.max(0, Number(options.now ?? Date.now()) || 0),
      items: compacted,
    });
  }

  function mergeStreamCheckpointItems(snapshotItems = [], checkpoint = null) {
    const merged = (Array.isArray(snapshotItems) ? snapshotItems : []).map(item => ({ ...item }));
    if (!checkpoint || Number(checkpoint.version || 0) !== CHECKPOINT_VERSION || !Array.isArray(checkpoint.items)) {
      return merged;
    }
    const indexes = new Map();
    merged.forEach((item, index) => {
      const key = checkpointItemKey(item);
      if (key) indexes.set(key, index);
    });
    for (const item of checkpoint.items) {
      if (!item || (item.pending !== undefined && String(item.pending) !== '1')) continue;
      const key = checkpointItemKey(item);
      const tailOnly = !!item.streamCheckpoint?.tailOnly;
      const existing = key && indexes.has(key) ? merged[indexes.get(key)] : null;
      const restored = {
        ...item,
        html: '',
        pending: '1',
        streamCheckpointRecovered: true,
        streamCheckpointTailOnly: tailOnly,
        streamCheckpointUpdatedAt: Number(checkpoint.updatedAt || 0),
      };
      delete restored.streamCheckpoint;
      // A cursor only stores a bounded window, so its text can be shorter than
      // the durable projection for the same item. The longer of the two is the
      // only text that cannot silently drop the head of a long artifact (for
      // example a generated webpage); the cursor still contributes identity,
      // job binding, and the tail-only marker. Resume offsets are derived from
      // whichever text survives here, never from the shorter one.
      if (existing) {
        const cursorContent = String(item.rawText || '');
        const cursorReasoning = String(item.reasoningText || '');
        const durableContent = String(existing.rawText || '');
        const durableReasoning = String(existing.reasoningText || '');
        if (durableContent.length >= cursorContent.length) restored.rawText = durableContent;
        if (durableReasoning.length >= cursorReasoning.length) restored.reasoningText = durableReasoning;
      }
      if (key && indexes.has(key)) merged[indexes.get(key)] = restored;
      else {
        if (key) indexes.set(key, merged.length);
        merged.push(restored);
      }
    }
    return merged;
  }

  function createStreamCheckpointStore({
    indexedDBImpl = root?.indexedDB,
    dbName = DB_NAME,
    storeName = STORE_NAME,
    logger = root?.console || console,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    flushWaitMs = DEFAULT_FLUSH_WAIT_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_MS,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_MS,
    writeBatchSize = DEFAULT_WRITE_BATCH_SIZE,
    setTimeoutImpl = root?.setTimeout || globalThis.setTimeout,
    clearTimeoutImpl = root?.clearTimeout || globalThis.clearTimeout,
  } = {}) {
    const supported = !!indexedDBImpl?.open;
    let dbPromise = null;
    let activeDb = null;
    let drainScheduled = false;
    let draining = false;
    let retryTimer = null;
    let retryAttempt = 0;
    let closed = false;
    const pending = new Map();
    const deletedSessionIds = new Set();
    const flushWaiters = new Set();

    function setTimer(callback, delay) {
      return typeof setTimeoutImpl === 'function' ? setTimeoutImpl(callback, delay) : null;
    }

    function clearTimer(timer) {
      if (timer !== null && timer !== undefined && typeof clearTimeoutImpl === 'function') clearTimeoutImpl(timer);
    }

    function closeDatabase(db) {
      try { db?.close?.(); } catch {}
    }

    function resetConnection(db = null) {
      if (db && activeDb && db !== activeDb) return;
      const current = activeDb;
      activeDb = null;
      dbPromise = null;
      closeDatabase(db || current);
    }

    function openDb() {
      if (!supported || closed) return Promise.resolve(null);
      if (activeDb) return Promise.resolve(activeDb);
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        let request;
        try { request = indexedDBImpl.open(dbName, DB_VERSION); }
        catch (error) { reject(error); return; }
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        };
        request.onsuccess = () => {
          const db = request.result;
          activeDb = db;
          try {
            db.onversionchange = () => resetConnection(db);
            db.onclose = () => {
              if (activeDb === db) {
                activeDb = null;
                dbPromise = null;
              }
            };
          } catch {}
          resolve(db);
        };
        request.onerror = () => reject(request.error || new Error('Unable to open stream checkpoint database'));
        request.onblocked = () => logger?.warn?.('stream checkpoint database upgrade blocked');
      }).catch(error => {
        dbPromise = null;
        throw error;
      });
      return dbPromise;
    }

    function settleFlushWaiters() {
      if (pending.size || draining || retryTimer !== null) return;
      for (const waiter of [...flushWaiters]) {
        flushWaiters.delete(waiter);
        waiter.resolve(true);
      }
    }

    async function putRecords(records) {
      const db = await openDb();
      if (!db) return false;
      return new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(storeName, 'readwrite'); }
        catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('Stream checkpoint transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('Stream checkpoint transaction aborted'));
        try {
          const store = tx.objectStore(storeName);
          for (const [sessionId, checkpoint] of records) {
            if (deletedSessionIds.has(sessionId)) store.delete(sessionId);
            else store.put(checkpoint, sessionId);
          }
        } catch (error) {
          try { tx.abort(); } catch {}
          reject(error);
        }
      });
    }

    function scheduleRetry() {
      if (closed || retryTimer !== null || typeof setTimeoutImpl !== 'function') return;
      const delay = Math.min(
        Math.max(0, Number(retryMaxDelayMs) || 0),
        Math.max(0, Number(retryBaseDelayMs) || 0) * (2 ** Math.min(retryAttempt, 4))
      );
      retryAttempt += 1;
      retryTimer = setTimer(() => {
        retryTimer = null;
        scheduleDrain();
      }, delay);
    }

    async function drain() {
      drainScheduled = false;
      if (closed || draining) return;
      draining = true;
      try {
        while (!closed && pending.size) {
          const batch = [...pending.entries()].slice(0, Math.max(1, Number(writeBatchSize) || 1));
          for (const [sessionId] of batch) pending.delete(sessionId);
          try {
            await putRecords(batch);
            retryAttempt = 0;
          } catch (error) {
            if (!closed) {
              for (const [sessionId, checkpoint] of batch) {
                if (!pending.has(sessionId)) pending.set(sessionId, checkpoint);
              }
              logger?.warn?.('stream checkpoint write failed; retaining latest cursor', error);
              scheduleRetry();
            }
            break;
          }
        }
      } finally {
        draining = false;
      }
      if (pending.size && retryTimer === null && !closed) scheduleDrain();
      settleFlushWaiters();
    }

    function scheduleDrain() {
      if (closed || drainScheduled || draining) return;
      drainScheduled = true;
      Promise.resolve().then(drain);
    }

    function schedulePut(sessionId, items) {
      const checkpoint = buildStreamCheckpoint(sessionId, items);
      if (!checkpoint) return Promise.resolve(null);
      deletedSessionIds.delete(checkpoint.sessionId);
      if (!checkpoint.items.length) return deleteCheckpoint(checkpoint.sessionId);
      if (!supported) return Promise.resolve(checkpoint);
      pending.set(checkpoint.sessionId, checkpoint);
      scheduleDrain();
      return Promise.resolve(checkpoint);
    }

    function withReadTimeout(promise) {
      const timeout = Math.max(0, Number(readTimeoutMs) || 0);
      if (!timeout || typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') return promise;
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimer(() => {
          if (settled) return;
          settled = true;
          resolve(null);
        }, timeout);
        Promise.resolve(promise).then(value => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          resolve(value);
        }, error => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          reject(error);
        });
      });
    }

    async function readStoredCheckpoint(sessionId) {
      const db = await openDb();
      if (!db) return null;
      return new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(storeName, 'readonly'); }
        catch (error) { reject(error); return; }
        let request;
        tx.oncomplete = () => resolve(request?.result || null);
        tx.onerror = () => reject(tx.error || new Error('Stream checkpoint read failed'));
        tx.onabort = () => reject(tx.error || new Error('Stream checkpoint read aborted'));
        try { request = tx.objectStore(storeName).get(sessionId); }
        catch (error) { reject(error); }
      });
    }

    async function get(sessionId) {
      const id = String(sessionId || '').trim();
      if (!id || deletedSessionIds.has(id)) return null;
      if (pending.has(id)) return cloneValue(pending.get(id));
      if (!supported) return null;
      try {
        const stored = await withReadTimeout(readStoredCheckpoint(id));
        if (!stored || Number(stored.version || 0) !== CHECKPOINT_VERSION || stored.sessionId !== id || !Array.isArray(stored.items)) return null;
        return cloneValue(stored);
      } catch (error) {
        logger?.warn?.('read stream checkpoint failed', error);
        return null;
      }
    }

    async function deleteCheckpoint(sessionId) {
      const id = String(sessionId || '').trim();
      if (!id) return false;
      deletedSessionIds.add(id);
      pending.delete(id);
      if (!supported) {
        settleFlushWaiters();
        return true;
      }
      try {
        const db = await openDb();
        if (!db) return true;
        await new Promise((resolve, reject) => {
          let tx;
          try { tx = db.transaction(storeName, 'readwrite'); }
          catch (error) { reject(error); return; }
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error || new Error('Stream checkpoint delete failed'));
          tx.onabort = () => reject(tx.error || new Error('Stream checkpoint delete aborted'));
          tx.objectStore(storeName).delete(id);
        });
        return true;
      } catch (error) {
        logger?.warn?.('delete stream checkpoint failed', error);
        return false;
      } finally {
        settleFlushWaiters();
      }
    }

    async function flush(sessionId = '') {
      const id = String(sessionId || '').trim();
      if (id && !pending.has(id) && !draining) return true;
      if (!pending.size && !draining && retryTimer === null) return true;
      return new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        flushWaiters.add({ resolve: finish });
        if (Number(flushWaitMs) > 0 && typeof setTimeoutImpl === 'function') {
          setTimer(() => {
            flushWaiters.forEach(waiter => {
              if (waiter.resolve === finish) flushWaiters.delete(waiter);
            });
            finish(false);
          }, Math.max(0, Number(flushWaitMs) || 0));
        }
      });
    }

    async function clear() {
      pending.clear();
      deletedSessionIds.clear();
      if (!supported) {
        settleFlushWaiters();
        return;
      }
      const db = await openDb();
      if (!db) return;
      await new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(storeName, 'readwrite'); }
        catch (error) { reject(error); return; }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Stream checkpoint clear failed'));
        tx.onabort = () => reject(tx.error || new Error('Stream checkpoint clear aborted'));
        tx.objectStore(storeName).clear();
      });
    }

    function close() {
      closed = true;
      clearTimer(retryTimer);
      retryTimer = null;
      pending.clear();
      resetConnection();
      settleFlushWaiters();
    }

    return Object.freeze({ supported, clear, close, delete: deleteCheckpoint, flush, get, schedulePut, stats: () => ({ pending: pending.size, draining, retryPending: retryTimer !== null }) });
  }

  const api = Object.freeze({
    DB_NAME,
    STORE_NAME,
    CHECKPOINT_VERSION,
    DEFAULT_CONTENT_TAIL_LIMIT,
    DEFAULT_REASONING_TAIL_LIMIT,
    DEFAULT_MAX_TOTAL_CHARS,
    buildStreamCheckpoint,
    mergeStreamCheckpointItems,
    createStreamCheckpointStore,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  registry?.register?.('streamCheckpointStore', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
