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

async function testStaleReplyIndexesRepairThreeTurnsBeforeTheNextEdit() {
  // This is the exact persisted shape that rendered as q1/q2/q3/a1/a2/a3:
  // array order retained the conversation, but stale per-role indexes made the
  // persistence sorter group all user messages before all assistant replies.
  const session = {
    id: 'message-sequence-repair', title: 'Session', display: [],
    messages: [
      { role: 'user', content: 'question 1', rawText: 'question 1', messageIndex: '0' },
      { role: 'user', content: 'question 2', rawText: 'question 2', messageIndex: '1' },
      { role: 'user', content: 'question 3', rawText: 'question 3', messageIndex: '2' },
      { role: 'assistant', content: 'answer 1', rawText: 'answer 1', responseIndex: '3' },
      { role: 'assistant', content: 'answer 2', rawText: 'answer 2', responseIndex: '4' },
      { role: 'assistant', content: 'answer 3', rawText: 'answer 3', responseIndex: '5' },
    ],
  };
  const { state, workflow } = createWorkflow(session);

  await workflow.saveSessionMessages(session.id, session.messages);

  assert.deepStrictEqual(session.messages.map(message => `${message.role}:${message.content}`), [
    'user:question 1', 'assistant:answer 1',
    'user:question 2', 'assistant:answer 2',
    'user:question 3', 'assistant:answer 3',
  ], 'the canonical writer must preserve source conversation order rather than grouping by stale indexes');
  assert.deepStrictEqual(session.messages.map(message => message.role === 'user' ? message.messageIndex : message.responseIndex), [
    '0', '1', '2', '3', '4', '5',
  ], 'the persisted sequence must repair every derived placement index');
  assert.deepStrictEqual(state.messages.map(message => message.content), session.messages.map(message => message.content),
    'the active working copy must receive the repaired canonical sequence too');
  const migratedIds = session.messages.map(message => message.id);
  assert.strictEqual(new Set(migratedIds).size, 6, 'legacy messages must be migrated to unique immutable identities');
  assert.ok(migratedIds.every(id => /^message:message-sequence-repair:[A-Za-z0-9:_-]+:(?:user|assistant)$/.test(id)),
    'legacy migration must produce stable storage-safe message IDs');
  assert.deepStrictEqual(session.messages.filter(message => message.role === 'assistant').map(message => message.replyToMessageId), [
    session.messages[0].id, session.messages[2].id, session.messages[4].id,
  ], 'every reply must bind to the user message in its own turn');

  const editedTurn = sessionPersistence.resolveUserMessageTurn(session.messages, '4', { rawText: 'question 3' });
  assert.deepStrictEqual(editedTurn, { userIndex: 4, assistantIndex: 5, hasAssistant: true },
    'editing the last question must resolve its own adjacent reply after persistence repair');
  const lastAssistantId = session.messages[5].id;
  sessionPersistence.ensureAssistantReplacementSlot(session.messages, editedTurn, { replacing: true, responseIndex: '5' });
  assert.strictEqual(session.messages[5].id, lastAssistantId, 'editing a turn must replace its existing assistant record rather than create a new identity');
  assert.strictEqual(session.messages[5].replyToMessageId, session.messages[4].id, 'replacement reply must remain bound to the edited user message');
  assert.deepStrictEqual(session.messages.slice(0, 4).map(message => message.content), [
    'question 1', 'answer 1', 'question 2', 'answer 2',
  ], 'replacing the last reply must not clear earlier history');
}


function testNewTurnIdentityIsStableAndUsesOnlySafeParts() {
  const user = sessionPersistence.createMessageTurnIdentity({
    sessionId: 'session with spaces', submissionId: 'submit/1', role: 'user', sequence: 9,
  });
  const assistant = sessionPersistence.createMessageTurnIdentity({
    sessionId: 'session with spaces', submissionId: 'submit/1', role: 'assistant', sequence: 9,
  });
  assert.deepStrictEqual(user, {
    id: 'message:session-with-spaces:submit-1:user',
    turnId: 'turn:session-with-spaces:submit-1',
  });
  assert.deepStrictEqual(assistant, {
    id: 'message:session-with-spaces:submit-1:assistant',
    turnId: user.turnId,
  });
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
  testStaleReplyIndexesRepairThreeTurnsBeforeTheNextEdit,
  testNewTurnIdentityIsStableAndUsesOnlySafeParts,
];
