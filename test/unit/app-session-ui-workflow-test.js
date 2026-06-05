#!/usr/bin/env node
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createSessionUiWorkflow } = require('../../client/app/session-ui-workflow');

const dom = new JSDOM('<div id="sessionList"></div><button id="resumeStreamBtn"></button><input id="prompt"><div id="messages"></div><div id="sessionModelPanel"></div><button id="sessionModelBtn"></button>');
const document = dom.window.document;
const storage = new Map();
const state = {
  sessions: [{ id: 's1', title: 'One', customTitle: '', messages: [{ role: 'assistant' }], display: [], chatModel: '' }],
  activeSessionId: 's1', messages: [], models: ['chat-a'], busySessions: new Set(), activeOutputSessions: new Map(), activeRuns: new Map(), stoppedSessions: new Map(), promptDrafts: new Map(), followingChatJobs: new Set(), followingImageJobs: new Set(), resumingJobs: new Set(), attachments: [],
};
let switched = '';
let savedMeta = 0;
let activeRendered = 0;
let listed = 0;
let toastText = '';
const workflow = createSessionUiWorkflow({
  getState: () => state,
  getElement: id => document.getElementById(id),
  document,
  localStorage: { setItem: (k, v) => storage.set(k, v), getItem: k => storage.get(k) || null, removeItem: k => storage.delete(k) },
  createSession: () => ({ id: `s${state.sessions.length + 1}`, title: '新对话', customTitle: '', messages: [], display: [], chatModel: '' }),
  deriveSessionTitle: session => session.customTitle || session.title || '新对话',
  sessionTitleHtml: session => session.title,
  getSessionReturnCount: () => 1,
  isSessionBusy: () => false,
  switchSession: id => { switched = id; },
  saveActivePromptDraft: () => {},
  restorePromptDraft: () => {},
  saveSessionsMeta: () => { savedMeta += 1; },
  sessionStorageKey: (key, id = state.activeSessionId) => `${key}:${id}`,
  renderActiveSession: () => { activeRendered += 1; },
  updateResumeStreamButton: () => {},
  updateSendAvailability: () => {},
  closeSessionDrawer: () => {},
  showConfirmDialog: async () => true,
  deleteSessionImageBlobs: async () => {},
  clearChatJob: () => {},
  clearImageJob: () => {},
  setSessionBusy: () => {},
  syncActiveSession: () => {},
  collectAllSessionImageKeys: () => new Set(['k']),
  deleteImageDbKeys: async () => {},
  deleteOrphanImageBlobs: async () => {},
  clearAttachments: () => {},
  toast: text => { toastText = text; },
  getActiveSession: () => state.sessions.find(item => item.id === state.activeSessionId),
  getConfig: () => ({ chatModel: 'global' }),
  isModelAllowedFor: () => true,
  escapeHtml: value => String(value),
  closeSessionModelPanel: () => {},
  sessionConfig: {
    sessionChatModelValue: session => session.chatModel || '',
    sessionModelOptions: ({ models }) => [{ value: '', label: 'follow' }, ...models.map(value => ({ value, label: value }))],
    normalizeSessionChatModel: (value, models) => models.includes(value) ? value : '',
  },
  constants: { CHAT_KEY: 'chat', UI_KEY: 'ui', LAST_IMAGE_KEY: 'last', ACTIVE_SESSION_KEY: 'active' },
});

workflow.renderSessionList();
assert.strictEqual(document.querySelectorAll('.session-tab').length, 1);
document.querySelector('.session-tab').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
assert.strictEqual(switched, 's1');
workflow.newSession();
assert.strictEqual(state.sessions[0].id, 's2');
assert.strictEqual(activeRendered, 1);
workflow.renderSessionModelArea();
assert.strictEqual(document.querySelectorAll('.session-model-menu-item').length, 2);
document.querySelector('[data-model="chat-a"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
assert.strictEqual(state.sessions[0].chatModel, 'chat-a');
workflow.beginRenameSession('s2', document.querySelector('.session-tab'));
assert.ok(document.querySelector('.session-title-input'));
(async () => {
  await workflow.deleteSession('s1');
  assert.ok(!state.sessions.find(item => item.id === 's1'));
  await workflow.clearAllSessions();
  assert.strictEqual(state.sessions.length, 1);
  assert.strictEqual(toastText, '已清除所有会话');
  assert.ok(savedMeta > 0);
  console.log('app session ui workflow ok');
})().catch(err => { console.error(err); process.exit(1); });
