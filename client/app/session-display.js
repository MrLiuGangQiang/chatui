(function initChatUIAppSessionDisplay(root) {
  'use strict';

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
    const makeDisplayItemId = deps.makeDisplayItemId || (() => `display_${Date.now().toString(36)}`);
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

    function isCurrentSnapshot(snapshot) {
      return snapshot?.snapshotVersion >= 2 && Array.isArray(snapshot.messages);
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

    function messageIdentity(message) {
      if (!message || !['user', 'assistant'].includes(message.role)) return '';
      const value = message.role === 'user' ? message.messageIndex : message.responseIndex;
      return value !== undefined && value !== null && value !== '' ? `${message.role}:${value}` : '';
    }

    function mergePartialFallbackMessages(durableMessages = [], fallbackMessages = []) {
      const replacementIds = new Set(fallbackMessages.map(messageIdentity).filter(Boolean));
      const retainedDurable = durableMessages.filter(message => {
        const identity = messageIdentity(message);
        return !identity || !replacementIds.has(identity);
      });
      return compactAdjacentDuplicateMessages([...retainedDurable, ...fallbackMessages]);
    }

    function withSnapshotSource(snapshot, durableUpdatedAt = 0) {
      return snapshot ? { ...snapshot, durableUpdatedAt: Number(durableUpdatedAt || 0) } : null;
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
      const durableRead = Promise.resolve().then(() => snapshotStore?.getSnapshot?.(sessionId) || null).catch(error => {
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

    function commitSession(session) {
      if (!session?.id || getState().disposedSessionIds?.has?.(session.id)) return Promise.resolve();
      const revision = nextPersistenceRevision(session);
      const baseUpdatedAt = Number(session.snapshotUpdatedAt || 0);
      const snapshot = buildSnapshot(session);
      snapshot.updatedAt = revision;
      if (!snapshotStore?.schedulePut || snapshotStore.supported === false) {
        writeSnapshotFallback(snapshot, baseUpdatedAt);
        saveSessionsMeta();
        return Promise.resolve({ fallback: true, revision });
      }
      let write;
      try { write = snapshotStore.schedulePut(snapshot); } catch (err) { write = Promise.reject(err); }
      const durableWrite = Promise.resolve(write).then(result => {
        if (result === null) return result;
        // snapshotUpdatedAt means a durable IndexedDB revision, not merely a
        // requested write. Keeping these meanings separate lets a late write
        // repair an immediate-refresh race without being rejected as stale.
        if (snapshotStore.supported !== false) {
          if (getState().disposedSessionIds?.has?.(session.id)) return result;
          const current = getState().sessions?.find(item => item.id === session.id) || session;
          if (revision >= Number(current.persistenceUpdatedAt || 0)) {
            current.snapshotUpdatedAt = Math.max(Number(current.snapshotUpdatedAt || 0), revision);
            current.persistenceUpdatedAt = Math.max(Number(current.persistenceUpdatedAt || 0), revision);
            saveSessionsMeta();
          }
          clearSnapshotFallback(session.id, revision);
        }
        return result;
      }).catch(err => {
        if (getState().disposedSessionIds?.has?.(session.id)) return;
        writeSnapshotFallback(snapshot, baseUpdatedAt);
        saveSessionsMeta();
        logger?.warn?.('save session snapshot failed; recoverable fallback retained', err);
      });
      if (!snapshotCommitWaitMs || typeof setTimeoutRef !== 'function') return durableWrite;
      let timeoutId = null;
      const boundedWait = new Promise(resolve => {
        timeoutId = setTimeoutRef(() => {
          if (!getState().disposedSessionIds?.has?.(session.id)) {
            writeSnapshotFallback(snapshot, baseUpdatedAt);
            saveSessionsMeta();
            logger?.warn?.(`save session snapshot is still pending after ${snapshotCommitWaitMs}ms; continuing with recoverable fallback`);
          }
          resolve({ timedOut: true, revision });
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
          headerValues: session.headerValues && typeof session.headerValues === 'object' ? session.headerValues : {},
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
      } catch (err) { logger?.warn?.('save sessions meta failed', err); }
    }

    function pendingDisplayItems(items = []) {
      return compactDisplayItems((items || []).filter(item => item?.pending === '1').map(sanitizeStoredDisplayItem));
    }

    function persistSessionDisplay(sessionId) {
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
      const normalized = normalizeMessageList(messages, sessionId);
      session.messages = normalized;
      // Active-session writes are committed through this single boundary so the
      // working state can never drift from the canonical session record.
      if (sessionId === state.activeSessionId) state.messages = session.messages;
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
      if (options.pending === false) { item.jobId = ''; item.pending = ''; if (!options.keepReasoning) { delete item.reasoningText; item.keepReasoning = false; } }
      ensurePendingItem(session, item);
      if (options.deferPersist !== true) persistSessionDisplay(sessionId);
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
      state.messages = session?.messages || [];
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
        headerValues: item.headerValues && typeof item.headerValues === 'object' ? item.headerValues : {},
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
        if (sessionId === state.activeSessionId) state.messages = session.messages;
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
      clearSnapshotFallback(sessionId);
      return snapshotStore?.deleteSnapshot?.(sessionId) || Promise.resolve();
    }
    function clearSessionSnapshots() {
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
      appendSessionDisplayMessage,
      updateSessionDisplayItem,
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
