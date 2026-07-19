'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const sessionPersistence = require('../../client/app/session-persistence');
const messageRecords = require('../../client/app/message-records');
const displayItems = require('../../client/app/display-items');
const jobWorkflow = require('../../client/app/job-workflow');
const submitWorkflow = require('../../client/app/submit-workflow');

function legacyConversationWithBlankIndexes() {
  return [
    { role: 'user', content: 'question 1', rawText: 'question 1', messageIndex: '' },
    { role: 'assistant', content: 'answer 1', rawText: 'answer 1', responseIndex: '' },
    { role: 'user', content: 'question 2', rawText: 'question 2', messageIndex: '   ' },
    { role: 'assistant', content: 'answer 2', rawText: 'answer 2', responseIndex: null },
    { role: 'user', content: 'question 3', rawText: 'question 3' },
    { role: 'assistant', content: 'answer 3', rawText: 'answer 3' },
  ];
}

function testBlankLegacyIndexesPreserveEveryQuestionAnswerPair() {
  const compacted = sessionPersistence.compactAdjacentDuplicateMessages(legacyConversationWithBlankIndexes());

  assert.deepStrictEqual(
    compacted.map(message => `${message.role}:${message.content}`),
    [
      'user:question 1',
      'assistant:answer 1',
      'user:question 2',
      'assistant:answer 2',
      'user:question 3',
      'assistant:answer 3',
    ],
    'blank legacy indexes are missing values, not six copies of index zero'
  );
  assert.deepStrictEqual(
    compacted.map(message => message.role === 'user' ? message.messageIndex : message.responseIndex),
    ['0', '1', '2', '3', '4', '5'],
    'missing order fields must be rebuilt from canonical conversation order'
  );
}

function testBlankIndexesDoNotCreateDuplicateMessageIdsOrDomIndexes() {
  const firstId = messageRecords.messageId({ role: 'user', messageIndex: '' }, { sessionId: 'session-a', sequence: 4 });
  const secondId = messageRecords.messageId({ role: 'user', messageIndex: ' ' }, { sessionId: 'session-a', sequence: 6 });

  assert.strictEqual(firstId, 'session-a:user:4');
  assert.strictEqual(secondId, 'session-a:user:6');
  assert.strictEqual(displayItems.canonicalMessageIndex({ role: 'assistant', responseIndex: '' }, 9), 9);
  assert.ok(Number.isNaN(displayItems.messageNodeIndex({ dataset: { messageIndex: '' }, classList: { contains: role => role === 'user' } })));
}

function testPendingRecoveryDoesNotTreatBlankIndexAsFirstMessage() {
  const messages = [{ role: 'user', content: 'old first question', rawText: 'old first question', messageIndex: '0' }];

  assert.strictEqual(
    jobWorkflow.findPendingSubmissionMessage(messages, { messageIndex: '', promptText: 'old first question', userCommitted: false }),
    null,
    'an incomplete pending record must not claim message zero'
  );
  assert.strictEqual(
    jobWorkflow.findPendingSubmissionMessage(messages, { messageIndex: null, promptText: 'old first question', userCommitted: false }),
    null,
    'a null pending index must not claim message zero'
  );
}


function testReplacementResolverUsesOneCanonicalTurnForEditAndRegenerate() {
  const messages = [
    { role: 'user', content: 'q1', rawText: 'q1', messageIndex: '0' },
    { role: 'assistant', content: 'a1', rawText: 'a1', responseIndex: '1' },
    { role: 'user', content: 'q2', rawText: 'q2', messageIndex: '2' },
    { role: 'assistant', content: 'a2', rawText: 'a2', responseIndex: '3' },
  ];

  assert.deepStrictEqual(
    sessionPersistence.resolveUserMessageTurn(messages, '2', { rawText: 'q2' }),
    { userIndex: 2, assistantIndex: 3, hasAssistant: true }
  );
  assert.deepStrictEqual(
    sessionPersistence.resolveUserMessageTurn(messages, '', { rawText: 'q1' }),
    { userIndex: 0, assistantIndex: 1, hasAssistant: true },
    'blank DOM indexes must fall back to the edited message text instead of message zero coercion'
  );
}

function testReplacementSlotNeverOverwritesTheNextQuestion() {
  const messages = [
    { role: 'user', content: 'q1', rawText: 'q1', messageIndex: '0' },
    { role: 'user', content: 'q2', rawText: 'q2', messageIndex: '1' },
    { role: 'assistant', content: 'a2', rawText: 'a2', responseIndex: '2' },
  ];
  const turn = sessionPersistence.resolveUserMessageTurn(messages, 0, { rawText: 'q1' });
  const replacement = sessionPersistence.ensureAssistantReplacementSlot(messages, turn, { content: 'pending', rawText: 'pending' });

  assert.strictEqual(replacement.assistantIndex, 1);
  assert.strictEqual(replacement.inserted, true);
  assert.deepStrictEqual(messages.map(message => `${message.role}:${message.content}`), [
    'user:q1',
    'assistant:pending',
    'user:q2',
    'assistant:a2',
  ]);
  assert.deepStrictEqual(messages.map(message => message.role === 'user' ? message.messageIndex : message.responseIndex), ['0', '1', '2', '3']);
}


function testCanonicalDomReconciliationRemovesLateRecoveryDuplicate() {
  const dom = new JSDOM('<main id="messages"><article class="message user" data-message-index="0"></article><article id="old" class="message assistant" data-response-index="1"></article><article class="message user" data-message-index="2"></article><article id="live" class="message assistant" data-response-index="1"></article></main>');
  const container = dom.window.document.getElementById('messages');
  const live = dom.window.document.getElementById('live');

  displayItems.reconcileCanonicalMessageNode(container, live, { role: 'assistant', index: 1 });

  assert.deepStrictEqual(
    [...container.querySelectorAll('.message')].map(node => node.id || `${node.classList.contains('user') ? 'user' : 'assistant'}:${node.dataset.messageIndex || node.dataset.responseIndex}`),
    ['user:0', 'live', 'user:2'],
    'a recovered replacement must occupy the original answer slot instead of appearing as a second answer at the end'
  );
  assert.strictEqual(dom.window.document.getElementById('old'), null);
}

function testBlankDisplayIndexLeavesFreshMessageAtVisibleTail() {
  const dom = new JSDOM('<main id="messages"><article class="message user" data-message-index="0"></article><article class="message assistant" data-response-index="1"></article><article id="fresh" class="message user"></article></main>');
  const container = dom.window.document.getElementById('messages');
  const fresh = dom.window.document.getElementById('fresh');

  displayItems.insertMessageNodeAtDisplayPosition(container, fresh, { role: 'user', messageIndex: '' });

  assert.strictEqual(container.lastElementChild, fresh, 'a missing order index must not coerce to zero and move a newly sent message to the top/out of view');
}

function testEverySubmitModePublishesCanonicalMessageBeforeDomProjection() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const universalIndex = 'messageIndex=initialEditMessageIndex!==null?initialEditMessageIndex:resumedMessageIndex!==null?resumedMessageIndex:(Array.isArray(targetSession?.messages)&&targetSession.messages.length?targetSession.messages.length:state.messages.length)';
  const canonicalWrite = 'if(isTargetActive()){state.messages.push(message);getActiveSession().messages=cloneMessageList(state.messages)}';
  const domProjection = 'userNode=isTargetActive()?addMessage("user",userHtml';

  for (const source of [submit, app]) {
    assert.ok(source.includes(universalIndex), 'chat, image generation, and image editing submissions must all receive a canonical message index');
    assert.ok(source.indexOf(canonicalWrite) < source.indexOf(domProjection), 'canonical state must contain the submitted message before DOM rendering/virtualization observes it');
  }
  assert.ok(!submit.includes('"chat"===submitMode?(Array.isArray(targetSession?.messages)'), 'image-mode submissions must not create blank message indexes');
  assert.ok(app.includes('ChatUIAppDisplayItems?.insertMessageNodeAtDisplayPosition'), 'the root runtime must use the shared guarded display-order method');
}

function testEditSubmitAlwaysUsesReplacementPathAndCommitsBeforeRouting() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const unifiedEdit = 'if(initialEditMessageIndex!==null&&isTargetActive())replacement=applyPendingEdit(promptText,{submissionId,messageIndex:initialEditMessageIndex,node:state.editingNode})';
  const committedReplacement = 'prepareManagedChatJobForLiveItem();await persistTargetMessages()';

  assert.ok(submit.includes(unifiedEdit) && app.includes(unifiedEdit), 'editing must replace the selected turn regardless of the current chat/image mode');
  assert.ok(!submit.includes('state.editingNode&&"chat"===submitMode'), 'image mode must not turn an edit into a newly appended message group');
  assert.ok(submit.includes('editExisting:initialEditMessageIndex!==null') && submit.includes('editMessageIndex:initialEditMessageIndex'), 'pending recovery must retain the edit target identity');
  assert.ok(submit.includes(committedReplacement) && app.includes(committedReplacement), 'the edited canonical turn must commit before route execution or recovery handoff');
}

function testResumedSubmitUsesOnlyExplicitNonNegativeIndexes() {
  assert.strictEqual(submitWorkflow.parseOptionalMessageIndex(''), null);
  assert.strictEqual(submitWorkflow.parseOptionalMessageIndex('   '), null);
  assert.strictEqual(submitWorkflow.parseOptionalMessageIndex(null), null);
  assert.strictEqual(submitWorkflow.parseOptionalMessageIndex(-1), null);
  assert.strictEqual(submitWorkflow.parseOptionalMessageIndex('0'), 0);
  assert.strictEqual(submitWorkflow.parseOptionalMessageIndex(12), 12);
}

module.exports = [
  testBlankLegacyIndexesPreserveEveryQuestionAnswerPair,
  testBlankIndexesDoNotCreateDuplicateMessageIdsOrDomIndexes,
  testPendingRecoveryDoesNotTreatBlankIndexAsFirstMessage,
  testResumedSubmitUsesOnlyExplicitNonNegativeIndexes,
  testReplacementResolverUsesOneCanonicalTurnForEditAndRegenerate,
  testReplacementSlotNeverOverwritesTheNextQuestion,
  testEditSubmitAlwaysUsesReplacementPathAndCommitsBeforeRouting,
  testCanonicalDomReconciliationRemovesLateRecoveryDuplicate,
  testBlankDisplayIndexLeavesFreshMessageAtVisibleTail,
  testEverySubmitModePublishesCanonicalMessageBeforeDomProjection,
];
