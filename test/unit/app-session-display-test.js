#!/usr/bin/env node
const assert = require('assert');
const { createSessionDisplayWorkflow } = require('../../client/app/session-display');

const storage = new Map();
const state = { sessions: [], activeSessionId: '', messages: [], models: ['chat-a'], lastGeneratedImage: null };
const keys = (prefix, id = state.activeSessionId) => `${prefix}:${id || 'default'}`;
function createSession(title = '新对话') { return { id: `s${state.sessions.length + 1}`, title, customTitle: '', messages: [], display: [], lastGeneratedImage: null, createdAt: 1, updatedAt: 1, busy: false, headerValues: {} }; }
let rendered = 0;
const workflow = createSessionDisplayWorkflow({
  getState: () => state,
  getActiveSession: () => { if (!state.sessions.length) { state.sessions.push(createSession()); state.activeSessionId = state.sessions[0].id; } return state.sessions.find(item => item.id === state.activeSessionId) || state.sessions[0]; },
  createSession,
  deriveSessionTitle: session => session.customTitle || session.title || '新对话',
  sessionStorageKey: keys,
  readJsonStorage: (key, fallback) => storage.has(key) ? JSON.parse(storage.get(key)) : fallback,
  safeSetJsonStorage: (key, value) => { storage.set(key, JSON.stringify(value)); return value; },
  compactDisplayItems: items => items,
  compactAdjacentDuplicateMessages: messages => messages,
  sanitizeStoredDisplayItem: item => item,
  sanitizeStoredMessage: item => item,
  renderSessionList: () => { rendered += 1; },
  renderMarkdown: text => `<p>${text}</p>`,
  renderUserMessageContent: text => `<u>${text}</u>`,
  makeDisplayItemId: () => `d${Math.random().toString(36).slice(2, 6)}`,
  displayItemHasRichMedia: item => /img/.test(item.html || ''),
  normalizeLastGeneratedImage: value => value,
  localStorage: { setItem: (k, v) => storage.set(k, v), getItem: k => storage.get(k) || null, removeItem: k => storage.delete(k) },
  constants: { CHAT_KEY: 'chat', UI_KEY: 'ui', LAST_IMAGE_KEY: 'img', SESSIONS_KEY: 'sessions', ACTIVE_SESSION_KEY: 'active', LEGACY_CHAT_KEY: 'legacy-chat', LEGACY_UI_KEY: 'legacy-ui' },
});

state.sessions = [createSession('hello')];
state.activeSessionId = 's1';
const item = workflow.appendSessionDisplayMessage('s1', 'assistant', 'hi', { responseIndex: 1 });
assert.strictEqual(item.role, 'assistant');
assert.ok(storage.has('ui:s1'));
workflow.updateSessionDisplayItem('s1', item, 'assistant', 'done', { pending: false, responseIndex: 1 });
assert.strictEqual(item.pending, '');
workflow.persistDetachedResponse('other', 'assistant', 'x');
workflow.replaceLastSessionDisplayMessage('s1', 'assistant', 'replaced');
assert.strictEqual(state.sessions[0].display.at(-1).rawText, 'replaced');
state.sessions[0].messages = [{ role: 'user', content: 'u' }];
workflow.saveSessionMessages('s1', state.sessions[0].messages);
assert.ok(storage.has('chat:s1'));
workflow.saveSessionsMeta();
assert.ok(storage.has('sessions'));
workflow.syncActiveSession();
assert.strictEqual(rendered > 0, true);
assert.strictEqual(workflow.sessionTitleHtml({ title: '<x>' }), '&lt;x&gt;');
assert.strictEqual(workflow.getSessionReturnCount({ id: 's2', messages: [{ role: 'assistant', content: 'a' }] }), 1);

storage.clear();
storage.set('legacy-chat', JSON.stringify([{ role: 'user', content: 'legacy' }]));
storage.set('legacy-ui', JSON.stringify([{ role: 'user', rawText: 'legacy' }]));
state.sessions = [];
workflow.loadSessions();
assert.strictEqual(state.sessions.length, 1);
assert.strictEqual(state.messages[0].content, 'legacy');

storage.clear();
storage.set('sessions', JSON.stringify([{ id: 'kept', title: '保留会话' }]));
storage.set('chat:kept', JSON.stringify([{ role: 'user', content: 'restored' }]));
storage.set('active', 'missing-session');
state.sessions = [];
state.activeSessionId = '';
workflow.loadSessions();
assert.strictEqual(state.activeSessionId, 'kept');
assert.strictEqual(state.messages[0].content, 'restored');
console.log('app session display ok');
