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
    const sessionStorageKey = deps.sessionStorageKey || ((baseKey, sessionId) => `${baseKey}:${sessionId || 'default'}`);
    const CHAT_KEY = constants.CHAT_KEY || 'chat-history';
    const UI_KEY = constants.UI_KEY || 'chat-ui';
    const LAST_IMAGE_KEY = constants.LAST_IMAGE_KEY || 'last-image';
    const SESSIONS_KEY = constants.SESSIONS_KEY || 'chat-sessions';
    const ACTIVE_SESSION_KEY = constants.ACTIVE_SESSION_KEY || 'chat-active-session';

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

    function commitSession(session) {
      if (!session?.id || getState().disposedSessionIds?.has?.(session.id)) return Promise.resolve();
      const revision = nextPersistenceRevision(session);
      if (!snapshotStore?.schedulePut) return Promise.resolve();
      const snapshot = buildSnapshot(session);
      snapshot.updatedAt = revision;
      let write;
      try { write = snapshotStore.schedulePut(snapshot); } catch (err) { write = Promise.reject(err); }
      return Promise.resolve(write).then(result => {
        // snapshotUpdatedAt means a durable IndexedDB revision, not merely a
        // requested write. Keeping these meanings separate lets a late write
        // repair an immediate-refresh race without being rejected as stale.
        if (snapshotStore.supported !== false) {
          if (getState().disposedSessionIds?.has?.(session.id)) return result;
          const current = getState().sessions?.find(item => item.id === session.id) || session;
          if (revision < Number(current.persistenceUpdatedAt || 0)) return result;
          current.snapshotUpdatedAt = Math.max(Number(current.snapshotUpdatedAt || 0), revision);
          current.persistenceUpdatedAt = Math.max(Number(current.persistenceUpdatedAt || 0), revision);
          saveSessionsMeta();
        }
        return result;
      }).catch(err => {
        console.warn('save session snapshot failed; in-memory history was retained', err);
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
      } catch (err) { console.warn('save sessions meta failed', err); }
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
      const allowReasoning = !!state.reasoningMode;
      if (options.reasoning !== undefined) { item.reasoningText = allowReasoning ? options.reasoning || '' : ''; item.keepReasoning = allowReasoning && !!options.keepReasoning; }
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
        updatedAt: Number(item.updatedAt) || Date.now(),
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

    function readLegacySessionPayload(item) {
      const messages = readJsonStorage(sessionStorageKey(CHAT_KEY, item.id), []);
      const display = readJsonStorage(sessionStorageKey(UI_KEY, item.id), []);
      const lastGeneratedImage = readJsonStorage(sessionStorageKey(LAST_IMAGE_KEY, item.id), null);
      return {
        messages: Array.isArray(messages) ? messages : [],
        display: Array.isArray(display) ? display : [],
        lastGeneratedImage: lastGeneratedImage || null,
      };
    }

    function migrateSessionPayload(item, source = {}) {
      const migrated = messageRecords.migrateLegacySession
        ? messageRecords.migrateLegacySession({
          sessionId: item.id,
          messages: source.messages || [],
          display: source.display || source.pendingDisplay || [],
        })
        : {
          messages: source.messages || [],
          pendingDisplay: source.pendingDisplay || source.display || [],
        };
      return {
        messages: normalizeMessageList(migrated.messages || [], item.id),
        pendingDisplay: pendingDisplayItems(migrated.pendingDisplay || []),
        lastGeneratedImage: source.lastGeneratedImage || null,
      };
    }

    function messageRecoverySignature(message = {}) {
      let content = message.content;
      if (typeof content !== 'string') {
        try { content = JSON.stringify(content ?? ''); } catch { content = String(content ?? ''); }
      }
      return JSON.stringify([
        message.role || '',
        content || message.rawText || '',
        message.imageContext || '',
        message.attachmentContext || '',
      ]);
    }

    function signatureList(messages = []) {
      return (messages || []).map(messageRecoverySignature);
    }

    function isOrderedSubsequence(needles = [], haystack = []) {
      if (!needles.length) return true;
      let cursor = 0;
      for (const value of haystack) {
        if (value === needles[cursor]) cursor += 1;
        if (cursor >= needles.length) return true;
      }
      return false;
    }

    function commonPrefixLength(left = [], right = []) {
      let index = 0;
      while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
      return index;
    }

    function suffixPrefixOverlap(left = [], right = []) {
      const max = Math.min(left.length, right.length);
      for (let size = max; size > 0; size -= 1) {
        let matches = true;
        for (let index = 0; index < size; index += 1) {
          if (left[left.length - size + index] !== right[index]) { matches = false; break; }
        }
        if (matches) return size;
      }
      return 0;
    }

    function reindexRecoveredMessages(messages = [], sessionId = '') {
      const ordered = messages.map((message, index) => {
        const next = { ...message, sequence: index, id: `${sessionId || 'session'}:${message.role || 'message'}:${index}` };
        if (message.role === 'user') {
          next.messageIndex = String(index);
          delete next.responseIndex;
        } else if (message.role === 'assistant') {
          next.responseIndex = String(index);
          delete next.messageIndex;
        }
        return next;
      });
      return normalizeMessageList(ordered, sessionId);
    }

    function overlaySubsequence(base = [], overlay = []) {
      const merged = base.map(message => ({ ...message }));
      let cursor = 0;
      overlay.forEach(message => {
        const signature = messageRecoverySignature(message);
        for (let index = cursor; index < merged.length; index += 1) {
          if (messageRecoverySignature(merged[index]) !== signature) continue;
          merged[index] = { ...merged[index], ...message };
          cursor = index + 1;
          return;
        }
      });
      return merged;
    }

    function reconcileSnapshotWithLegacy(item, snapshotMessages = [], legacyPayload = {}) {
      const current = normalizeMessageList(snapshotMessages, item.id);
      const migratedLegacy = migrateSessionPayload(item, legacyPayload);
      const legacy = migratedLegacy.messages || [];
      if (!legacy.length) return { messages: current, repaired: false, legacy: migratedLegacy };

      const currentSignatures = signatureList(current);
      const legacySignatures = signatureList(legacy);
      if (currentSignatures.length >= legacySignatures.length) {
        return { messages: current, repaired: false, legacy: migratedLegacy };
      }

      let recovered;
      if (isOrderedSubsequence(currentSignatures, legacySignatures)) {
        recovered = overlaySubsequence(legacy, current);
      } else {
        const prefix = commonPrefixLength(currentSignatures, legacySignatures);
        if (prefix > 0) {
          // The IndexedDB snapshot replaced or added records at the start of the
          // conversation but stopped before the older backup did. Keep current
          // records authoritative at matching positions and recover the hidden tail.
          recovered = [...current, ...legacy.slice(current.length)];
        } else {
          // During the IndexedDB transition an empty working session could start
          // again at index zero while the complete older conversation remained in
          // localStorage. Preserve both timelines instead of dropping either one.
          const overlap = suffixPrefixOverlap(legacySignatures, currentSignatures);
          recovered = [...legacy, ...current.slice(overlap)];
        }
      }
      return {
        messages: reindexRecoveredMessages(recovered, item.id),
        repaired: true,
        legacy: migratedLegacy,
      };
    }

    async function persistMigratedSessionPayload(item, payload, minimumRevision = 0) {
      if (!snapshotStore?.schedulePut || snapshotStore.supported === false) return 0;
      const revision = Math.max(Date.now(), Number(item.updatedAt || 0), Number(item.snapshotUpdatedAt || 0) + 1, Number(minimumRevision || 0) + 1);
      try {
        await snapshotStore.schedulePut({
          id: item.id,
          snapshotVersion: 2,
          updatedAt: revision,
          messages: payload.messages,
          pendingDisplay: payload.pendingDisplay,
          lastGeneratedImage: payload.lastGeneratedImage,
        });
        return revision;
      } catch (err) {
        console.warn('migrate legacy session snapshot failed; legacy data remains available', err);
        return 0;
      }
    }

    async function loadSessionPayload(item) {
      let snapshot = null;
      try { snapshot = await snapshotStore?.getSnapshot?.(item.id); } catch (err) { console.warn('load session snapshot failed', err); }
      if (snapshot?.snapshotVersion >= 2 && Array.isArray(snapshot.messages)) {
        const snapshotRevision = Number(snapshot.updatedAt || 0);
        const legacyPayload = readLegacySessionPayload(item);
        const reconciliation = reconcileSnapshotWithLegacy(item, snapshot.messages, legacyPayload);
        const repairedPayload = {
          messages: reconciliation.messages,
          pendingDisplay: pendingDisplayItems(snapshot.pendingDisplay || []),
          lastGeneratedImage: snapshot.lastGeneratedImage || reconciliation.legacy.lastGeneratedImage || null,
        };
        const repairedRevision = reconciliation.repaired
          ? await persistMigratedSessionPayload(item, repairedPayload, snapshotRevision)
          : 0;
        const durableRevision = Math.max(snapshotRevision, repairedRevision);
        return {
          ...repairedPayload,
          updatedAt: item.updatedAt,
          snapshotUpdatedAt: durableRevision,
          persistenceUpdatedAt: Math.max(Number(item.persistenceUpdatedAt || 0), Number(item.snapshotUpdatedAt || 0), durableRevision),
        };
      }

      const legacy = snapshot && Array.isArray(snapshot.messages)
        ? { ...snapshot, display: snapshot.display || snapshot.pendingDisplay || [] }
        : readLegacySessionPayload(item);
      const hasLegacyPayload = legacy.messages.length || legacy.display?.length || legacy.pendingDisplay?.length || legacy.lastGeneratedImage;
      if (hasLegacyPayload) {
        const migrated = migrateSessionPayload(item, legacy);
        const snapshotRevision = await persistMigratedSessionPayload(item, migrated);
        return {
          ...migrated,
          updatedAt: item.updatedAt,
          snapshotUpdatedAt: snapshotRevision,
          persistenceUpdatedAt: Math.max(Number(item.persistenceUpdatedAt || 0), Number(item.snapshotUpdatedAt || 0), snapshotRevision),
        };
      }

      return {
        messages: [],
        pendingDisplay: [],
        lastGeneratedImage: null,
        updatedAt: item.updatedAt,
        snapshotUpdatedAt: 0,
        persistenceUpdatedAt: Math.max(Number(item.persistenceUpdatedAt || 0), Number(item.snapshotUpdatedAt || 0)),
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
      } catch (err) { console.warn('load sessions failed', err); }
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
      const snapshot = await snapshotStore.getSnapshot(sessionId);
      const snapshotUpdatedAt = Number(snapshot?.updatedAt || 0);
      const previousSnapshotUpdatedAt = Number(session.snapshotUpdatedAt || 0);
      if (!Array.isArray(snapshot?.messages) || snapshotUpdatedAt <= previousSnapshotUpdatedAt) return false;
      let changed = false;
      if (snapshotUpdatedAt > previousSnapshotUpdatedAt) {
        session.messages = normalizeMessageList(snapshot.messages, sessionId);
        if (sessionId === state.activeSessionId) state.messages = session.messages;
        changed = true;
        session.display = pendingDisplayItems(snapshot.pendingDisplay || []);
      }
      session.lastGeneratedImage = snapshot.lastGeneratedImage || session.lastGeneratedImage || null;
      session.snapshotUpdatedAt = snapshotUpdatedAt;
      session.persistenceUpdatedAt = Math.max(Number(session.persistenceUpdatedAt || 0), snapshotUpdatedAt);
      saveSessionsMeta();
      return changed;
    }

    function deleteSessionSnapshot(sessionId) { return snapshotStore?.deleteSnapshot?.(sessionId) || Promise.resolve(); }
    function clearSessionSnapshots() { return snapshotStore?.clear?.() || Promise.resolve(); }
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
