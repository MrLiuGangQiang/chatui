(function initChatUIAppSessionDisplay(root) {
  'use strict';

  const snapshotRecoveryModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('sessionSnapshotRecovery')
    || (typeof require === 'function' ? require('../services/session-snapshot-recovery') : {});

  function createSessionDisplayWorkflow(deps = {}) {
    const getState = deps.getState || (() => ({}));
    const getActiveSession = deps.getActiveSession;
    const createSession = deps.createSession;
    const deriveSessionTitle = deps.deriveSessionTitle;
    const readJsonStorage = deps.readJsonStorage;
    const compactDisplayItems = deps.compactDisplayItems || (items => items);
    const compactAdjacentDuplicateMessages = deps.compactAdjacentDuplicateMessages || (items => items);
    const sanitizeStoredDisplayItem = deps.sanitizeStoredDisplayItem || (item => item);
    const sanitizeStoredMessage = deps.sanitizeStoredMessage || (message => message);
    const renderSessionList = deps.renderSessionList || (() => {});
    const renderMarkdown = deps.renderMarkdown || (text => String(text || ''));
    const renderUserMessageContent = deps.renderUserMessageContent || (text => String(text || ''));
    const makeDisplayItemId = deps.makeDisplayItemId || (() => `display_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`);
    const normalizeLastGeneratedImage = deps.normalizeLastGeneratedImage || (value => value);
    const localStorageRef = deps.localStorage || root.localStorage;
    const messageRecords = deps.messageRecords || root.ChatUIMessageRecords || {};
    const sessionStoreApi = deps.sessionStoreApi || root.ChatUISessionStore || {};
    const snapshotStore = deps.snapshotStore || sessionStoreApi.createSessionSnapshotStore?.({ indexedDBImpl: deps.indexedDB || root.indexedDB });
    const constants = deps.constants || {};
    const SESSIONS_KEY = constants.SESSIONS_KEY || 'chat-sessions';
    const ACTIVE_SESSION_KEY = constants.ACTIVE_SESSION_KEY || 'chat-active-session';
    const SNAPSHOT_FALLBACK_PREFIX = `${SESSIONS_KEY}:snapshot-fallback:`;
    const SNAPSHOT_FALLBACK_VERSION = 1;
    const snapshotFallbackTailCount = Math.max(2, Number(deps.snapshotFallbackTailCount ?? 12) || 12);
    const logger = deps.logger || root.console || console;
    const snapshotCommitWaitMs = Math.max(0, Number(deps.snapshotCommitWaitMs ?? 2000) || 0);
    const setTimeoutRef = deps.setTimeout || root.setTimeout || globalThis.setTimeout;
    const clearTimeoutRef = deps.clearTimeout || root.clearTimeout || globalThis.clearTimeout;
    const pendingDisplayCheckpointMs = Math.max(0, Number(deps.pendingDisplayCheckpointMs ?? 500) || 0);
    const pendingDisplayCheckpointTimers = new Map();
    const pendingDisplayCheckpointDirty = new Set();

    const snapshotRecovery = snapshotRecoveryModule.createSessionSnapshotRecovery({
      getState,
      getActiveSession,
      deriveSessionTitle,
      localStorageRef,
      sessionStoreApi,
      snapshotStore,
      sessionsKey: SESSIONS_KEY,
      snapshotFallbackTailCount,
      logger,
      snapshotCommitWaitMs,
      setTimeoutRef,
      clearTimeoutRef,
      compactAdjacentDuplicateMessages,
      sanitizeStoredDisplayItem,
      sanitizeStoredMessage,
      messageIdentity: typeof require === 'function'
        ? require('../core/message-primitives').messageIdentity
        : root?.[Symbol.for('chatui.module-registry.v1')]?.get('messagePrimitives')?.messageIdentity || (() => ''),
      saveSessionsMeta: () => saveSessionsMeta(),
    });
    const {
      buildSnapshot,
      nextPersistenceRevision,
      isCurrentSnapshot,
      isQuotaError,
      readSnapshotFallback,
      writeSnapshotFallback,
      clearSnapshotFallback,
      retainRecoverableSnapshot,
      createSessionPersistenceError,
      mergePartialFallbackMessages,
      mergeSnapshotFallback,
      readLatestSnapshot,
    } = snapshotRecovery;

    function makeDisplayItem(role, content, { html = false, rawText = content, messageIndex = null, pending = false, responseIndex = null, jobId = '', id = '', imageContext = '', attachmentContext = '', quoteContext = '', metaText = '' } = {}) {
      return {
        id: id || makeDisplayItemId(),
        role,
        rawText: rawText || '',
        html: html ? String(content || '') : role === 'user' ? renderUserMessageContent(String(content || '')) : renderMarkdown(String(content || '')),
        reasoningText: '',
        keepReasoning: false,
        messageIndex: messageIndex != null ? String(messageIndex) : '',
        responseIndex: responseIndex != null ? String(responseIndex) : '',
        jobId: jobId || '',
        imageContext: imageContext || '',
        attachmentContext: attachmentContext || '',
        quoteContext: quoteContext || '',
        metaText: metaText || '',
        pending: pending ? '1' : '',
      };
    }

    function commitSession(session) {
      if (!session?.id || getState().disposedSessionIds?.has?.(session.id)) return Promise.resolve();
      const revision = nextPersistenceRevision(session);
      const baseUpdatedAt = Number(session.snapshotUpdatedAt || 0);
      const snapshot = buildSnapshot(session);
      snapshot.updatedAt = revision;

      // IndexedDB commits are asynchronous and can be cancelled by an immediate
      // refresh. Retain a synchronous recovery copy before starting the durable
      // write; the durable success path removes it once the same revision lands.
      const initialRecovery = retainRecoverableSnapshot(snapshot, baseUpdatedAt, 'durable-write-pending');
      if (!snapshotStore?.schedulePut || snapshotStore.supported === false) {
        if (!initialRecovery.recoverable) {
          return Promise.reject(createSessionPersistenceError(snapshot, 'fallback-unavailable', null, initialRecovery));
        }
        return Promise.resolve({ fallback: true, revision, reason: 'indexeddb-unavailable' });
      }
      if (!initialRecovery.recoverable) {
        logger?.warn?.('session snapshot is waiting for IndexedDB without a complete refresh fallback', initialRecovery);
      }

      let write;
      try { write = snapshotStore.schedulePut(snapshot); } catch (err) { write = Promise.reject(err); }
      const durableWrite = Promise.resolve(write).then(result => {
        if (result === null) {
          if (getState().disposedSessionIds?.has?.(session.id)) return result;
          const recovery = retainRecoverableSnapshot(snapshot, baseUpdatedAt, 'durable-write-skipped');
          if (!recovery.recoverable) {
            throw createSessionPersistenceError(snapshot, 'durable-write-skipped', null, recovery);
          }
          logger?.warn?.('session snapshot durable write was skipped; recoverable fallback retained');
          return { fallback: true, revision, reason: 'durable-write-skipped' };
        }
        // snapshotUpdatedAt means a durable IndexedDB revision, not merely a
        // requested write. Keeping these meanings separate lets a late write
        // repair an immediate-refresh race without being rejected as stale.
        if (snapshotStore.supported !== false) {
          if (getState().disposedSessionIds?.has?.(session.id)) return result;
          const current = getState().sessions?.find(item => item.id === session.id) || session;
          if (revision >= Number(current.persistenceUpdatedAt || 0)) {
            current.snapshotUpdatedAt = Math.max(Number(current.snapshotUpdatedAt || 0), revision);
            current.persistenceUpdatedAt = Math.max(Number(current.persistenceUpdatedAt || 0), revision);
            const metadataSaved = saveSessionsMeta();
            if (!metadataSaved && !hasStoredSessionMetadata(session.id)) {
              const recovery = retainRecoverableSnapshot(snapshot, baseUpdatedAt, 'metadata-write-failed');
              if (!recovery.metadataAvailable) {
                throw createSessionPersistenceError(snapshot, 'metadata-write-failed', null, recovery);
              }
            }
          }
          clearSnapshotFallback(session.id, revision);
        }
        return result;
      }, err => {
        if (getState().disposedSessionIds?.has?.(session.id)) return;
        const recovery = retainRecoverableSnapshot(snapshot, baseUpdatedAt, 'durable-write-failed');
        if (!recovery.recoverable) {
          throw createSessionPersistenceError(snapshot, 'durable-write-failed', err, recovery);
        }
        logger?.warn?.('save session snapshot failed; recoverable fallback retained', err);
        return { fallback: true, revision, reason: 'durable-write-failed' };
      });
      if (!snapshotCommitWaitMs || typeof setTimeoutRef !== 'function') return durableWrite;
      let timeoutId = null;
      const boundedWait = new Promise((resolve, reject) => {
        timeoutId = setTimeoutRef(() => {
          if (getState().disposedSessionIds?.has?.(session.id)) {
            resolve({ timedOut: true, revision, disposed: true });
            return;
          }
          const recovery = retainRecoverableSnapshot(snapshot, baseUpdatedAt, 'durable-write-timeout');
          if (!recovery.recoverable) {
            reject(createSessionPersistenceError(snapshot, 'durable-write-timeout', null, recovery));
            return;
          }
          logger?.warn?.(`save session snapshot is still pending after ${snapshotCommitWaitMs}ms; continuing with recoverable fallback`);
          resolve({ timedOut: true, fallback: true, revision });
        }, snapshotCommitWaitMs);
      });
      return Promise.race([durableWrite, boundedWait]).finally(() => {
        if (timeoutId !== null && typeof clearTimeoutRef === 'function') clearTimeoutRef(timeoutId);
      });
    }

    function saveSessionsMeta() {
      const state = getState();
      try {
        const meta = state.sessions.map(session => ({
          id: session.id,
          title: deriveSessionTitle(session),
          customTitle: session.customTitle || '',
          systemPrompt: session.systemPrompt || '',
          hasSystemPromptOverride: !!session.hasSystemPromptOverride,
          imageStylePrompt: session.imageStylePrompt || '',
          hasImageStylePromptOverride: !!session.hasImageStylePromptOverride,
          chatModel: state.models?.includes?.(session.chatModel) ? session.chatModel : '',
          promptDraft: String(session.promptDraft || '').slice(0, 20000),
          reasoningMode: session.reasoningMode === undefined ? null : !!session.reasoningMode,
          reasoningType: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(session.reasoningType) ? session.reasoningType : '',
          pendingClarification: session.pendingClarification && typeof session.pendingClarification === 'object' ? session.pendingClarification : null,
          createdAt: session.createdAt || Date.now(),
          updatedAt: session.updatedAt || Date.now(),
          snapshotUpdatedAt: Number(session.snapshotUpdatedAt || 0),
          persistenceUpdatedAt: Number(session.persistenceUpdatedAt || 0),
        }));
        localStorageRef.setItem(SESSIONS_KEY, JSON.stringify(meta));
        localStorageRef.setItem(ACTIVE_SESSION_KEY, state.activeSessionId || getActiveSession()?.id || '');
        return true;
      } catch (err) {
        logger?.warn?.('save sessions meta failed', err);
        return false;
      }
    }

    function pendingDisplayItems(items = []) {
      return compactDisplayItems((items || []).filter(item => item?.pending === '1').map(sanitizeStoredDisplayItem));
    }

    function clearPendingDisplayCheckpoint(sessionId) {
      const id = String(sessionId || '');
      const timer = pendingDisplayCheckpointTimers.get(id);
      if (timer !== undefined && typeof clearTimeoutRef === 'function') clearTimeoutRef(timer);
      pendingDisplayCheckpointTimers.delete(id);
      pendingDisplayCheckpointDirty.delete(id);
    }

    function persistSessionDisplay(sessionId) {
      clearPendingDisplayCheckpoint(sessionId);
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session) return Promise.resolve();
      session.updatedAt = Date.now();
      session.display = pendingDisplayItems(session.display);
      return commitSession(session);
    }

    function normalizeMessageForStorage(message, sequence = 0, sessionId = '') {
      const state = getState();
      if (!message || !message.role) return null;
      let content;
      if (typeof message.content === 'string') content = message.content;
      else if (Array.isArray(message.content)) content = message.content.map(item => item && typeof item === 'object' ? JSON.parse(JSON.stringify(item)) : item);
      else content = String(message.content || '');
      const clean = { ...message, role: message.role, content };
      // Reasoning is part of an already completed assistant response. The current
      // send preference only controls future requests, so it must not erase history.
      const sanitized = sanitizeStoredMessage(clean);
      return messageRecords.normalizeCanonicalMessage
        ? messageRecords.normalizeCanonicalMessage(sanitized, { sessionId: sessionId || state.activeSessionId || 'session', sequence })
        : sanitized;
    }

    function normalizeMessageList(messages, sessionId) {
      const compacted = compactAdjacentDuplicateMessages(Array.isArray(messages) ? messages : []);
      return compacted.map((message, index) => normalizeMessageForStorage(message, index, sessionId)).filter(Boolean);
    }

    function saveSessionMessages(sessionId, messages) {
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session) return Promise.resolve();
      // This is the sole canonical-write boundary, not a message-deletion API.
      // A late async writer may hold an older complete snapshot while a newer
      // submit has already appended messages. Merge by stable message identity so
      // that stale writes cannot erase a completed earlier answer.
      // Async jobs can finish after the user switches sessions. Always copy both
      // sides before normalizing so the canonical session record never aliases
      // the mutable working array owned by another session or an in-flight task.
      const existingMessages = Array.isArray(session.messages)
        ? session.messages.map(message => ({ ...message }))
        : [];
      const incomingMessages = Array.isArray(messages)
        ? messages.map(message => ({ ...message }))
        : [];
      const normalized = normalizeMessageList([
        ...existingMessages,
        ...incomingMessages,
      ], sessionId);
      session.messages = normalized.map(message => ({ ...message }));
      // Keep state.messages separate as well; switching sessions must never make
      // two session records share the same mutable array reference.
      if (sessionId === state.activeSessionId) state.messages = session.messages.map(message => ({ ...message }));
      session.title = deriveSessionTitle(session);
      session.updatedAt = Date.now();
      return commitSession(session);
    }

    function replaceSessionMessages(sessionId, messages, options = {}) {
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session) return Promise.resolve();
      clearPendingDisplayCheckpoint(sessionId);
      session.messages = normalizeMessageList(Array.isArray(messages) ? messages : [], sessionId);
      if (Object.prototype.hasOwnProperty.call(options, 'display')) {
        session.display = pendingDisplayItems(Array.isArray(options.display) ? options.display : []);
      }
      if (Object.prototype.hasOwnProperty.call(options, 'pendingClarification')) {
        session.pendingClarification = options.pendingClarification && typeof options.pendingClarification === 'object'
          ? options.pendingClarification
          : null;
      }
      if (Object.prototype.hasOwnProperty.call(options, 'lastGeneratedImage')) {
        session.lastGeneratedImage = normalizeLastGeneratedImage(options.lastGeneratedImage || null);
      }
      if (sessionId === state.activeSessionId) {
        state.messages = session.messages;
        if (Object.prototype.hasOwnProperty.call(options, 'lastGeneratedImage')) {
          state.lastGeneratedImage = session.lastGeneratedImage || null;
        }
      }
      session.title = deriveSessionTitle(session);
      session.updatedAt = Date.now();
      return commitSession(session);
    }

    function ensurePendingItem(session, item) {
      session.display ||= [];
      const existingIndex = session.display.findIndex(candidate => candidate === item || candidate?.id && candidate.id === item.id);
      if (item.pending === '1') {
        if (existingIndex < 0) session.display.push(item);
      } else if (existingIndex >= 0) {
        session.display.splice(existingIndex, 1);
      }
    }

    function appendSessionDisplayMessage(sessionId, role, content, options = {}) {
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session) return null;
      const item = makeDisplayItem(role, content, options);
      // Completed messages are canonical records. display contains only resumable/transient jobs.
      if (item.pending === '1') {
        ensurePendingItem(session, item);
        persistSessionDisplay(sessionId);
      }
      return item;
    }

    function updateSessionDisplayItem(sessionId, item, role, content, options = {}) {
      const state = getState();
      const session = state.sessions.find(candidate => candidate.id === sessionId);
      if (!session || !item) return;
      item.role = role;
      item.rawText = options.rawText ?? content;
      if (options.deferPersist !== true) item.html = options.html ? String(content || '') : role === 'user' ? renderUserMessageContent(String(content || '')) : renderMarkdown(String(content || ''));
      if (!item.id) item.id = makeDisplayItemId();
      if (options.pending !== undefined) item.pending = options.pending ? '1' : '';
      if (options.id) item.id = options.id;
      if (options.messageIndex !== undefined && options.messageIndex !== null) item.messageIndex = String(options.messageIndex);
      if (options.responseIndex !== undefined && options.responseIndex !== null) item.responseIndex = String(options.responseIndex);
      if (options.jobId !== undefined) item.jobId = options.jobId || '';
      if (options.imageContext !== undefined) item.imageContext = options.imageContext || '';
      if (options.attachmentContext !== undefined) item.attachmentContext = options.attachmentContext || '';
      if (options.quoteContext !== undefined) item.quoteContext = options.quoteContext || '';
      if (options.metaText !== undefined) item.metaText = options.metaText || '';
      if (options.reasoning !== undefined) { item.reasoningText = options.reasoning || ''; item.keepReasoning = !!options.keepReasoning && !!item.reasoningText; }
      if (options.pending === false) { clearPendingDisplayCheckpoint(sessionId); item.jobId = ''; item.pending = ''; if (!options.keepReasoning) { delete item.reasoningText; item.keepReasoning = false; } }
      ensurePendingItem(session, item);
      if (options.deferPersist !== true) persistSessionDisplay(sessionId);
    }

    function checkpointSessionDisplayItem(sessionId, item, role, content, options = {}) {
      const id = String(sessionId || '');
      if (!id || !item) return null;
      updateSessionDisplayItem(id, item, role, content, {
        ...options,
        pending: true,
        deferPersist: true,
      });
      // Streaming HTML is a render projection, not the durable source. Keep rawText
      // authoritative so refresh recovery never restores an older status bubble.
      item.html = options.html === true ? String(content || '') : '';
      pendingDisplayCheckpointDirty.add(id);
      if (options.forcePersist === true || !pendingDisplayCheckpointMs || typeof setTimeoutRef !== 'function') {
        persistSessionDisplay(id);
        return item;
      }
      if (!pendingDisplayCheckpointTimers.has(id)) {
        const timer = setTimeoutRef(() => {
          pendingDisplayCheckpointTimers.delete(id);
          if (!pendingDisplayCheckpointDirty.has(id)) return;
          persistSessionDisplay(id);
        }, pendingDisplayCheckpointMs);
        pendingDisplayCheckpointTimers.set(id, timer);
      }
      return item;
    }

    function flushPendingDisplayCheckpoints(sessionId = '') {
      const requested = String(sessionId || '');
      const ids = requested ? [requested] : [...pendingDisplayCheckpointDirty];
      const writes = [];
      for (const id of ids) {
        if (!pendingDisplayCheckpointDirty.has(id)) continue;
        const timer = pendingDisplayCheckpointTimers.get(id);
        if (timer !== undefined && typeof clearTimeoutRef === 'function') clearTimeoutRef(timer);
        pendingDisplayCheckpointTimers.delete(id);
        pendingDisplayCheckpointDirty.delete(id);
        writes.push(Promise.resolve(persistSessionDisplay(id)));
      }
      return Promise.allSettled(writes);
    }
    function persistDetachedResponse(sessionId, role, content, options = {}) {
      if (options.pending === true && sessionId !== getState().activeSessionId) return appendSessionDisplayMessage(sessionId, role, content, options);
      return null;
    }

    function replaceLastSessionDisplayMessage(sessionId, role, content, options = {}) {
      const session = getState().sessions.find(item => item.id === sessionId);
      if (!session) return null;
      session.display ||= [];
      for (let index = session.display.length - 1; index >= 0; index -= 1) {
        if (session.display[index].role === role) {
          updateSessionDisplayItem(sessionId, session.display[index], role, content, options);
          return session.display[index];
        }
      }
      return appendSessionDisplayMessage(sessionId, role, content, options);
    }

    function syncActiveSession({ skipSave = false } = {}) {
      const state = getState();
      const session = getActiveSession();
      state.messages = (session?.messages || []).map(message => ({ ...message }));
      state.lastGeneratedImage = normalizeLastGeneratedImage(session?.lastGeneratedImage || null);
      if (session) session.lastGeneratedImage = state.lastGeneratedImage || null;
      if (!skipSave) saveSessionsMeta();
      renderSessionList();
    }

    function sessionFromMeta(item, payload) {
      const state = getState();
      return {
        id: item.id,
        title: item.title || '新对话',
        customTitle: item.customTitle || '',
        systemPrompt: item.systemPrompt || '',
        hasSystemPromptOverride: !!item.hasSystemPromptOverride,
        imageStylePrompt: item.imageStylePrompt || '',
        hasImageStylePromptOverride: !!item.hasImageStylePromptOverride,
        chatModel: state.models?.includes?.(item.chatModel) ? item.chatModel : '',
        promptDraft: String(item.promptDraft || '').slice(0, 20000),
        reasoningMode: item.reasoningMode === null || item.reasoningMode === undefined ? undefined : !!item.reasoningMode,
        reasoningType: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(item.reasoningType) ? item.reasoningType : '',
        pendingClarification: item.pendingClarification && typeof item.pendingClarification === 'object' ? item.pendingClarification : null,
        createdAt: item.createdAt || Date.now(),
        updatedAt: Math.max(Number(item.updatedAt) || 0, Number(payload?.updatedAt) || 0) || Date.now(),
        snapshotUpdatedAt: Number(payload?.snapshotUpdatedAt || 0),
        persistenceUpdatedAt: Math.max(
          Number(item.persistenceUpdatedAt || 0),
          Number(item.snapshotUpdatedAt || 0),
          Number(payload?.persistenceUpdatedAt || 0)
        ),
        messages: payload?.messages || [],
        display: payload?.pendingDisplay || [],
        lastGeneratedImage: payload?.lastGeneratedImage || null,
        busy: false,
      };
    }

    async function loadSessionPayload(item) {
      const snapshot = await readLatestSnapshot(item.id);

      if (isCurrentSnapshot(snapshot)) {
        const snapshotRevision = Number(snapshot.updatedAt || 0);
        const durableRevision = Math.max(0, Number(snapshot.durableUpdatedAt || 0));
        return {
          messages: normalizeMessageList(snapshot.messages, item.id),
          pendingDisplay: pendingDisplayItems(snapshot.pendingDisplay || []),
          lastGeneratedImage: snapshot.lastGeneratedImage || null,
          updatedAt: Math.max(Number(item.updatedAt || 0), snapshotRevision),
          snapshotUpdatedAt: durableRevision,
          persistenceUpdatedAt: Math.max(
            Number(item.persistenceUpdatedAt || 0),
            Number(item.snapshotUpdatedAt || 0),
            snapshotRevision,
            durableRevision
          ),
        };
      }

      return {
        messages: [],
        pendingDisplay: [],
        lastGeneratedImage: null,
        updatedAt: item.updatedAt,
        snapshotUpdatedAt: 0,
        persistenceUpdatedAt: Math.max(
          Number(item.persistenceUpdatedAt || 0),
          Number(item.snapshotUpdatedAt || 0)
        ),
      };
    }

    async function loadSessions() {
      const state = getState();
      let sessions = [];
      try {
        const stored = readJsonStorage(SESSIONS_KEY, []);
        if (Array.isArray(stored)) {
          const valid = stored.filter(item => item && item.id);
          const payloads = await Promise.all(valid.map(loadSessionPayload));
          sessions = valid.map((item, index) => sessionFromMeta(item, payloads[index]));
        }
      } catch (err) { logger?.warn?.('load sessions failed', err); }
      if (!sessions.length) {
        const session = createSession();
        session.title = deriveSessionTitle(session);
        sessions = [session];
      }
      state.sessions = sessions;
      const storedActiveSessionId = localStorageRef.getItem(ACTIVE_SESSION_KEY);
      state.activeSessionId = sessions.some(session => session.id === storedActiveSessionId) ? storedActiveSessionId : sessions[0].id;
      syncActiveSession({ skipSave: true });
      return sessions;
    }

    async function reloadSessionSnapshot(sessionId) {
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session || !snapshotStore?.getSnapshot) return false;
      const snapshot = await readLatestSnapshot(sessionId);
      if (!isCurrentSnapshot(snapshot)) return false;
      const snapshotRevision = Number(snapshot.updatedAt || 0);
      const durableRevision = Math.max(0, Number(snapshot.durableUpdatedAt || 0));
      const previousPersistenceRevision = Math.max(
        Number(session.persistenceUpdatedAt || 0),
        Number(session.snapshotUpdatedAt || 0)
      );
      const previousSnapshotUpdatedAt = Number(session.snapshotUpdatedAt || 0);
      let changed = false;
      if (snapshotRevision > previousPersistenceRevision || durableRevision > previousSnapshotUpdatedAt) {
        session.messages = normalizeMessageList(snapshot.messages, sessionId);
        if (sessionId === state.activeSessionId) state.messages = (session.messages || []).map(message => ({ ...message }));
        session.display = pendingDisplayItems(snapshot.pendingDisplay || []);
        session.lastGeneratedImage = snapshot.lastGeneratedImage || session.lastGeneratedImage || null;
        session.updatedAt = Math.max(Number(session.updatedAt || 0), snapshotRevision);
        changed = true;
      }
      const metadataChanged = durableRevision > previousSnapshotUpdatedAt
        || snapshotRevision > Number(session.persistenceUpdatedAt || 0);
      session.snapshotUpdatedAt = Math.max(Number(session.snapshotUpdatedAt || 0), durableRevision);
      session.persistenceUpdatedAt = Math.max(Number(session.persistenceUpdatedAt || 0), snapshotRevision, durableRevision);
      if (metadataChanged) saveSessionsMeta();
      return changed;
    }

    function deleteSessionSnapshot(sessionId) {
      clearPendingDisplayCheckpoint(sessionId);
      clearSnapshotFallback(sessionId);
      return snapshotStore?.deleteSnapshot?.(sessionId) || Promise.resolve();
    }
    function clearSessionSnapshots() {
      [...pendingDisplayCheckpointTimers.keys()].forEach(clearPendingDisplayCheckpoint);
      (getState().sessions || []).forEach(session => clearSnapshotFallback(session?.id));
      try {
        const staleKeys = [];
        for (let index = 0; index < Number(localStorageRef?.length || 0); index += 1) {
          const key = localStorageRef.key(index);
          if (String(key || '').startsWith(SNAPSHOT_FALLBACK_PREFIX)) staleKeys.push(key);
        }
        staleKeys.forEach(key => localStorageRef.removeItem(key));
      } catch {}
      return snapshotStore?.clear?.() || Promise.resolve();
    }
    function flushSessionSnapshots(sessionId = '') { return snapshotStore?.flush?.(sessionId) || Promise.resolve(); }

    function sessionTitleHtml(session) {
      return String(deriveSessionTitle(session)).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
    }

    function getSessionReturnCount(session, { domCount = 0, isBusy = () => false } = {}) {
      const state = getState();
      if (!session) return 0;
      const messages = session.id !== state.activeSessionId || isBusy(session.id) ? session.messages || [] : state.messages;
      const assistantCount = Array.isArray(messages) ? messages.filter(item => item?.role === 'assistant').length : 0;
      if (assistantCount) return assistantCount;
      return session.id === state.activeSessionId && !isBusy(session.id) ? Number(domCount) || 0 : 0;
    }

    return Object.freeze({
      makeDisplayItem,
      normalizeMessageForStorage,
      persistSessionDisplay,
      saveSessionMessages,
      replaceSessionMessages,
      appendSessionDisplayMessage,
      updateSessionDisplayItem,
      checkpointSessionDisplayItem,
      flushPendingDisplayCheckpoints,
      persistDetachedResponse,
      replaceLastSessionDisplayMessage,
      syncActiveSession,
      saveSessionsMeta,
      loadSessions,
      reloadSessionSnapshot,
      deleteSessionSnapshot,
      clearSessionSnapshots,
      flushSessionSnapshots,
      commitSession,
      sessionTitleHtml,
      getSessionReturnCount,
    });
  }

  const api = Object.freeze({ createSessionDisplayWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSessionDisplay = api;
  if (root?.window) root.window.ChatUIAppSessionDisplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
