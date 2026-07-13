(function initChatUISessionStore(root) {
  'use strict';

  const DB_NAME = 'openapi-chat-session-db-v2';
  const STORE_NAME = 'sessions';
  const DB_VERSION = 1;
  const SNAPSHOT_VERSION = 2;

  function cloneSnapshot(value) {
    if (!value) return value;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function createSessionSnapshotStore({ indexedDBImpl = root?.indexedDB, dbName = DB_NAME, storeName = STORE_NAME, logger = root?.console || console } = {}) {
    let dbPromise = null;
    const writeQueues = new Map();
    const pendingSnapshots = new Map();
    const deletedSessionIds = new Set();
    const supported = !!indexedDBImpl?.open;

    function openDb() {
      if (!supported) return Promise.resolve(null);
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDBImpl.open(dbName, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('无法打开会话数据库'));
        request.onblocked = () => logger?.warn?.('session snapshot database upgrade blocked');
      }).catch(error => {
        dbPromise = null;
        throw error;
      });
      return dbPromise;
    }

    async function transact(mode, operation) {
      const db = await openDb();
      if (!db) return null;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        try { result = operation(store, tx); } catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('会话数据库事务失败'));
        tx.onabort = () => reject(tx.error || new Error('会话数据库事务已中止'));
      });
    }

    async function getSnapshot(sessionId) {
      if (!sessionId || !supported) return null;
      const db = await openDb();
      if (!db) return null;
      return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(sessionId);
        request.onsuccess = () => resolve(request.result ? cloneSnapshot(request.result) : null);
        request.onerror = () => reject(request.error || new Error('读取会话快照失败'));
      });
    }

    async function putSnapshot(snapshot) {
      if (!snapshot?.id || !supported || deletedSessionIds.has(snapshot.id)) return snapshot || null;
      const durable = cloneSnapshot({ ...snapshot, snapshotVersion: SNAPSHOT_VERSION, persistedAt: Date.now() });
      await transact('readwrite', store => store.put(durable, durable.id));
      return snapshot;
    }

    function schedulePut(snapshot) {
      if (!snapshot?.id || !supported || deletedSessionIds.has(snapshot.id)) return Promise.resolve(snapshot || null);
      const sessionId = snapshot.id;
      pendingSnapshots.set(sessionId, cloneSnapshot(snapshot));
      const current = writeQueues.get(sessionId);
      if (current) return current;
      const next = Promise.resolve().then(async () => {
        let result = snapshot;
        while (pendingSnapshots.has(sessionId) && !deletedSessionIds.has(sessionId)) {
          const latest = pendingSnapshots.get(sessionId);
          pendingSnapshots.delete(sessionId);
          result = await putSnapshot(latest);
        }
        return result;
      }).catch(error => {
        logger?.warn?.('save session snapshot failed', error);
        throw error;
      });
      writeQueues.set(sessionId, next);
      next.finally(() => { if (writeQueues.get(sessionId) === next) writeQueues.delete(sessionId); }).catch(() => {});
      return next;
    }

    async function flush(sessionId = '') {
      if (sessionId) return (writeQueues.get(sessionId) || Promise.resolve()).catch(() => {});
      await Promise.allSettled([...writeQueues.values()]);
    }

    async function deleteSnapshot(sessionId) {
      if (!sessionId || !supported) return;
      deletedSessionIds.add(sessionId);
      pendingSnapshots.delete(sessionId);
      await transact('readwrite', store => store.delete(sessionId));
      writeQueues.delete(sessionId);
    }

    async function clear() {
      if (!supported) return;
      [...writeQueues.keys()].forEach(sessionId => deletedSessionIds.add(sessionId));
      pendingSnapshots.clear();
      await transact('readwrite', store => store.clear());
      writeQueues.clear();
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

  const api = Object.freeze({ DB_NAME, STORE_NAME, DB_VERSION, SNAPSHOT_VERSION, cloneSnapshot, createSessionSnapshotStore, buildSessionSnapshot });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUISessionStore = api;
  if (root?.window) root.window.ChatUISessionStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
