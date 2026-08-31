const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../../client/app/app-context');
const taskState = require('../../client/core/task-state');
const clarification = require('../../shared/clarification-answer');
require('../../client/features/clarification/presentation');
const regenerateWorkflow = require('../../client/app/regenerate-workflow');
const routeService = require('../../client/services/route-service');
const sessionPersistence = require('../../client/app/session-persistence');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

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

function createForceImageFixture({ sendImageImpl, routeResult } = {}) {
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
    createRouteRecognitionUi: () => ({
      getEffectiveRouteWithSlowNotice: async () => {
        calls.push(['route', 'draw a fox']);
        return routeResult || routeService.createExplicitTextToImageRoute('draw a fox');
      },
    }),
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

async function testForceImageRegenerateSkipsIntentRecognitionAndDispatchesDirectly() {
  const fixture = createForceImageFixture();
  await fixture.workflow.forceImageFromUserMessage(makeMessageNode());
  const routeCall = fixture.calls.findIndex(call => call[0] === 'route');
  const sendCall = fixture.calls.findIndex(call => call[0] === 'send');
  assert.strictEqual(routeCall, -1, 'explicit force-image must not run intent recognition');
  assert.ok(sendCall >= 0, 'explicit force-image must dispatch the image request directly');
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

async function testForceImageRepairsPlainRouteToCanonicalImageContract() {
  const wrongRoute = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation: 'new',
    goal: 'draw a fox',
    goal_mode: 'replace',
    resource_refs: [],
    task_shape: 'single',
  }), { input: 'draw a fox', attachments: [], context: {} }).route;
  const fixture = createForceImageFixture({ routeResult: wrongRoute });

  await fixture.workflow.forceImageFromUserMessage(makeMessageNode());

  const options = fixture.getSentOptions();
  assert.ok(options, 'force-image must reach the image handoff');
  assert.strictEqual(options.dispatchContract.operation, 'text_to_image',
    'explicit force-image action must not dispatch a model-selected plain-chat contract');
  assert.strictEqual(options.dispatchContract.api, 'image_generation');
  assert.strictEqual(fixture.calls.some(call => call[0] === 'error'), false,
    'a wrong model route must be repaired before it becomes a user-visible protocol error');
}

function testRegenerateWorkflowUsesExplicitCompositionWithoutNewGlobal() {
  const registered = global.ChatUIApp?.appContext?.getWorkflowModule?.('regenerate');
  assert.strictEqual(registered, regenerateWorkflow);
  assert.strictEqual(typeof registered.createRegenerateWorkflow, 'function');
}

function testRegenerateDelegatesToUnifiedSubmitPipeline() {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "client", "app", "regenerate-workflow.js"), "utf8");
  assert.ok(source.includes("submitWorkflow.onSubmit({preventDefault(){}},{promptOverride:s})"),
    "regeneration must submit through the unified submit pipeline with the original text");
  assert.ok(source.includes("state.editingIndex=n"), "regeneration must prepare the edit message index");
  assert.ok(source.includes("state.editingNode=t"), "regeneration must prepare the edit message node");
  assert.ok(source.includes("state.editingQuoteContext=String("), "regeneration must prepare the edit quote context");
  assert.ok(source.includes("clarificationApi.matchesPendingClarificationMessage"),
    "a regenerated clarification must remain a persisted pending state");
  assert.ok(!source.includes("getEffectiveRouteWithSlowNotice(replayPrompt,h,{},null"),
    "regeneration must not run its own route recognition anymore");
  assert.ok(!source.includes("truncateRegenerationBranch"), "the old regenerate branch truncation implementation must stay removed");
  assert.ok(!source.includes("createRouteRecognitionUi"), "the old independent regenerate route recognizer wiring must stay removed");
  assert.ok(!source.includes("sendImageBatch("), "the old independent regenerate batch dispatch must stay removed");

  const submitSource = fs.readFileSync(path.join(__dirname, "..", "..", "client", "app", "submit-workflow.js"), "utf8");
  assert.ok(submitSource.includes("async function onSubmit(e, options = {})"),
    "submit must expose an options argument for programmatic replay");
  assert.ok(submitSource.includes("return runSubmit(e, options);"),
    "submit must forward replay options into the canonical runSubmit pipeline");
}

async function testRegeneratePreservesConversationBeforeUnifiedSubmit() {
  const fixture = createUnifiedRegenerateFixture();
  fixture.state.messages = [
    { role: "user", content: "ambiguous regenerate request", rawText: "ambiguous regenerate request", messageIndex: "0" },
    { role: "assistant", content: "old answer", rawText: "old answer", responseIndex: "1" },
    { role: "user", content: "later follow-up", rawText: "later follow-up", messageIndex: "2" },
    { role: "assistant", content: "later answer", rawText: "later answer", responseIndex: "3" },
  ];
  fixture.state.sessions[0].messages = fixture.state.messages.slice();
  fixture.userNode.dataset.rawText = "ambiguous regenerate request";

  await fixture.workflow.regenerateAssistantMessage(fixture.assistantNode);

  assert.deepStrictEqual(fixture.state.messages.map(message => message.content),
    ["ambiguous regenerate request", "old answer", "later follow-up", "later answer"],
    "the adapter must not truncate or rewrite conversation state before the unified submit pipeline");
  assert.strictEqual(fixture.onSubmitCalls.length, 1);
  assert.strictEqual(fixture.onSubmitCalls[0].options.promptOverride, "ambiguous regenerate request");
  assert.strictEqual(fixture.state.editingIndex, 0);
  assert.strictEqual(fixture.state.editingNode, fixture.userNode);
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
    sourceImageContext: {
      attachments: [
        { imageId: 'cat-a', src: 'indexeddb://cat-a', name: 'cat-a.png' },
        { imageId: 'cat-b', src: 'indexeddb://cat-b', name: 'cat-b.png' },
      ],
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


function createUnifiedRegenerateFixture({ messages = null, attachmentContext = "", restoredAttachments = [], onSubmitImpl = null } = {}) {
  const onSubmitCalls = [];
  const run = { stopped: false, abortController: new AbortController(), jobIds: new Set() };
  const userNode = {
    dataset: { rawText: "draw a fox", messageIndex: "0", displayItemId: "user-unified" },
    classList: { add() {}, remove() {} },
    querySelector() { return null; },
    __displayItem: null,
  };
  const refreshButton = { disabled: false, classList: { add() {}, remove() {} } };
  const assistantNode = {
    dataset: { responseIndex: "1", displayItemId: "answer-unified" },
    isConnected: false,
    querySelector(selector) { return selector === ".refresh-btn" ? refreshButton : null; },
  };
  const defaultMessages = [
    { role: "user", content: "draw a fox", rawText: "draw a fox", messageIndex: "0" },
    { role: "assistant", content: "old answer", rawText: "old answer", responseIndex: "1" },
  ];
  const baseMessages = Array.isArray(messages) ? messages : defaultMessages;
  const session = {
    id: "session-unified",
    display: [{ id: "display-unified", role: "assistant", content: "old answer", rawText: "old answer", responseIndex: "1" }],
    messages: [],
  };
  const state = {
    activeSessionId: session.id,
    autoMode: true,
    messages: baseMessages.slice(),
    sessions: [session],
    attachments: [],
    editingIndex: null,
    editingNode: null,
    editingQuoteContext: "",
    mode: "chat",
  };
  session.messages = state.messages.slice();
  const workflow = regenerateWorkflow.createRegenerateWorkflow({
    state,
    taskEvents: taskState.TASK_EVENTS,
    messageReplacement: sessionPersistence,
    isSessionBusy: () => false,
    findPreviousUserMessageNode: () => userNode,
    toast: () => {},
    resetMessageActionStates: () => {},
    getUserAttachmentContextFromNode: () => attachmentContext,
    restoreUserAttachmentsFromContext: async () => restoredAttachments,
    getSubmitWorkflow: () => ({
      onSubmit: async (event, options) => {
        onSubmitCalls.push({ event, options });
        if (typeof onSubmitImpl === "function") await onSubmitImpl({ event, options });
      },
    }),
  });
  return { workflow, state, session, userNode, assistantNode, onSubmitCalls, run };
}

async function testRegeneratePreparesEditStateAndDelegatesOriginalText() {
  const fixture = createUnifiedRegenerateFixture();
  await fixture.workflow.regenerateAssistantMessage(fixture.assistantNode);

  assert.strictEqual(fixture.onSubmitCalls.length, 1, "regeneration must delegate exactly once to submit");
  assert.strictEqual(fixture.onSubmitCalls[0].options.promptOverride, "draw a fox",
    "regeneration must submit the original user text");
  assert.strictEqual(fixture.state.editingIndex, 0, "regeneration must reuse the edit message index");
  assert.strictEqual(fixture.state.editingNode, fixture.userNode, "regeneration must reuse the edit message node");
  assert.strictEqual(fixture.state.editingQuoteContext, "", "regeneration must prepare the edit quote context");
  assert.strictEqual(fixture.state.attachments.length, 0, "regeneration must restore an empty original attachment set");
}

async function testRegenerateRestoresOriginalAttachmentsForUnifiedEditSubmit() {
  const restored = [{ name: "cat.png", type: "image/png" }];
  const fixture = createUnifiedRegenerateFixture({
    attachmentContext: "{\"attachments\":[{\"name\":\"cat.png\"}]}",
    restoredAttachments: restored,
  });
  await fixture.workflow.regenerateAssistantMessage(fixture.assistantNode);

  assert.deepStrictEqual(fixture.state.attachments, restored,
    "regeneration must restore the original message attachments into the edit state");
  assert.strictEqual(fixture.onSubmitCalls.length, 1);
}

module.exports = [
  testForceImageRepairsPlainRouteToCanonicalImageContract,
  testForceImageRegenerateUsesCanonicalDurableTaskChain,
  testForceImageRegenerateSkipsIntentRecognitionAndDispatchesDirectly,
  testRegeneratePostHandoffFailureEntersRecovery,
  testRegenerateCompletionCallbacksPublishOneHandoffAndOneCompletion,
  testRegenerateWorkflowUsesExplicitCompositionWithoutNewGlobal,
  testRegenerateDelegatesToUnifiedSubmitPipeline,
  testRegeneratePreservesConversationBeforeUnifiedSubmit,
  testRegeneratePreparesEditStateAndDelegatesOriginalText,
  testRegenerateRestoresOriginalAttachmentsForUnifiedEditSubmit,
  testRegeneratingClarificationReplaysCanonicalPendingStateWithoutRerouting,
];
