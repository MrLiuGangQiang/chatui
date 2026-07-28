(function initChatUISessionStore(root) {
  'use strict';

  const DB_NAME = 'openapi-chat-session-db-v2';
  const STORE_NAME = 'sessions';
  const DB_VERSION = 1;
  const SNAPSHOT_VERSION = 2;
  const DEFAULT_OPERATION_TIMEOUT_MS = 5000;
  const DEFAULT_RETRY_BASE_DELAY_MS = 500;
  const DEFAULT_RETRY_MAX_DELAY_MS = 5000;

  function cloneSnapshot(value) {
    if (!value) return value;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function createSessionSnapshotStore({
    indexedDBImpl = root?.indexedDB,
    dbName = DB_NAME,
    storeName = STORE_NAME,
    logger = root?.console || console,
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    flushWaitMs = operationTimeoutMs,
    setTimeoutImpl = root?.setTimeout || globalThis.setTimeout,
    clearTimeoutImpl = root?.clearTimeout || globalThis.clearTimeout,
  } = {}) {
    const boundedOperationTimeoutMs = Math.max(0, Number(operationTimeoutMs) || 0);
    const boundedRetryBaseDelayMs = Math.max(0, Number(retryBaseDelayMs) || 0);
    const boundedRetryMaxDelayMs = Math.max(boundedRetryBaseDelayMs, Number(retryMaxDelayMs) || 0);
    const boundedFlushWaitMs = Math.max(0, Number(flushWaitMs) || 0);
    let dbPromise = null;
    let activeDb = null;
    const writeQueues = new Map();
    const pendingSnapshots = new Map();
    const retryTimers = new Map();
    const retryAttempts = new Map();
    const deletedSessionIds = new Set();
    const activeTransactions = new Set();
    const supported = !!indexedDBImpl?.open;

    function setTimer(callback, delay) {
      return typeof setTimeoutImpl === 'function' ? setTimeoutImpl(callback, delay) : null;
    }

    function clearTimer(timer) {
      if (timer !== null && timer !== undefined && typeof clearTimeoutImpl === 'function') clearTimeoutImpl(timer);
    }

    function createNamedError(name, message, code = '') {
      const error = new Error(message);
      error.name = name;
      if (code) error.code = code;
      return error;
    }

    function createTimeoutError(operation) {
      const error = createNamedError(
        'IndexedDBTimeoutError',
        `IndexedDB ${operation} timed out after ${boundedOperationTimeoutMs}ms`,
        'IDB_OPERATION_TIMEOUT'
      );
      error.transient = true;
      return error;
    }

    function isRetryableError(error) {
      if (error?.transient === true || error?.code === 'IDB_OPERATION_TIMEOUT') return true;
      return ['AbortError', 'UnknownError', 'InvalidStateError', 'TransactionInactiveError', 'TimeoutError']
        .includes(String(error?.name || ''));
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

    function configureDatabase(db) {
      try {
        db.onversionchange = () => {
          logger?.warn?.('session snapshot database version changed; reopening connection');
          resetConnection(db);
        };
      } catch {}
      try {
        db.onclose = () => {
          if (activeDb === db) {
            activeDb = null;
            dbPromise = null;
          }
        };
      } catch {}
    }

    function openDb() {
      if (!supported) return Promise.resolve(null);
      if (activeDb) return Promise.resolve(activeDb);
      if (dbPromise) return dbPromise;

      let guardedPromise;
      const openingPromise = new Promise((resolve, reject) => {
        let request;
        let settled = false;
        let timeoutId = null;

        function finish(error, db) {
          if (settled) {
            if (db) closeDatabase(db);
            return;
          }
          settled = true;
          clearTimer(timeoutId);
          if (error) reject(error);
          else {
            activeDb = db;
            configureDatabase(db);
            resolve(db);
          }
        }

        try {
          request = indexedDBImpl.open(dbName, DB_VERSION);
        } catch (error) {
          finish(error);
          return;
        }

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        };
        request.onsuccess = () => finish(null, request.result);
        request.onerror = () => finish(request.error || new Error('Unable to open the session snapshot database'));
        request.onblocked = () => logger?.warn?.('session snapshot database upgrade blocked');

        if (boundedOperationTimeoutMs && typeof setTimeoutImpl === 'function') {
          timeoutId = setTimer(() => finish(createTimeoutError('open')), boundedOperationTimeoutMs);
        }
      });

      guardedPromise = openingPromise.catch(error => {
        if (dbPromise === guardedPromise) dbPromise = null;
        throw error;
      });
      dbPromise = guardedPromise;
      return guardedPromise;
    }

    function registerTransaction(tx, sessionId, mode) {
      const entry = { tx, sessionId: sessionId || '', mode };
      activeTransactions.add(entry);
      return () => activeTransactions.delete(entry);
    }

    async function transact(mode, operation, { operationName = `${mode} transaction`, sessionId = '' } = {}) {
      const db = await openDb();
      if (!db) return null;
      return new Promise((resolve, reject) => {
        let tx;
        let request;
        let operationResult;
        let settled = false;
        let timeoutId = null;
        let unregister = () => {};

        function cleanup() {
          clearTimer(timeoutId);
          unregister();
          try {
            tx.oncomplete = null;
            tx.onerror = null;
            tx.onabort = null;
          } catch {}
          try { if (request && typeof request === 'object') request.onerror = null; } catch {}
        }

        function finish(error, value, { reset = false } = {}) {
          if (settled) return;
          settled = true;
          cleanup();
          if (reset) resetConnection(db);
          if (error) reject(error);
          else resolve(value);
        }

        try {
          tx = db.transaction(storeName, mode);
        } catch (error) {
          finish(error, null, { reset: isRetryableError(error) });
          return;
        }

        unregister = registerTransaction(tx, sessionId, mode);
        tx.oncomplete = () => {
          let value = operationResult;
          try {
            if (request && typeof request === 'object' && 'result' in request) value = request.result;
          } catch {}
          finish(null, value);
        };
        tx.onerror = () => {
          const error = tx.error || createNamedError('UnknownError', 'Session snapshot transaction failed');
          finish(error, null, { reset: isRetryableError(error) });
        };
        tx.onabort = () => {
          const error = tx.error || createNamedError('AbortError', 'Session snapshot transaction was aborted');
          finish(error, null, { reset: isRetryableError(error) });
        };

        try {
          const store = tx.objectStore(storeName);
          operationResult = operation(store, tx);
          request = operationResult && typeof operationResult === 'object' ? operationResult : null;
          if (request && 'onerror' in request) {
            request.onerror = () => {
              const error = request.error || createNamedError('UnknownError', `Session snapshot ${operationName} failed`);
              finish(error, null, { reset: isRetryableError(error) });
              try { tx.abort(); } catch {}
            };
          }
        } catch (error) {
          finish(error, null, { reset: isRetryableError(error) });
          try { tx.abort(); } catch {}
          return;
        }

        if (boundedOperationTimeoutMs && typeof setTimeoutImpl === 'function') {
          timeoutId = setTimer(() => {
            const error = createTimeoutError(operationName);
            finish(error, null, { reset: true });
            try { tx.abort(); } catch {}
          }, boundedOperationTimeoutMs);
        }
      });
    }

    async function getSnapshot(sessionId) {
      if (!sessionId || !supported) return null;
      const result = await transact('readonly', store => store.get(sessionId), {
        operationName: 'snapshot read',
        sessionId,
      });
      return result ? cloneSnapshot(result) : null;
    }

    async function putSnapshot(snapshot) {
      if (!snapshot?.id || !supported || deletedSessionIds.has(snapshot.id)) return snapshot || null;
      const durable = cloneSnapshot({ ...snapshot, snapshotVersion: SNAPSHOT_VERSION, persistedAt: Date.now() });
      await transact('readwrite', store => store.put(durable, durable.id), {
        operationName: 'snapshot write',
        sessionId: snapshot.id,
      });
      return snapshot;
    }

    function snapshotRevision(snapshot) {
      const value = Number(snapshot?.updatedAt || 0);
      return Number.isFinite(value) ? value : 0;
    }

    function retainLatestPending(sessionId, snapshot) {
      if (!snapshot || deletedSessionIds.has(sessionId)) return;
      const current = pendingSnapshots.get(sessionId);
      if (!current || snapshotRevision(snapshot) >= snapshotRevision(current)) {
        pendingSnapshots.set(sessionId, cloneSnapshot(snapshot));
      }
    }

    function cancelRetry(sessionId) {
      const timer = retryTimers.get(sessionId);
      if (timer !== undefined) clearTimer(timer);
      retryTimers.delete(sessionId);
      retryAttempts.delete(sessionId);
    }

    function settleQueue(sessionId, queue, error, value) {
      if (!queue || queue.settled) return;
      queue.settled = true;
      queue.running = false;
      cancelRetry(sessionId);
      if (writeQueues.get(sessionId) === queue) writeQueues.delete(sessionId);
      if (error) queue.reject(error);
      else queue.resolve(value);
    }

    function scheduleRetry(sessionId, queue, error) {
      if (deletedSessionIds.has(sessionId) || writeQueues.get(sessionId) !== queue) {
        settleQueue(sessionId, queue, null, null);
        return;
      }
      if (typeof setTimeoutImpl !== 'function') {
        settleQueue(sessionId, queue, error);
        return;
      }
      const attempt = (retryAttempts.get(sessionId) || 0) + 1;
      retryAttempts.set(sessionId, attempt);
      const exponentialDelay = boundedRetryBaseDelayMs * (2 ** Math.max(0, attempt - 1));
      const delay = Math.min(boundedRetryMaxDelayMs, exponentialDelay);
      logger?.warn?.(`save session snapshot failed; retrying in ${delay}ms`, error);
      const timer = setTimer(() => {
        if (retryTimers.get(sessionId) === timer) retryTimers.delete(sessionId);
        drainWriteQueue(sessionId, queue);
      }, delay);
      retryTimers.set(sessionId, timer);
    }

    async function drainWriteQueue(sessionId, queue) {
      if (!queue || queue.settled || queue.running || retryTimers.has(sessionId) || writeQueues.get(sessionId) !== queue) return;
      if (deletedSessionIds.has(sessionId)) {
        settleQueue(sessionId, queue, null, null);
        return;
      }

      queue.running = true;
      let attempted = null;
      try {
        while (pendingSnapshots.has(sessionId) && !deletedSessionIds.has(sessionId)) {
          attempted = pendingSnapshots.get(sessionId);
          pendingSnapshots.delete(sessionId);
          queue.lastResult = await putSnapshot(attempted);
          attempted = null;
          retryAttempts.delete(sessionId);
        }
        if (deletedSessionIds.has(sessionId)) settleQueue(sessionId, queue, null, null);
        else settleQueue(sessionId, queue, null, queue.lastResult);
      } catch (error) {
        queue.running = false;
        if (deletedSessionIds.has(sessionId)) {
          settleQueue(sessionId, queue, null, null);
          return;
        }
        if (isRetryableError(error)) {
          retainLatestPending(sessionId, attempted);
          scheduleRetry(sessionId, queue, error);
          return;
        }

        logger?.warn?.('save session snapshot failed permanently', error);
        const pending = pendingSnapshots.get(sessionId);
        if (pending && snapshotRevision(pending) > snapshotRevision(attempted)) {
          Promise.resolve().then(() => drainWriteQueue(sessionId, queue));
          return;
        }
        settleQueue(sessionId, queue, error);
      } finally {
        if (!queue.settled) queue.running = false;
      }
    }

    function schedulePut(snapshot) {
      if (!snapshot?.id || !supported) return Promise.resolve(snapshot || null);
      if (deletedSessionIds.has(snapshot.id)) return Promise.resolve(null);
      const sessionId = snapshot.id;
      retainLatestPending(sessionId, snapshot);
      const current = writeQueues.get(sessionId);
      if (current) return current.promise;

      let resolveQueue;
      let rejectQueue;
      const promise = new Promise((resolve, reject) => {
        resolveQueue = resolve;
        rejectQueue = reject;
      });
      const queue = {
        promise,
        resolve: resolveQueue,
        reject: rejectQueue,
        running: false,
        settled: false,
        lastResult: snapshot,
      };
      writeQueues.set(sessionId, queue);
      Promise.resolve().then(() => drainWriteQueue(sessionId, queue));
      return promise;
    }

    function waitWithin(promise, timeoutMs) {
      if (!timeoutMs || typeof setTimeoutImpl !== 'function') return Promise.resolve(promise);
      return new Promise(resolve => {
        let settled = false;
        const timeoutId = setTimer(() => {
          if (settled) return;
          settled = true;
          resolve();
        }, timeoutMs);
        Promise.resolve(promise).finally(() => {
          if (settled) return;
          settled = true;
          clearTimer(timeoutId);
          resolve();
        }).catch(() => {});
      });
    }

    async function flush(sessionId = '') {
      const promises = sessionId
        ? [writeQueues.get(sessionId)?.promise].filter(Boolean)
        : [...writeQueues.values()].map(queue => queue.promise);
      if (!promises.length) return;
      await waitWithin(Promise.allSettled(promises), boundedFlushWaitMs);
    }

    function abortTransactions(predicate) {
      for (const entry of [...activeTransactions]) {
        if (!predicate(entry)) continue;
        try { entry.tx.abort(); } catch {}
      }
    }

    async function deleteSnapshot(sessionId) {
      if (!sessionId) return;
      deletedSessionIds.add(sessionId);
      pendingSnapshots.delete(sessionId);
      cancelRetry(sessionId);
      const queue = writeQueues.get(sessionId);
      if (queue) settleQueue(sessionId, queue, null, null);
      abortTransactions(entry => entry.mode === 'readwrite' && entry.sessionId === sessionId);
      if (!supported) return;
      await transact('readwrite', store => store.delete(sessionId), {
        operationName: 'snapshot delete',
        sessionId,
      });
    }

    async function clear() {
      const affectedSessionIds = new Set([
        ...writeQueues.keys(),
        ...pendingSnapshots.keys(),
        ...retryTimers.keys(),
      ]);
      affectedSessionIds.forEach(sessionId => {
        deletedSessionIds.add(sessionId);
        pendingSnapshots.delete(sessionId);
        cancelRetry(sessionId);
        const queue = writeQueues.get(sessionId);
        if (queue) settleQueue(sessionId, queue, null, null);
      });
      abortTransactions(entry => entry.mode === 'readwrite');
      if (!supported) return;
      await transact('readwrite', store => store.clear(), { operationName: 'snapshot clear' });
    }

    return Object.freeze({ supported, openDb, getSnapshot, putSnapshot, schedulePut, flush, deleteSnapshot, clear });
  }

  function buildSessionSnapshot(session = {}) {
    return {
      id: session.id,
      snapshotVersion: SNAPSHOT_VERSION,
      updatedAt: session.snapshotUpdatedAt || session.updatedAt || Date.now(),
      messages: Array.isArray(session.messages) ? session.messages : [],
      pendingDisplay: Array.isArray(session.display) ? session.display.filter(item => item?.pending === '1') : [],
      lastGeneratedImage: session.lastGeneratedImage || null,
    };
  }

  const api = Object.freeze({
    DB_NAME,
    STORE_NAME,
    DB_VERSION,
    SNAPSHOT_VERSION,
    DEFAULT_OPERATION_TIMEOUT_MS,
    DEFAULT_RETRY_BASE_DELAY_MS,
    DEFAULT_RETRY_MAX_DELAY_MS,
    cloneSnapshot,
    createSessionSnapshotStore,
    buildSessionSnapshot,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUISessionStore = api;
  if (root?.window) root.window.ChatUISessionStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
