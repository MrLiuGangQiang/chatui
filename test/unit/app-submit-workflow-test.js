const assert = require('assert');
const workflow = require('../../client/app/submit-workflow');

(async function run() {
  let prevented = false;
  const state = { activeSessionId: 's1', suppressNextSubmitStop: false, attachments: [], mode: 'chat' };
  const submit = workflow.createSubmitWorkflow({
    state,
    isSessionBusy: () => false,
    hasPendingUploads: () => false,
    $: id => id === 'prompt' ? { value: '', focus() {} } : null,
  });
  assert.strictEqual(typeof submit.onSubmit, 'function');
  await submit.onSubmit({ preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, true);

  let releasePreview;
  const prompt = { value: 'hello', focus() {} };
  const state2 = {
    activeSessionId: 's1',
    suppressNextSubmitStop: false,
    attachments: [],
    mode: 'chat',
    messages: [],
    sessions: [
      { id: 's1', messages: [], display: [] },
      { id: 's2', messages: [], display: [] },
    ],
    promptDrafts: new Map(),
    editingIndex: null,
    editingNode: null,
  };
  const displayBySession = new Map();
  let addMessageCount = 0;
  let sentSessionId = '';
  const submitRace = workflow.createSubmitWorkflow({
    state: state2,
    isSessionBusy: () => false,
    hasPendingUploads: () => false,
    $: id => id === 'prompt' ? prompt : null,
    unlockDoneSound() {},
    saveConfig() {},
    ensureActiveRun: () => ({ stopped: false, abortController: { signal: { aborted: false } } }),
    prepareUserAttachmentPreviews: () => new Promise(resolve => { releasePreview = resolve; }),
    renderUserMessageWithAttachments: text => `<p>${text}</p>`,
    buildUserMessageContent: text => text,
    buildUserApiContent: text => text,
    buildUploadedImageContext: async () => null,
    buildUserAttachmentContext: async () => null,
    addMessage: () => { addMessageCount += 1; return {}; },
    appendSessionDisplayMessage: (sessionId, role, content, options) => {
      const item = { role, content, ...options };
      displayBySession.set(sessionId, [...(displayBySession.get(sessionId) || []), item]);
      return item;
    },
    persistSessionDisplay() {},
    cloneMessageList: messages => messages.map(item => ({ ...item })),
    getActiveSession: () => state2.sessions.find(item => item.id === state2.activeSessionId),
    saveChatHistory() {
      if (state2.activeSessionId !== 's1') throw new Error('must not save switched active session');
      state2.sessions[0].messages = state2.messages.map(item => ({ ...item }));
    },
    saveSessionMessages: (sessionId, messages) => {
      const session = state2.sessions.find(item => item.id === sessionId);
      session.messages = messages.map(item => ({ ...item }));
    },
    clearAttachments() {},
    scheduleAutoResize() {},
    setSessionBusy() {},
    pendingFeedbackHtml: text => text,
    normalizeRoute: value => value,
    getEffectiveRoute: async () => ({ mode: 'chat', target: 'none' }),
    buildRequestHeaders: () => ({}),
    warnMissingModel: () => false,
    showRunError(_sessionId, err) { throw err; },
    sendChat: async (_text, _attachments, _loadingNode, options) => {
      sentSessionId = options.sessionId;
    },
    clearActiveRun() {},
  });
  const pending = submitRace.onSubmit({ preventDefault() {} });
  assert.strictEqual(addMessageCount, 2, 'user message and pending assistant are rendered synchronously before async preparation');
  assert.deepStrictEqual(state2.sessions[0].messages.map(item => item.content), ['hello'], 'user message is persisted before first await resolves');
  state2.activeSessionId = 's2';
  state2.messages = [];
  releasePreview();
  await pending;
  assert.strictEqual(addMessageCount, 2, 'switched-away submit must not render additional nodes into the new active session DOM');
  assert.strictEqual(sentSessionId, 's1', 'send continues in the original session');
  assert.deepStrictEqual(state2.sessions[0].messages.map(item => item.content), ['hello'], 'user message is persisted to original session');
  assert.strictEqual(state2.sessions[1].messages.length, 0, 'new active session is not polluted');
  assert.strictEqual(displayBySession.get('s1').filter(item => item.role === 'user').length, 1, 'user display item is persisted to original session');

  console.log('app submit workflow ok');
})();
