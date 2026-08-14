const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../../client/app/app-context');
const taskState = require('../../client/core/task-state');
const clarification = require('../../shared/clarification-answer');
require('../../client/features/clarification/presentation');
const regenerateWorkflow = require('../../client/app/regenerate-workflow');

function makeMessageNode() {
  const button = {
    disabled: false,
    classList: { add() {} },
  };
  return {
    dataset: { rawText: 'draw a fox', messageIndex: '0', displayItemId: 'user-a' },
    nextElementSibling: null,
    querySelector(selector) { return selector === '.force-image-btn' ? button : null; },
    button,
  };
}

function createForceImageFixture({ sendImageImpl } = {}) {
  const events = [];
  const pending = [];
  const calls = [];
  const run = { stopped: false, abortController: new AbortController(), jobIds: new Set() };
  const state = {
    activeSessionId: 'session-a',
    messages: [{ role: 'user', content: 'draw a fox', rawText: 'draw a fox' }],
    autoMode: true,
    pageUnloading: false,
  };
  const submitWorkflow = {
    savePendingSubmit(sessionId, value) { pending.push({ sessionId, ...value }); calls.push(['save', value.stage]); return true; },
    clearPendingSubmit(sessionId) { calls.push(['clear', sessionId]); },
  };
  let sentOptions = null;
  const workflow = regenerateWorkflow.createRegenerateWorkflow({
    state,
    taskEvents: taskState.TASK_EVENTS,
    jobLifecycle: {
      makeSubmissionId: () => 'submit-regenerate-a',
      shouldPreservePendingSubmitOnError: () => false,
    },
    dispatchTaskEvent: (sessionId, event) => { events.push({ sessionId, ...event }); calls.push(['event', event.type]); },
    isSessionBusy: () => false,
    toast: () => {},
    ensureActiveRun: () => run,
    resetMessageActionStates: () => {},
    prepareRegeneratedResponse: () => ({ node: { remove() {} }, liveItem: { id: 'display-a' } }),
    getUserAttachmentContextFromNode: () => '{"attachments":[]}',
    restoreUserAttachmentsFromContext: async () => { calls.push(['restore']); return []; },
    updateModeUi: () => {},
    warnMissingModel: () => false,
    isImageFile: () => false,
    sendImage: async (prompt, options) => {
      sentOptions = options;
      calls.push(['send', prompt]);
      return sendImageImpl ? sendImageImpl(options) : options.onDurableHandoff();
    },
    showRunError: (sessionId, error) => calls.push(['error', sessionId, error.message]),
    resetActionButtonState: () => {},
    finishSessionTask: (sessionId, options) => calls.push(['finish', sessionId, options.run]),
    updateResumeStreamButton: () => {},
    getSubmitWorkflow: () => submitWorkflow,
    makeClientImageJobId: () => 'imgjob-regenerate-a',
    resumeSessionJobs: sessionId => calls.push(['resume', sessionId]),
  });
  return { workflow, state, run, events, pending, calls, getSentOptions: () => sentOptions };
}

async function testForceImageRegenerateUsesCanonicalDurableTaskChain() {
  const fixture = createForceImageFixture();
  const node = makeMessageNode();
  await fixture.workflow.forceImageFromUserMessage(node);

  assert.deepStrictEqual(fixture.events.map(event => event.type), [
    taskState.TASK_EVENTS.TASK_ACCEPTED,
    taskState.TASK_EVENTS.ATTACHMENT_CAPTURE_STARTED,
    taskState.TASK_EVENTS.ATTACHMENT_CAPTURED,
    taskState.TASK_EVENTS.ROUTING_STARTED,
    taskState.TASK_EVENTS.HANDOFF_PREPARED,
    taskState.TASK_EVENTS.HANDOFF_COMMITTED,
    taskState.TASK_EVENTS.JOB_COMPLETED_COMMITTED,
  ]);
  assert.strictEqual(fixture.pending[0].stage, 'accepted');
  assert.strictEqual(fixture.pending[0].submissionId, 'submit-regenerate-a');
  assert.strictEqual(fixture.pending.at(-1).stage, 'handoff');
  assert.strictEqual(fixture.pending.at(-1).jobId, 'imgjob-regenerate-a');
  assert.strictEqual(fixture.calls.some(call => call[0] === 'restore'), false,
    'explicit text-to-image must not restore or leak attachments from the historical message');
  const options = fixture.getSentOptions();
  assert.strictEqual(options.submissionId, 'submit-regenerate-a');
  assert.strictEqual(options.clientJobId, 'imgjob-regenerate-a');
  assert.strictEqual(options.executionMedia.version, 'execution_resources.v2');
  assert.strictEqual(options.dispatchContract.schema_version, 'dispatch_contract.v1');
  assert.strictEqual(options.dispatchContract.operation, 'text_to_image');
  assert.strictEqual(options.dispatchContract.arguments.prompt, 'draw a fox');
  assert.deepStrictEqual(options.dispatchContract.bindings, []);
  assert.deepStrictEqual(options.attachments, []);
  assert.ok(fixture.calls.some(call => call[0] === 'finish' && call[2] === fixture.run));
}

async function testRegeneratePostHandoffFailureEntersRecovery() {
  const fixture = createForceImageFixture({
    sendImageImpl: options => {
      options.onDurableHandoff();
      throw new Error('polling interrupted');
    },
  });
  await fixture.workflow.forceImageFromUserMessage(makeMessageNode());
  await new Promise(resolve => setTimeout(resolve, 5));

  assert.strictEqual(fixture.events.at(-1).type, taskState.TASK_EVENTS.JOB_RECOVERY_STARTED);
  assert.ok(!fixture.events.some(event => event.type === taskState.TASK_EVENTS.JOB_COMPLETED_COMMITTED));
  assert.ok(fixture.calls.some(call => call[0] === 'resume' && call[1] === 'session-a'));
  assert.ok(fixture.calls.some(call => call[0] === 'error' && call[2] === 'polling interrupted'));
}


async function testRegenerateCompletionCallbacksPublishOneHandoffAndOneCompletion() {
  const fixture = createForceImageFixture({
    sendImageImpl: options => {
      options.onDurableHandoff();
      options.onInterfaceCompleted({
        sessionId: 'session-a',
        submissionId: 'submit-regenerate-a',
        jobId: 'imgjob-regenerate-a',
        jobKind: 'image',
      });
      throw new Error('late failure after canonical completion');
    },
  });
  await fixture.workflow.forceImageFromUserMessage(makeMessageNode());
  assert.strictEqual(
    fixture.events.filter(event => event.type === taskState.TASK_EVENTS.HANDOFF_COMMITTED).length,
    1,
  );
  assert.strictEqual(
    fixture.events.filter(event => event.type === taskState.TASK_EVENTS.JOB_COMPLETED_COMMITTED).length,
    1,
  );
  assert.strictEqual(
    fixture.events.some(event => event.type === taskState.TASK_EVENTS.JOB_RECOVERY_STARTED || event.type === taskState.TASK_EVENTS.JOB_FAILED),
    false,
  );
  assert.strictEqual(fixture.calls.some(call => call[0] === 'error'), false);
}

function testRegenerateWorkflowUsesExplicitCompositionWithoutNewGlobal() {
  const registered = global.ChatUIApp?.appContext?.getWorkflowModule?.('regenerate');
  assert.strictEqual(registered, regenerateWorkflow);
  assert.strictEqual(typeof registered.createRegenerateWorkflow, 'function');
}

function testRegenerateReusesSubmitResourceAndClarificationSemantics() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app', 'regenerate-workflow.js'), 'utf8');
  assert.ok(source.includes('clarificationApi.createPendingClarification'), 'a regenerate clarification must become persisted pending state instead of an exception');
  assert.ok(source.includes('task.completePreflight()'), 'clarification must finish as a terminal preflight without inventing a managed job handoff');
  assert.ok(source.includes('submitHelpers.buildMediaMapContext?.(executionMedia.chatImages'), 'regenerate must preserve image roles in compact system context');
  assert.ok(source.includes('systemContext:mediaMapContext?[mediaMapContext]:[]'), 'regenerate must preserve the original image numbering map at the system-context boundary');
  assert.ok(source.includes('await sendChat(chatPrompt,chatH'), 'regenerate must send the same role-aware prompt shape as ordinary submit');
  assert.ok(source.includes('getEffectiveRouteWithSlowNotice(replayPrompt,h,{},null,{currentTurn:{messageIndex:n+1},submissionId:task.submissionId}),g=p.mode'),
    'ordinary regeneration must invoke the canonical route recognizer with the current-turn marker');
  assert.ok(!source.includes('regenerateContextOverride'),
    'ordinary regeneration must not replace canonical route recognition with a hand-built context');
  assert.ok(source.includes('const imageBatchPlan=submitHelpers.executableImageBatch?.(p);'),
    'regeneration must inspect the compiled image plan instead of always dispatching the top-level image contract');
  assert.ok(source.includes('await sendImageBatch(l,{items:compiledBatch.items.map'),
    'a compiled multi-image plan must delegate to one server batch endpoint instead of browser-side fan-out');
  assert.ok(source.includes('batchParent:m'),
    'all regenerated batch children must target the same replacement assistant message rather than creating separate messages');
  assert.ok(source.includes('onInterfaceCompleted:completion=>task.interfaceCompleted(completion)'),
    'regeneration must complete the replacement task through the single parent batch identity');
  assert.ok(!source.includes('err.code="ROUTE_NEEDS_CLARIFICATION"'), 'a clarification route must not be degraded into an error toast');
}


function createCancelledRegenerateFixture(routeImpl) {
  const events = [];
  const run = { stopped: false, abortController: new AbortController(), jobIds: new Set() };
  const userNode = { dataset: { rawText: 'ambiguous regenerate request', messageIndex: '0', displayItemId: 'user-cancel' } };
  const refreshButton = { disabled: false, classList: { add() {}, remove() {} } };
  const assistantNode = {
    dataset: { responseIndex: '1' },
    isConnected: false,
    querySelector(selector) { return selector === '.refresh-btn' ? refreshButton : null; },
  };
  const liveItem = { id: 'display-cancel', role: 'assistant', content: 'routing', pending: '1', responseIndex: '1' };
  const session = { id: 'session-cancel-regenerate', messages: [], display: [liveItem] };
  const state = {
    activeSessionId: session.id,
    autoMode: true,
    messages: [
      { role: 'user', content: 'ambiguous regenerate request', rawText: 'ambiguous regenerate request', messageIndex: '0' },
      { role: 'assistant', content: 'old answer', rawText: 'old answer', responseIndex: '1' },
    ],
    sessions: [session],
  };
  session.messages = state.messages.slice();
  const submitWorkflow = {
    savePendingSubmit: () => true,
    clearPendingSubmit: () => {},
  };
  const workflow = regenerateWorkflow.createRegenerateWorkflow({
    state,
    taskEvents: taskState.TASK_EVENTS,
    jobLifecycle: {
      makeSubmissionId: () => 'submit-cancel-regenerate',
      shouldPreservePendingSubmitOnError: () => false,
    },
    messageReplacement: {
      resolveUserMessageTurn: () => ({ userIndex: 0, assistantIndex: 1 }),
      ensureAssistantReplacementSlot: (_messages, turn) => turn,
    },
    dispatchTaskEvent: (_sessionId, event) => events.push(event),
    isSessionBusy: () => false,
    findPreviousUserMessageNode: () => userNode,
    toast: () => {},
    ensureActiveRun: () => run,
    resetMessageActionStates: () => {},
    prepareRegeneratedResponse: () => ({ node: assistantNode, liveItem }),
    getUserAttachmentContextFromNode: () => '',
    restoreUserAttachmentsFromContext: async () => [],
    updateModeUi: () => {},
    warnMissingModel: () => false,
    isImageFile: () => false,
    sendImage: async () => { throw new Error('cancelled regeneration must not dispatch an image'); },
    sendChat: async () => { throw new Error('cancelled regeneration must not dispatch chat'); },
    showRunError: () => { throw new Error('cancelled regeneration must not render an error'); },
    resetActionButtonState: () => {},
    finishSessionTask: () => {},
    updateResumeStreamButton: () => {},
    getSubmitWorkflow: () => submitWorkflow,
    createRouteRecognitionUi: () => ({
      stopSlowNotice() {},
      getEffectiveRouteWithSlowNotice: () => routeImpl(run),
    }),
    quotedFileCandidatesFromContext: () => [],
    getMessageWorkflow: () => ({ readQuoteContext: () => null }),
    parseImageContext: () => null,
    restoreImageAttachmentsFromContext: async () => [],
    makeClientChatJobId: () => 'chatjob-cancel-regenerate',
    makeClientImageJobId: () => 'imgjob-cancel-regenerate',
    resumeSessionJobs: () => {},
  });
  return { workflow, assistantNode, state, events, run };
}

async function testRegenerateCancellationBeforeClarificationDoesNotCommitCompletion() {
  const fixture = createCancelledRegenerateFixture(async run => {
    run.stopped = true;
    run.abortController.abort();
    return {
      mode: 'chat', api: 'clarify', needClarification: true, dispatchAuthorized: false,
      readiness: 'needs_clarification', relation: 'new', operationType: 'plain_chat',
      clarificationQuestion: 'This cancelled clarification must not be committed.',
      clarificationSlots: [], resources: [],
    };
  });
  await fixture.workflow.regenerateAssistantMessage(fixture.assistantNode);
  assert.strictEqual(
    fixture.state.messages.some(message => /cancelled clarification/.test(String(message?.content || ''))),
    false,
  );
  assert.strictEqual(
    fixture.events.some(event => event.type === taskState.TASK_EVENTS.TASK_COMPLETED_COMMITTED),
    false,
  );
  assert.strictEqual(
    fixture.events.filter(event => event.type === taskState.TASK_EVENTS.TASK_STOPPED).length,
    1,
  );
}

async function testRegenerateThrownCancellationEmitsOneStoppedTerminalEvent() {
  const fixture = createCancelledRegenerateFixture(async run => {
    run.stopped = true;
    run.abortController.abort();
    const error = new Error('regeneration cancelled');
    error.name = 'AbortError';
    throw error;
  });
  await fixture.workflow.regenerateAssistantMessage(fixture.assistantNode);
  assert.strictEqual(
    fixture.events.filter(event => event.type === taskState.TASK_EVENTS.TASK_STOPPED).length,
    1,
    'catch and finally must not publish duplicate stopped terminal events',
  );
  assert.strictEqual(
    fixture.events.some(event => event.type === taskState.TASK_EVENTS.TASK_FAILED),
    false,
  );
}

async function testRegenerateAbortSignalSuppressesLateNonAbortError() {
  const fixture = createCancelledRegenerateFixture(async run => {
    run.abortController.abort();
    throw new Error('late adapter failure after cancellation');
  });
  await fixture.workflow.regenerateAssistantMessage(fixture.assistantNode);
  assert.strictEqual(
    fixture.events.filter(event => event.type === taskState.TASK_EVENTS.TASK_STOPPED).length,
    1,
    'an aborted regenerate run must publish one stopped terminal event even if the adapter throws a generic error',
  );
  assert.strictEqual(
    fixture.events.some(event => event.type === taskState.TASK_EVENTS.TASK_FAILED),
    false,
  );
}


async function testRegenerateTruncatesDiscardedConversationBranchBeforeReplacement() {
  const fixture = createCancelledRegenerateFixture(async run => {
    run.stopped = true;
    run.abortController.abort();
    throw new DOMException('Stopped', 'AbortError');
  });
  const trailingNode = {
    removed: false,
    nextElementSibling: null,
    classList: { contains: value => value === 'message' },
    remove() { this.removed = true; },
  };
  fixture.assistantNode.nextElementSibling = trailingNode;
  fixture.state.messages = [
    { role: 'user', content: 'ambiguous regenerate request', rawText: 'ambiguous regenerate request', messageIndex: '0' },
    { role: 'assistant', content: 'old answer', rawText: 'old answer', responseIndex: '1' },
    { role: 'user', content: 'discarded follow-up', rawText: 'discarded follow-up', messageIndex: '2' },
    { role: 'assistant', content: 'discarded answer', rawText: 'discarded answer', responseIndex: '3' },
  ];
  fixture.state.sessions[0].messages = fixture.state.messages.slice();
  fixture.state.sessions[0].display = [
    { id: 'pending-tail', role: 'assistant', pending: '1', responseIndex: '3' },
  ];
  fixture.state.sessions[0].lastGeneratedImage = { referenceId: 'imgref_discarded', src: 'indexeddb://discarded' };
  fixture.state.lastGeneratedImage = fixture.state.sessions[0].lastGeneratedImage;

  await fixture.workflow.regenerateAssistantMessage(fixture.assistantNode);

  assert.deepStrictEqual(fixture.state.messages.map(message => message.content), ['ambiguous regenerate request', 'discarded follow-up', 'discarded answer']);
  assert.deepStrictEqual(fixture.state.sessions[0].messages.map(message => message.content), ['ambiguous regenerate request', 'discarded follow-up', 'discarded answer']);
  assert.deepStrictEqual(fixture.state.sessions[0].display, [{ id: 'pending-tail', role: 'assistant', pending: '1', responseIndex: '3' }]);
  assert.strictEqual(fixture.state.sessions[0].pendingClarification || null, null);
  assert.strictEqual(fixture.state.sessions[0].lastGeneratedImage, null);
  assert.strictEqual(fixture.state.lastGeneratedImage, null);
  assert.strictEqual(trailingNode.removed, false, 'historical regeneration must retain rendered messages after the regenerated answer');
}

async function testRegeneratingClarificationReplaysCanonicalPendingStateWithoutRerouting() {
  const pending = clarification.createPendingClarification({
    messages: [{ role: 'user', content: '换一下猫的姿势' }],
    clarificationText: '请选择要修改的猫图。',
    routeInfo: {
      mode: 'chat', api: 'clarify', needClarification: true,
      clarificationQuestion: '请选择要修改的猫图。',
      clarificationSlots: [{
        key: 'r1', type: 'image', role: 'target', reason: 'ambiguous',
        choices: [
          { key: 'c1', source: 'history', index: 1, id: 'cat-a', reference_id: 'cats', label: '猫 1' },
          { key: 'c2', source: 'history', index: 2, id: 'cat-b', reference_id: 'cats', label: '猫 2' },
        ],
      }],
    },
  });
  const userNode = { dataset: { rawText: '换一下猫的姿势', messageIndex: '0' } };
  const contentNode = { textContent: '' };
  const refreshButton = { disabled: false, classList: { add() {}, remove() {} } };
  const liveItem = { id: 'display-clarification', role: 'assistant', responseIndex: '1' };
  const assistantNode = {
    dataset: { rawText: pending.clarificationText, responseIndex: '1', displayItemId: liveItem.id },
    __displayItem: liveItem,
    isConnected: true,
    querySelector(selector) {
      if (selector === '.refresh-btn') return refreshButton;
      if (selector === '.content') return contentNode;
      return null;
    },
    querySelectorAll() { return []; },
  };
  const state = {
    activeSessionId: 'session-clarification',
    messages: [
      { role: 'user', content: '换一下猫的姿势', rawText: '换一下猫的姿势', messageIndex: '0' },
      { role: 'assistant', content: pending.clarificationText, rawText: pending.clarificationText, responseIndex: '1' },
    ],
    sessions: [{ id: 'session-clarification', pendingClarification: pending, display: [liveItem], messages: [] }],
  };
  state.sessions[0].messages = state.messages.slice();
  let prepareCalls = 0;
  let routeCalls = 0;
  let rendered = null;
  const previous = {
    updateMessage: global.updateMessage,
    persistSessionDisplay: global.persistSessionDisplay,
    saveSessionMessages: global.saveSessionMessages,
    saveSessionsMeta: global.saveSessionsMeta,
  };
  global.updateMessage = (node, value, options) => { rendered = { node, value, options }; };
  global.persistSessionDisplay = () => {};
  global.saveSessionMessages = () => {};
  global.saveSessionsMeta = () => {};
  try {
    const workflow = regenerateWorkflow.createRegenerateWorkflow({
      state,
      isSessionBusy: () => false,
      findPreviousUserMessageNode: () => userNode,
      toast: () => {},
      resetMessageActionStates: () => {},
      prepareRegeneratedResponse: () => { prepareCalls += 1; return {}; },
      createRouteRecognitionUi: () => { routeCalls += 1; return {}; },
    });
    await workflow.regenerateAssistantMessage(assistantNode);
    await workflow.regenerateAssistantMessage(assistantNode);
  } finally {
    global.updateMessage = previous.updateMessage;
    global.persistSessionDisplay = previous.persistSessionDisplay;
    global.saveSessionMessages = previous.saveSessionMessages;
    global.saveSessionsMeta = previous.saveSessionsMeta;
  }

  assert.strictEqual(prepareCalls, 0, 'replaying a clarification must not replace it with a generic routing placeholder');
  assert.strictEqual(routeCalls, 0, 'replaying a persisted clarification must not ask the route model to guess the task again');
  assert.ok(rendered?.value.includes('clarification-choice-card'));
  assert.ok(state.messages[1].clarificationId, 'the replayed clarification message must retain the canonical clarification identity');
  assert.strictEqual(state.sessions[0].pendingClarification.id, state.messages[1].clarificationId);
}


async function testRegenerateUsesCanonicalRouteRecognitionContext() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app', 'regenerate-workflow.js'), 'utf8');
  assert.ok(source.includes('getEffectiveRouteWithSlowNotice(replayPrompt,h,{},null,{currentTurn:{messageIndex:n+1},submissionId:task.submissionId}),g=p.mode'));
  assert.ok(!source.includes('regenerateContextOverride'));
}

module.exports = [
  testForceImageRegenerateUsesCanonicalDurableTaskChain,
  testRegeneratePostHandoffFailureEntersRecovery,
  testRegenerateCompletionCallbacksPublishOneHandoffAndOneCompletion,
  testRegenerateWorkflowUsesExplicitCompositionWithoutNewGlobal,
  testRegenerateReusesSubmitResourceAndClarificationSemantics,
  testRegenerateCancellationBeforeClarificationDoesNotCommitCompletion,
  testRegenerateThrownCancellationEmitsOneStoppedTerminalEvent,
  testRegenerateAbortSignalSuppressesLateNonAbortError,
  testRegenerateTruncatesDiscardedConversationBranchBeforeReplacement,
  testRegeneratingClarificationReplaysCanonicalPendingStateWithoutRerouting,
  testRegenerateUsesCanonicalRouteRecognitionContext,
];

