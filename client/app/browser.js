(function () {
  function createSession(title = '新对话') {
    return {
      id: `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      customTitle: '',
      messages: [],
      display: [],
      lastGeneratedImage: null,
      systemPrompt: '',
      hasSystemPromptOverride: false,
      headerValues: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      busy: false,
    };
  }

  function ensureActiveSession(appState) {
    if (!Array.isArray(appState.sessions)) appState.sessions = [];
    if (!appState.sessions.length) {
      const session = createSession();
      appState.sessions = [session];
      appState.activeSessionId = session.id;
    }
    let session = appState.sessions.find(item => item.id === appState.activeSessionId);
    if (!session) {
      session = appState.sessions[0];
      appState.activeSessionId = session.id;
    }
    session.messages ||= [];
    session.display ||= [];
    return session;
  }

  function isSessionBusy(appState, sessionId) {
    return !!appState.busySessions?.has?.(sessionId) || !!appState.sessions?.find(item => item.id === sessionId)?.busy;
  }



  function makeRun(sessionId) {
    return {
      sessionId,
      token: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      abortController: new AbortController(),
      jobIds: new Set(),
      stopped: false,
    };
  }

  function getActiveRun(appState, sessionId) {
    return appState.activeRuns?.get(sessionId) || null;
  }

  function ensureActiveRun(appState, sessionId) {
    let run = getActiveRun(appState, sessionId);
    if (!run) {
      run = makeRun(sessionId);
      appState.activeRuns.set(sessionId, run);
    }
    return run;
  }

  function addActiveRunJob(appState, sessionId, type, jobId) {
    if (!jobId) return false;
    const run = getActiveRun(appState, sessionId);
    if (!run) return false;
    run.jobIds.add(`${type}:${jobId}`);
    return true;
  }

  function isRunStopped(appState, sessionId) {
    return !!getActiveRun(appState, sessionId)?.stopped;
  }

  function bindFollowingRun(appState, sessionId, jobId, type = 'chat') {
    if (!jobId) return null;
    const run = ensureActiveRun(appState, sessionId);
    run.jobIds.add(`${type}:${jobId}`);
    return run;
  }



  function sessionStorageKey(baseKey, sessionId) {
    return `${baseKey}:${sessionId || 'default'}`;
  }

  function deriveSessionTitle(session = {}) {
    const custom = String(session.customTitle || '').replace(/\s+/g, ' ').trim();
    if (custom) return custom.slice(0, 40);
    const firstUser = session.messages?.find(item => item.role === 'user' && item.content)?.content || '';
    const title = String(firstUser || session.title || '新对话').replace(/\s+/g, ' ').trim();
    return title ? title.slice(0, 22) : '新对话';
  }

  function getSessionReturnCount({ session, activeSessionId, activeMessages = [], isBusy = false, domCount = 0 } = {}) {
    if (!session) return 0;
    const messages = session.id !== activeSessionId || isBusy ? session.messages || [] : activeMessages;
    const assistantCount = Array.isArray(messages) ? messages.filter(item => item?.role === 'assistant').length : 0;
    if (assistantCount) return assistantCount;
    return session.id !== activeSessionId || isBusy
      ? (session.display || []).filter(item => item?.role === 'assistant' || item?.role === 'error').length
      : Number(domCount) || 0;
  }



  function stripLargeDataUrlsFromText(text = '') {
    return String(text || '').replace(/data:[^"'<>`\s]+;base64,[A-Za-z0-9+/=]{2048,}/g, '[attachment-data-omitted]');
  }

  function sanitizeAttachmentContextForStorage(value) {
    if (!value) return '';
    try {
      const context = typeof value === 'string' ? JSON.parse(value) : value;
      if (!context || typeof context !== 'object') return '';
      const sanitized = {
        ...context,
        attachments: Array.isArray(context.attachments) ? context.attachments.map(item => {
          const copy = { ...item };
          if (copy.src && String(copy.src).startsWith('data:')) copy.src = '';
          return copy;
        }).filter(item => item.name || item.src || item.text) : [],
      };
      return JSON.stringify(sanitized);
    } catch { return ''; }
  }

  function sanitizeStoredDisplayItem(item = {}) {
    return {
      ...item,
      html: stripLargeDataUrlsFromText(item.html || ''),
      rawText: stripLargeDataUrlsFromText(item.rawText || ''),
      imageContext: sanitizeAttachmentContextForStorage(item.imageContext) || item.imageContext || '',
      attachmentContext: sanitizeAttachmentContextForStorage(item.attachmentContext),
    };
  }

  function sanitizeStoredMessage(message = {}) {
    const next = { ...message };
    next.content = stripLargeDataUrlsFromText(next.content || '');
    next.rawText = stripLargeDataUrlsFromText(next.rawText || '');
    if (next.html) next.html = stripLargeDataUrlsFromText(next.html);
    next.imageContext = sanitizeAttachmentContextForStorage(next.imageContext) || next.imageContext || '';
    next.attachmentContext = sanitizeAttachmentContextForStorage(next.attachmentContext);
    return next;
  }

  function safeSetJsonStorage(key, value, maxItems = 80, storage = localStorage) {
    let items = Array.isArray(value) ? value : value ? [value] : [];
    for (let limit = Math.min(Number(maxItems) || 80, items.length || 1); limit >= 0; limit = Math.floor(limit / 2)) {
      const candidate = Array.isArray(value) ? items.slice(-limit) : value;
      try { storage.setItem(key, JSON.stringify(candidate)); return candidate; }
      catch (err) { if (!/quota|exceed/i.test(`${err?.name || ''} ${err?.message || ''} ${err || ''}`)) throw err; }
      if (limit <= 1) break;
    }
    try { storage.removeItem(key); } catch {}
    return Array.isArray(value) ? [] : null;
  }

  function stripLargePayloadData(value) {
    if (typeof value === 'string') return stripLargeDataUrlsFromText(value);
    if (Array.isArray(value)) return value.map(stripLargePayloadData);
    if (value && typeof value === 'object') {
      const copy = { ...value };
      if (Array.isArray(copy.messages)) copy.messages = copy.messages.slice(-20);
      Object.keys(copy).forEach(key => { copy[key] = stripLargePayloadData(copy[key]); });
      return copy;
    }
    return value;
  }

  function compactJobForStorage(job, keepPayload = true) {
    if (!job || typeof job !== 'object') return job;
    const copy = { ...job };
    if (copy.payload) copy.payload = keepPayload ? stripLargePayloadData(copy.payload) : null;
    return copy;
  }

  function safeSetJobStorage(key, job, storage = localStorage) {
    if (!job?.id) return;
    const fallbacks = [
      compactJobForStorage(job, true),
      compactJobForStorage(job, false),
      {
        id: job.id,
        prompt: job.prompt || '',
        startedAt: job.startedAt || Date.now(),
        displayItemId: job.displayItemId || '',
        responseIndex: job.responseIndex ?? null,
        mode: job.mode || '',
        imageContext: job.imageContext || null,
        liveItemRawText: job.liveItemRawText || '',
      },
    ];
    for (const candidate of fallbacks) {
      try { storage.setItem(key, JSON.stringify(candidate)); return; }
      catch (err) { if (!/quota|exceed/i.test(`${err?.name || ''} ${err?.message || ''} ${err || ''}`)) throw err; }
    }
    try { storage.removeItem(key); } catch {}
  }

  function compactDisplayItems(items = []) {
    const result = [];
    for (const item of items || []) {
      if (!item) continue;
      const prev = result[result.length - 1];
      const key = [item.role || '', item.rawText || '', item.html || '', item.pending || '', item.jobId || '', item.responseIndex || '', item.messageIndex || ''].join('');
      const prevKey = prev ? [prev.role || '', prev.rawText || '', prev.html || '', prev.pending || '', prev.jobId || '', prev.responseIndex || '', prev.messageIndex || ''].join('') : '';
      if (!prev || key !== prevKey) result.push(item);
    }
    return result;
  }

  function makeDisplayItemId() {
    return `display_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function displayItemHasRichMedia(item) {
    return !!(item?.html && (/data-persisted-src=/.test(item.html) || /data-persisted-href=/.test(item.html) || /user-attachment-preview-grid/.test(item.html) || /class=["'][^"']*generated-thumb/.test(item.html) || /class=["'][^"']*user-attachment-image/.test(item.html) || /image-download-row/.test(item.html)));
  }

  window.ChatUIApp = Object.freeze({
    state: Object.freeze({ createSession, ensureActiveSession, isSessionBusy }),
    runs: Object.freeze({ makeRun, getActiveRun, ensureActiveRun, addActiveRunJob, isRunStopped, bindFollowingRun }),
    sessions: Object.freeze({ sessionStorageKey, deriveSessionTitle, getSessionReturnCount }),
    persistence: Object.freeze({ stripLargeDataUrlsFromText, sanitizeAttachmentContextForStorage, sanitizeStoredDisplayItem, sanitizeStoredMessage, safeSetJsonStorage, stripLargePayloadData, compactJobForStorage, safeSetJobStorage }),
    displayItems: Object.freeze({ compactDisplayItems, makeDisplayItemId, displayItemHasRichMedia }),
  });
})();
