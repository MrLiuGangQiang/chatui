'use strict';

const assert = require('assert');
const sessionDisplay = require('../../client/app/session-display');
const sessionPersistence = require('../../client/app/session-persistence');
const messageRecords = require('../../client/app/message-records');

function createWorkflow(session) {
  const state = {
    sessions: [session], activeSessionId: session.id, messages: session.messages,
    disposedSessionIds: new Set(),
  };
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  return {
    state,
    workflow: sessionDisplay.createSessionDisplayWorkflow({
      getState: () => state,
      getActiveSession: () => session,
      deriveSessionTitle: current => current.title || 'Session',
      compactAdjacentDuplicateMessages: sessionPersistence.compactAdjacentDuplicateMessages,
      sanitizeStoredMessage: message => message,
      messageRecords,
      localStorage: storage,
      snapshotStore: { supported: false },
    }),
  };
}

async function testLateMessageWriterCannotEraseAnEarlierCompletedAnswer() {
  const session = {
    id: 'message-write-race', title: 'Session', display: [],
    messages: [
      { role: 'user', content: '第一个问题', messageIndex: '0' },
      { role: 'assistant', content: '第一个回答', responseIndex: '1' },
      { role: 'user', content: '第二个问题', messageIndex: '2' },
      { role: 'assistant', content: '第二个回答', responseIndex: '3' },
    ],
  };
  const { state, workflow } = createWorkflow(session);

  // A late async path only knows the old completed turn. It must not replace the
  // newer canonical sequence that was already accepted for the second question.
  await workflow.saveSessionMessages(session.id, [
    { role: 'user', content: '第一个问题', messageIndex: '0' },
    { role: 'assistant', content: '第一个回答', responseIndex: '1' },
  ]);

  assert.deepStrictEqual(session.messages.map(message => message.content), [
    '第一个问题', '第一个回答', '第二个问题', '第二个回答',
  ]);
  assert.deepStrictEqual(state.messages.map(message => message.content), [
    '第一个问题', '第一个回答', '第二个问题', '第二个回答',
  ]);
}

async function testSameTurnCompletionStillSupersedesItsEarlierPlaceholder() {
  const session = {
    id: 'message-write-replacement', title: 'Session', display: [],
    messages: [
      { role: 'user', content: '问题', messageIndex: '0' },
      { role: 'assistant', content: '正在处理中 请稍后', responseIndex: '1' },
    ],
  };
  const { workflow } = createWorkflow(session);

  await workflow.saveSessionMessages(session.id, [
    { role: 'user', content: '问题', messageIndex: '0' },
    { role: 'assistant', content: '这是已完成的回答。', responseIndex: '1' },
  ]);

  assert.deepStrictEqual(session.messages.map(message => message.content), ['问题', '这是已完成的回答。']);
}

async function testSessionWritesKeepWorkingStateIsolatedFromCanonicalSessionArrays() {
  const sessionA = {
    id: 'session-a', title: 'A', display: [],
    messages: [{ role: 'user', content: 'A question', messageIndex: '0' }],
  };
  const sessionB = {
    id: 'session-b', title: 'B', display: [],
    messages: [{ role: 'user', content: 'B question', messageIndex: '0' }],
  };
  const state = {
    sessions: [sessionA, sessionB],
    activeSessionId: 'session-a',
    messages: sessionA.messages,
    disposedSessionIds: new Set(),
  };
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => state.sessions.find(session => session.id === state.activeSessionId),
    deriveSessionTitle: session => session.title,
    compactAdjacentDuplicateMessages: sessionPersistence.compactAdjacentDuplicateMessages,
    sanitizeStoredMessage: message => message,
    messageRecords,
    localStorage: storage,
    snapshotStore: { supported: false },
  });

  await workflow.saveSessionMessages('session-a', [
    ...sessionA.messages,
    { role: 'assistant', content: 'A answer', responseIndex: '1' },
  ]);
  state.activeSessionId = 'session-b';
  state.messages = sessionB.messages.map(message => ({ ...message }));
  await workflow.saveSessionMessages('session-b', [
    ...state.messages,
    { role: 'assistant', content: 'B answer', responseIndex: '1' },
  ]);

  assert.deepStrictEqual(sessionA.messages.map(message => message.content), ['A question', 'A answer']);
  assert.deepStrictEqual(sessionB.messages.map(message => message.content), ['B question', 'B answer']);
  assert.notStrictEqual(sessionA.messages, sessionB.messages);
  assert.notStrictEqual(state.messages, sessionB.messages);
}

module.exports = [
  testSessionWritesKeepWorkingStateIsolatedFromCanonicalSessionArrays,
  testLateMessageWriterCannotEraseAnEarlierCompletedAnswer,
  testSameTurnCompletionStillSupersedesItsEarlierPlaceholder,
];
