(function initChatUISessionSnapshotRecovery(root) {
  'use strict';

  function createSessionSnapshotRecovery({
    getState = () => ({}),
    getActiveSession = () => null,
    deriveSessionTitle = () => '',
    localStorageRef = null,
    sessionStoreApi = {},
    snapshotStore = null,
    sessionsKey = 'chat-sessions',
    snapshotFallbackTailCount = 12,
    logger = console,
    snapshotCommitWaitMs = 2000,
    setTimeoutRef = globalThis.setTimeout,
    clearTimeoutRef = globalThis.clearTimeout,
    compactAdjacentDuplicateMessages = items => items,
    sanitizeStoredDisplayItem = item => item,
    sanitizeStoredMessage = message => message,
    messageIdentity = () => '',
    saveSessionsMeta = () => false,
  } = {}) {
    const SESSIONS_KEY = sessionsKey;
    const SNAPSHOT_FALLBACK_PREFIX = `${SESSIONS_KEY}:snapshot-fallback:`;
    const SNAPSHOT_FALLBACK_VERSION = 1;

        function buildSnapshot(session) {
          if (sessionStoreApi.buildSessionSnapshot) return sessionStoreApi.buildSessionSnapshot(session);
          return {
            id: session.id,
            snapshotVersion: 2,
            updatedAt: session.updatedAt || Date.now(),
            messages: session.messages || [],
            pendingDisplay: (session.display || []).filter(item => item?.pending === '1'),
            lastGeneratedImage: session.lastGeneratedImage || null,
          };
        }

        function nextPersistenceRevision(session) {
          const previous = Math.max(
            Number(session?.persistenceUpdatedAt || 0),
            Number(session?.snapshotUpdatedAt || 0)
          );
          const revision = Math.max(Date.now(), previous + 1);
          session.persistenceUpdatedAt = revision;
          return revision;
        }

        function snapshotFallbackKey(sessionId) {
          return `${SNAPSHOT_FALLBACK_PREFIX}${sessionId || ''}`;
        }

        function migrateSnapshot(snapshot) {
          if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
              || !Array.isArray(snapshot.messages)) return null;
          const version = Number(snapshot.snapshotVersion || snapshot.snapshot_version || 0);
          if (version >= 2) return { ...snapshot, snapshotVersion: 2 };
          if (version !== 1) return null;
          // v1 snapshots stored the transient display field under `display`.
          // Keep only pending items: completed assistant messages are already
          // canonical in `messages` and must not be duplicated on restore.
          const pendingDisplay = Array.isArray(snapshot.pendingDisplay)
            ? snapshot.pendingDisplay
            : Array.isArray(snapshot.display)
              ? snapshot.display.filter(item => String(item?.pending || '') === '1' || item?.pending === true)
              : [];
          return {
            ...snapshot,
            snapshotVersion: 2,
            pendingDisplay,
            lastGeneratedImage: snapshot.lastGeneratedImage || null,
          };
        }

        function isCurrentSnapshot(snapshot) {
          return !!migrateSnapshot(snapshot);
        }

        function isQuotaError(error) {
          return /quota|exceed/i.test(String(error?.name || error?.message || error || ''));
        }

        function compactFallbackMessage(message, minimal = false) {
          const clean = sanitizeStoredMessage(message || {});
          const compact = { ...clean };
          delete compact.html;
          if (compact.presentation && typeof compact.presentation === 'object' && !Array.isArray(compact.presentation)) {
            compact.presentation = { ...compact.presentation };
            delete compact.presentation.html;
          }
          if (!minimal) return compact;
          const essential = {};
          [
            'role', 'content', 'messageIndex', 'responseIndex', 'id', 'displayItemId',
            'jobId', 'imageJobId', 'reasoning_content', 'name', 'tool_call_id', 'tool_calls',
          ].forEach(key => {
            if (compact[key] !== undefined && compact[key] !== null && compact[key] !== '') essential[key] = compact[key];
          });
          if ((!Object.prototype.hasOwnProperty.call(essential, 'content') || typeof compact.content !== 'string') && compact.rawText) {
            essential.rawText = compact.rawText;
          }
          return essential;
        }

        function compactFallbackDisplayItem(item, minimal = false) {
          const clean = sanitizeStoredDisplayItem(item || {});
          const compact = { ...clean };
          delete compact.html;
          if (compact.presentation && typeof compact.presentation === 'object' && !Array.isArray(compact.presentation)) {
            compact.presentation = { ...compact.presentation };
            delete compact.presentation.html;
          }
          if (!minimal) return compact;
          const essential = {};
          ['id', 'role', 'rawText', 'messageIndex', 'responseIndex', 'jobId', 'pending', 'metaText'].forEach(key => {
            if (compact[key] !== undefined && compact[key] !== null && compact[key] !== '') essential[key] = compact[key];
          });
          return essential;
        }

        function buildFallbackCandidate(snapshot, { partial = false, tailCount = snapshotFallbackTailCount, minimal = false, baseUpdatedAt = 0 } = {}) {
          const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
          const selectedMessages = partial ? messages.slice(-Math.max(1, tailCount)) : messages;
          return {
            id: snapshot.id,
            snapshotVersion: 2,
            fallbackVersion: SNAPSHOT_FALLBACK_VERSION,
            partial: !!partial,
            baseUpdatedAt: Number(baseUpdatedAt || 0),
            updatedAt: Number(snapshot.updatedAt || 0),
            messages: selectedMessages.map(message => compactFallbackMessage(message, minimal)),
            pendingDisplay: (snapshot.pendingDisplay || []).map(item => compactFallbackDisplayItem(item, minimal)),
            lastGeneratedImage: snapshot.lastGeneratedImage || null,
          };
        }

        function readSnapshotFallback(sessionId) {
          if (!sessionId) return null;
          const key = snapshotFallbackKey(sessionId);
          try {
            const raw = localStorageRef.getItem(key);
            const parsed = raw ? JSON.parse(raw) : null;
            if (!raw || isCurrentSnapshot(parsed) && (!parsed.id || parsed.id === sessionId)) return parsed;
            try { localStorageRef.removeItem(key); } catch {}
            return null;
          } catch {
            try { localStorageRef.removeItem(key); } catch {}
            return null;
          }
        }

        function writeSnapshotFallback(snapshot, baseUpdatedAt = 0) {
          if (!isCurrentSnapshot(snapshot) || !snapshot.id) return false;
          const previous = readSnapshotFallback(snapshot.id);
          if (Number(previous?.updatedAt || 0) > Number(snapshot.updatedAt || 0)) return true;

          const partialTailCount = Math.min(snapshotFallbackTailCount, Math.max(1, snapshot.messages.length));
          const candidateFactories = [
            () => buildFallbackCandidate(snapshot, { baseUpdatedAt }),
            () => buildFallbackCandidate(snapshot, { partial: true, tailCount: partialTailCount, baseUpdatedAt }),
            () => buildFallbackCandidate(snapshot, { partial: true, tailCount: Math.min(6, partialTailCount), minimal: true, baseUpdatedAt }),
            () => buildFallbackCandidate(snapshot, { partial: true, tailCount: Math.min(2, partialTailCount), minimal: true, baseUpdatedAt }),
          ];

          let quotaError = null;
          for (const createCandidate of candidateFactories) {
            try {
              const candidate = createCandidate();
              localStorageRef.setItem(snapshotFallbackKey(snapshot.id), JSON.stringify(candidate));
              return true;
            } catch (error) {
              if (!isQuotaError(error)) {
                logger?.warn?.('save session snapshot fallback failed', error);
                return false;
              }
              quotaError = error;
            }
          }
          logger?.warn?.('save session snapshot fallback quota exceeded; retaining the previous recoverable revision', quotaError);
          return false;
        }

        function clearSnapshotFallback(sessionId, throughRevision = Infinity) {
          if (!sessionId) return;
          try {
            const fallback = readSnapshotFallback(sessionId);
            if (!fallback || Number(fallback.updatedAt || 0) <= Number(throughRevision)) {
              localStorageRef.removeItem(snapshotFallbackKey(sessionId));
            }
          } catch {}
        }

        function hasStoredSessionMetadata(sessionId) {
          if (!sessionId) return false;
          try {
            const raw = localStorageRef.getItem(SESSIONS_KEY);
            const stored = raw ? JSON.parse(raw) : null;
            return Array.isArray(stored) && stored.some(item => item?.id === sessionId);
          } catch {
            return false;
          }
        }

        function retainRecoverableSnapshot(snapshot, baseUpdatedAt = 0, reason = '') {
          // Metadata is written before the fallback so a quota boundary cannot leave
          // a brand-new snapshot without a session index entry. Both writes are
          // synchronous, which makes a completed in-memory reply refresh-safe while
          // its IndexedDB transaction is still pending.
          const metadataSaved = saveSessionsMeta();
          const metadataAvailable = metadataSaved || hasStoredSessionMetadata(snapshot?.id);
          const fallbackRetained = writeSnapshotFallback(snapshot, baseUpdatedAt);
          return {
            recoverable: !!fallbackRetained && !!metadataAvailable,
            fallbackRetained: !!fallbackRetained,
            metadataAvailable: !!metadataAvailable,
            metadataSaved: !!metadataSaved,
            reason: String(reason || ''),
          };
        }

        function createSessionPersistenceError(snapshot, reason, cause = null, recovery = null) {
          const error = new Error('消息未能写入浏览器持久化存储，请勿刷新页面，并检查浏览器存储权限或空间后重试。');
          error.name = 'SessionPersistenceError';
          error.code = 'SESSION_PERSISTENCE_FAILED';
          error.persistenceFailure = true;
          error.reason = String(reason || 'unknown');
          error.sessionId = String(snapshot?.id || '');
          error.revision = Number(snapshot?.updatedAt || 0);
          error.fallbackRetained = !!recovery?.fallbackRetained;
          error.metadataAvailable = !!recovery?.metadataAvailable;
          if (cause) error.cause = cause;
          return error;
        }

        function messageMergeIdentities(message = {}) {
          const identities = new Set([messageIdentity(message)].filter(Boolean));
          // Stable IDs are authoritative for new records, but a fallback can be
          // newer than an old IndexedDB snapshot that predates them. Keep the
          // canonical placement as a migration-only merge key so that same-turn
          // records replace one another rather than duplicating during recovery.
          const role = message?.role === 'user' ? 'user' : message?.role === 'assistant' ? 'assistant' : '';
          const rawIndex = role === 'user' ? message?.messageIndex : role === 'assistant' ? message?.responseIndex : null;
          const index = Number(rawIndex);
          if (role && Number.isFinite(index) && index >= 0) identities.add(`${role}:index:${index}`);
          return identities;
        }

        function mergePartialFallbackMessages(durableMessages = [], fallbackMessages = []) {
          const replacementIds = new Set(fallbackMessages.flatMap(message => [...messageMergeIdentities(message)]));
          const retainedDurable = durableMessages.filter(message => {
            const identities = messageMergeIdentities(message);
            return ![...identities].some(identity => replacementIds.has(identity));
          });
          return compactAdjacentDuplicateMessages([...retainedDurable, ...fallbackMessages]);
        }

        function withSnapshotSource(snapshot, durableUpdatedAt = 0) {
          const migrated = migrateSnapshot(snapshot);
          return migrated ? { ...migrated, durableUpdatedAt: Number(durableUpdatedAt || 0) } : null;
        }

        function mergeSnapshotFallback(durable, fallback) {
          const durableRevision = isCurrentSnapshot(durable) ? Number(durable.updatedAt || 0) : 0;
          if (!isCurrentSnapshot(fallback)) return withSnapshotSource(durable, durableRevision);
          if (!fallback.partial) return withSnapshotSource(fallback, durableRevision);
          if (!isCurrentSnapshot(durable)) return withSnapshotSource(fallback, 0);
          return withSnapshotSource({
            ...durable,
            ...fallback,
            messages: mergePartialFallbackMessages(durable.messages || [], fallback.messages || []),
            pendingDisplay: Object.prototype.hasOwnProperty.call(fallback, 'pendingDisplay')
              ? fallback.pendingDisplay || []
              : durable.pendingDisplay || [],
            lastGeneratedImage: fallback.lastGeneratedImage || durable.lastGeneratedImage || null,
          }, durableRevision);
        }

        async function readLatestSnapshot(sessionId) {
          const durableRead = Promise.resolve().then(async () => {
            const raw = await (snapshotStore?.getSnapshot?.(sessionId) || null);
            const migrated = migrateSnapshot(raw);
            if (raw && migrated && Number(raw.snapshotVersion || raw.snapshot_version || 0) === 1
                && typeof snapshotStore?.putSnapshot === 'function') {
              Promise.resolve(snapshotStore.putSnapshot(migrated)).catch(error => {
                logger?.warn?.('migrate legacy session snapshot failed', error);
              });
            }
            return migrated;
          }).catch(error => {
            logger?.warn?.('load session snapshot failed', error);
            return null;
          });
          let durable = null;
          if (!snapshotCommitWaitMs || typeof setTimeoutRef !== 'function') {
            durable = await durableRead;
          } else {
            let timeoutId = null;
            const boundedRead = new Promise(resolve => {
              timeoutId = setTimeoutRef(() => {
                logger?.warn?.(`load session snapshot is still pending after ${snapshotCommitWaitMs}ms; using recoverable fallback`);
                resolve(null);
              }, snapshotCommitWaitMs);
            });
            durable = await Promise.race([durableRead, boundedRead]);
            if (timeoutId !== null && typeof clearTimeoutRef === 'function') clearTimeoutRef(timeoutId);
          }

          const fallback = readSnapshotFallback(sessionId);
          const durableRevision = isCurrentSnapshot(durable) ? Number(durable.updatedAt || 0) : -1;
          const fallbackRevision = isCurrentSnapshot(fallback) ? Number(fallback.updatedAt || 0) : -1;
          if (durableRevision >= fallbackRevision) {
            if (durableRevision >= 0) clearSnapshotFallback(sessionId, durableRevision);
            return withSnapshotSource(durable, Math.max(0, durableRevision));
          }

          if (!isCurrentSnapshot(durable)) {
            durableRead.then(lateSnapshot => {
              const lateRevision = isCurrentSnapshot(lateSnapshot) ? Number(lateSnapshot.updatedAt || 0) : -1;
              const currentFallback = readSnapshotFallback(sessionId);
              if (lateRevision >= Number(currentFallback?.updatedAt || Infinity)) clearSnapshotFallback(sessionId, lateRevision);
            }).catch(() => {});
          }
          return mergeSnapshotFallback(durable, fallback);
        }

    return Object.freeze({
      buildSnapshot,
      migrateSnapshot,
      nextPersistenceRevision,
      isCurrentSnapshot,
      isQuotaError,
      readSnapshotFallback,
      writeSnapshotFallback,
      clearSnapshotFallback,
      retainRecoverableSnapshot,
      createSessionPersistenceError,
      messageMergeIdentities,
      mergePartialFallbackMessages,
      mergeSnapshotFallback,
      readLatestSnapshot,
    });
  }

  const api = Object.freeze({ createSessionSnapshotRecovery });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('sessionSnapshotRecovery', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
