const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../../client/app/app-context');
const taskState = require('../../client/core/task-state');
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
  assert.strictEqual(options.taskContract.schema_version, 'task_contract.v5');
  assert.strictEqual(options.taskContract.operation, 'text_to_image');
  assert.strictEqual(options.executionMedia.version, 'execution_resources.v1');
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

function testRegenerateWorkflowUsesExplicitCompositionWithoutNewGlobal() {
  const registered = global.ChatUIApp?.appContext?.getWorkflowModule?.('regenerate');
  assert.strictEqual(registered, regenerateWorkflow);
  assert.strictEqual(typeof registered.createRegenerateWorkflow, 'function');
}

function testRegenerateReusesSubmitResourceAndClarificationSemantics() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app', 'regenerate-workflow.js'), 'utf8');
  assert.ok(source.includes('clarificationApi.createPendingClarification'), 'a regenerate clarification must become persisted pending state instead of an exception');
  assert.ok(source.includes('task.completePreflight()'), 'clarification must finish as a terminal preflight without inventing a managed job handoff');
  assert.ok(source.includes('["compare_a","compare_b"].includes(item.routeRole)'), 'regenerate must preserve compare_a/compare_b roles in the chat prompt');
  assert.ok(source.includes('submitHelpers.imageAttachmentIndexGuide?.(chatH'), 'regenerate must preserve the original image numbering map');
  assert.ok(source.includes('await sendChat(chatPrompt,chatH'), 'regenerate must send the same role-aware prompt shape as ordinary submit');
  assert.ok(!source.includes('err.code="ROUTE_NEEDS_CLARIFICATION"'), 'a clarification route must not be degraded into an error toast');
}

module.exports = [
  testForceImageRegenerateUsesCanonicalDurableTaskChain,
  testRegeneratePostHandoffFailureEntersRecovery,
  testRegenerateWorkflowUsesExplicitCompositionWithoutNewGlobal,
  testRegenerateReusesSubmitResourceAndClarificationSemantics,
];
