(function initChatUIAppSessionUiWorkflow(root) {
  'use strict';

  function createSessionUiWorkflow(deps = {}) {
    const getState = deps.getState || (() => ({}));
    const $ = deps.getElement || (() => null);
    const documentRef = deps.document || root.document;
    const localStorageRef = deps.localStorage || root.localStorage;
    const createSession = deps.createSession;
    const deriveSessionTitle = deps.deriveSessionTitle;
    const sessionTitleHtml = deps.sessionTitleHtml;
    const getSessionReturnCount = deps.getSessionReturnCount;
    const isSessionBusy = deps.isSessionBusy;
    const switchSession = deps.switchSession;
    const saveActivePromptDraft = deps.saveActivePromptDraft || (() => {});
    const restorePromptDraft = deps.restorePromptDraft || (() => {});
    const saveSessionsMeta = deps.saveSessionsMeta || (() => {});
    const saveChatHistory = deps.saveChatHistory || (() => {});
    const saveDisplayHistory = deps.saveDisplayHistory || (() => {});
    const sessionStorageKey = deps.sessionStorageKey;
    const renderActiveSession = deps.renderActiveSession || (() => {});
    const updateResumeStreamButton = deps.updateResumeStreamButton || (() => {});
    const updateSendAvailability = deps.updateSendAvailability || (() => {});
    const closeSessionDrawer = deps.closeSessionDrawer || (() => {});
    const showConfirmDialog = deps.showConfirmDialog || (async () => false);
    const deleteSessionImageBlobs = deps.deleteSessionImageBlobs || (async () => {});
    const clearChatJob = deps.clearChatJob || (() => {});
    const clearImageJob = deps.clearImageJob || (() => {});
    const setSessionBusy = deps.setSessionBusy || (() => {});
    const syncActiveSession = deps.syncActiveSession || (() => {});
    const collectAllSessionImageKeys = deps.collectAllSessionImageKeys || (() => new Set());
    const deleteImageDbKeys = deps.deleteImageDbKeys || (async () => {});
    const deleteOrphanImageBlobs = deps.deleteOrphanImageBlobs || (async () => {});
    const clearAttachments = deps.clearAttachments || (() => {});
    const toast = deps.toast || (() => {});
    const getActiveSession = deps.getActiveSession;
    const getConfig = deps.getConfig;
    const isModelAllowedFor = deps.isModelAllowedFor || (() => true);
    const escapeHtml = deps.escapeHtml || (value => String(value || ''));
    const closeSessionModelPanel = deps.closeSessionModelPanel || (() => {});
    const sessionConfig = deps.sessionConfig || {};
    const constants = deps.constants || {};
    const CHAT_KEY = constants.CHAT_KEY || 'chat-history';
    const UI_KEY = constants.UI_KEY || 'chat-ui';
    const LAST_IMAGE_KEY = constants.LAST_IMAGE_KEY || 'last-image';
    const ACTIVE_SESSION_KEY = constants.ACTIVE_SESSION_KEY || 'active-session';

    function renderSessionList() {
      const state = getState();
      const list = $('sessionList');
      if (!list) return;
      list.innerHTML = '';
      state.sessions.forEach(session => {
        const tab = documentRef.createElement('button');
        tab.type = 'button';
        tab.className = 'session-tab';
        tab.classList.toggle('active', session.id === state.activeSessionId);
        tab.classList.toggle('busy', isSessionBusy(session.id));
        tab.dataset.sessionId = session.id;
        tab.innerHTML = `<span class="session-title" title="${sessionTitleHtml(session)}">${sessionTitleHtml(session)}</span><small>${getSessionReturnCount(session)} 条</small><button class="session-rename-btn" type="button" title="重命名会话" aria-label="重命名会话">✎</button><button class="session-delete-btn" type="button" title="删除会话" aria-label="删除会话">×</button>`;
        tab.addEventListener('click', event => { if (!event.target.closest('.session-delete-btn') && !event.target.closest('.session-rename-btn') && !event.target.closest('.session-title-input')) switchSession(session.id); });
        tab.addEventListener('dblclick', event => { if (!event.target.closest('.session-delete-btn') && !event.target.closest('.session-title-input')) beginRenameSession(session.id, event.target); });
        tab.querySelector('.session-rename-btn')?.addEventListener('click', event => { event.stopPropagation(); beginRenameSession(session.id, event.target); });
        tab.querySelector('.session-delete-btn')?.addEventListener('click', event => { event.stopPropagation(); deleteSession(session.id); });
        list.appendChild(tab);
      });
    }

    function newSession() {
      const state = getState();
      saveActivePromptDraft();
      try { saveChatHistory(); saveDisplayHistory(); } catch (err) { console.warn('save session before new session failed', err); }
      state.editingIndex = null;
      state.editingNode = null;
      const session = createSession();
      state.sessions.unshift(session);
      state.activeSessionId = session.id;
      state.messages = [];
      state.lastGeneratedImage = null;
      state.activeOutputNode = null;
      state.activeOutputSessions.delete(session.id);
      state.promptDrafts.set(session.id, '');
      restorePromptDraft(session.id);
      $('resumeStreamBtn')?.classList.remove('show');
      $('resumeStreamBtn')?.setAttribute('aria-hidden', 'true');
      saveSessionsMeta();
      localStorageRef.setItem(sessionStorageKey(CHAT_KEY), '[]');
      localStorageRef.setItem(sessionStorageKey(UI_KEY), '[]');
      localStorageRef.removeItem(sessionStorageKey(LAST_IMAGE_KEY));
      renderActiveSession();
      updateResumeStreamButton();
      updateSendAvailability();
      closeSessionDrawer();
      $('prompt')?.focus();
    }

    async function deleteSession(sessionId) {
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session) return;
      const title = deriveSessionTitle(session);
      if (!await showConfirmDialog({ title: '删除会话', message: `确定删除会话“${title}”吗？此操作不可撤销。`, confirmText: '删除', cancelText: '取消' })) return;
      const remaining = state.sessions.filter(item => item.id !== sessionId);
      await deleteSessionImageBlobs(session, remaining);
      clearChatJob(sessionId);
      clearImageJob(sessionId);
      setSessionBusy(sessionId, false);
      localStorageRef.removeItem(sessionStorageKey(CHAT_KEY, sessionId));
      localStorageRef.removeItem(sessionStorageKey(UI_KEY, sessionId));
      localStorageRef.removeItem(sessionStorageKey(LAST_IMAGE_KEY, sessionId));
      state.busySessions.delete(sessionId);
      state.activeOutputSessions.delete(sessionId);
      state.activeRuns.delete(sessionId);
      state.stoppedSessions.delete(sessionId);
      state.sessions = remaining;
      if (!state.sessions.length) state.sessions = [createSession()];
      if (state.activeSessionId === sessionId) {
        state.activeSessionId = state.sessions[0].id;
        localStorageRef.setItem(ACTIVE_SESSION_KEY, state.activeSessionId);
        syncActiveSession({ skipSave: true });
        renderActiveSession();
      }
      saveSessionsMeta();
      renderSessionList();
      updateSendAvailability();
    }

    async function clearAllSessions() {
      const state = getState();
      if (!state.sessions.length) return;
      const count = state.sessions.length;
      if (!await showConfirmDialog({ title: '清除所有会话', message: `确定删除全部 ${count} 个会话吗？聊天记录、会话图片缓存和未完成任务记录都会清除，此操作不可撤销。`, confirmText: '清除全部', cancelText: '取消' })) return;
      const sessions = [...state.sessions];
      const imageKeys = collectAllSessionImageKeys(sessions);
      sessions.forEach(session => {
        try { state.activeRuns.get(session.id)?.abortController?.abort(); } catch {}
        clearChatJob(session.id);
        clearImageJob(session.id);
        setSessionBusy(session.id, false);
        localStorageRef.removeItem(sessionStorageKey(CHAT_KEY, session.id));
        localStorageRef.removeItem(sessionStorageKey(UI_KEY, session.id));
        localStorageRef.removeItem(sessionStorageKey(LAST_IMAGE_KEY, session.id));
        state.busySessions.delete(session.id);
        state.activeOutputSessions.delete(session.id);
        state.activeRuns.delete(session.id);
        state.stoppedSessions.delete(session.id);
        state.promptDrafts.delete(session.id);
      });
      state.sessions = [createSession()];
      state.activeSessionId = state.sessions[0].id;
      state.messages = [];
      state.lastGeneratedImage = null;
      state.attachments = [];
      state.editingIndex = null;
      state.editingNode = null;
      state.activeOutputNode = null;
      state.followingChatJobs.clear();
      state.followingImageJobs.clear();
      state.resumingJobs.clear();
      await deleteImageDbKeys([...imageKeys]);
      await deleteOrphanImageBlobs(state.sessions);
      localStorageRef.setItem(ACTIVE_SESSION_KEY, state.activeSessionId);
      localStorageRef.setItem(sessionStorageKey(CHAT_KEY), '[]');
      localStorageRef.setItem(sessionStorageKey(UI_KEY), '[]');
      localStorageRef.removeItem(sessionStorageKey(LAST_IMAGE_KEY));
      saveSessionsMeta();
      clearAttachments();
      const messages = $('messages');
      if (messages) messages.innerHTML = '';
      renderActiveSession();
      updateSendAvailability();
      closeSessionDrawer();
      toast('已清除所有会话');
    }

    function beginRenameSession(sessionId, target) {
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session) return;
      const tab = target?.closest?.('.session-tab') || documentRef.querySelector(`.session-tab[data-session-id="${sessionId}"]`);
      if (!tab) return;
      if (tab.classList.contains('renaming')) { const input = tab.querySelector('.session-title-input'); if (input) { input.focus(); input.select(); } return; }
      tab.classList.add('renaming');
      const title = tab.querySelector('.session-title');
      const renameButton = tab.querySelector('.session-rename-btn');
      const current = deriveSessionTitle(session);
      const input = documentRef.createElement('input');
      input.type = 'text';
      input.className = 'session-title-input';
      input.value = current;
      input.maxLength = 40;
      input.setAttribute('aria-label', '会话名称');
      title.replaceWith(input);
      if (renameButton) { renameButton.textContent = '✓'; renameButton.title = '保存会话名称'; renameButton.setAttribute('aria-label', '保存会话名称'); renameButton.classList.add('saving'); }
      let done = false;
      const save = () => { if (done) return; done = true; const next = String(input.value || '').replace(/\s+/g, ' ').trim(); if (next) { session.customTitle = next.slice(0, 40); session.title = session.customTitle; session.updatedAt = Date.now(); saveSessionsMeta(); renderSessionList(); } else { done = false; input.focus(); } };
      const cancel = () => { if (!done) { done = true; renderSessionList(); } };
      input.addEventListener('click', event => event.stopPropagation());
      input.addEventListener('dblclick', event => event.stopPropagation());
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save(); } else if (event.key === 'Escape') { event.preventDefault(); cancel(); } });
      input.addEventListener('blur', () => {});
      renameButton?.addEventListener('mousedown', event => event.preventDefault(), { once: true });
      renameButton?.addEventListener('click', event => { event.stopPropagation(); save(); }, { once: true });
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    function renderSessionModelArea() {
      const state = getState();
      const panel = $('sessionModelPanel');
      const button = $('sessionModelBtn');
      if (!panel || !button) return;
      const session = getActiveSession();
      const value = sessionConfig.sessionChatModelValue ? sessionConfig.sessionChatModelValue(session, state.models) : state.models.includes(session?.chatModel) ? session.chatModel : '';
      const globalChatModel = getConfig().chatModel;
      const options = sessionConfig.sessionModelOptions ? sessionConfig.sessionModelOptions({ models: state.models, globalChatModel, isAllowed: isModelAllowedFor }) : [{ value: '', label: `跟随全局${globalChatModel ? ` · ${globalChatModel}` : ''}` }].concat([...new Set(state.models)].filter(model => isModelAllowedFor(model, 'chat')).map(model => ({ value: model, label: model })));
      panel.innerHTML = options.map(option => `<button class="session-model-menu-item${option.value === value ? ' active' : ''}" type="button" role="menuitemradio" aria-checked="${option.value === value ? 'true' : 'false'}" data-model="${escapeHtml(option.value)}"><span>${escapeHtml(option.label)}</span>${option.value === value ? '<b>✓</b>' : ''}</button>`).join('');
      panel.querySelectorAll('.session-model-menu-item').forEach(node => node.addEventListener('click', () => setSessionChatModel(node.dataset.model || '')));
      button.classList.toggle('has-session-model', !!value);
      button.title = value ? `会话模型：${value}` : `跟随全局聊天模型${globalChatModel ? `：${globalChatModel}` : ''}`;
    }
    function setSessionChatModel(model = '') {
      const state = getState();
      const session = getActiveSession();
      if (!session) return;
      session.chatModel = sessionConfig.normalizeSessionChatModel ? sessionConfig.normalizeSessionChatModel(model, state.models) : state.models.includes(model) ? model : '';
      session.updatedAt = Date.now();
      saveSessionsMeta();
      renderSessionModelArea();
      closeSessionModelPanel();
    }

    return Object.freeze({ renderSessionList, newSession, deleteSession, clearAllSessions, beginRenameSession, renderSessionModelArea, setSessionChatModel });
  }

  const api = Object.freeze({ createSessionUiWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSessionUiWorkflow = api;
  if (root?.window) root.window.ChatUIAppSessionUiWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
