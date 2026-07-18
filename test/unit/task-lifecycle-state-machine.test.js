'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jobWorkflow = require('../../client/app/job-workflow');
const sessionPersistence = require('../../client/app/session-persistence');
const submitWorkflow = require('../../client/app/submit-workflow');
const taskState = require('../../client/core/task-state');

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function testAcceptedOwnerMarksBusyBeforeAttachmentCaptureAndStopsCleanly() {
  const storage = makeStorage();
  const previousStorage = global.localStorage;
  global.localStorage = storage;
  const capture = deferred();
  const session = { id: 'session-a', messages: [], display: [] };
  const run = { token: 'run-a', stopped: false, abortController: new AbortController() };
  const state = { sessions: [session], activeSessionId: session.id, attachments: [], promptDrafts: new Map(), disposedSessionIds: new Set() };
  const prompt = { value: 'keep running', focus() {} };
  let busy = false;
  let stopCalls = 0;
  let clearRunCalls = 0;
  const taskEvents = [];

  try {
    const workflow = submitWorkflow.createSubmitWorkflow({
      state,
      taskEvents: taskState.TASK_EVENTS,
      dispatchTaskEvent: (sessionId, event) => taskEvents.push({ sessionId, ...event }),
      $: id => id === 'prompt' ? prompt : null,
      isSessionBusy: () => busy,
      stopActiveRun: async () => {
        stopCalls += 1;
        run.stopped = true;
        run.abortController.abort();
        jobWorkflow.clearPendingSubmit(session.id, { storage });
      },
      toast: () => {},
      hasPendingUploads: () => false,
      updateSendAvailability: () => {},
      unlockDoneSound: () => {},
      saveConfig: () => {},
      ensureActiveRun: () => run,
      setSessionBusy: (sessionId, value) => { assert.strictEqual(sessionId, session.id); busy = !!value; },
      prepareUserAttachmentPreviews: () => capture.promise,
      buildUploadedImageContext: async () => null,
      buildUserAttachmentContext: async () => null,
      clearActiveRun: () => { clearRunCalls += 1; },
      showRunError: () => { throw new Error('a stopped setup must not render an error'); },
    });

    const first = workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    await Promise.resolve();
    const pending = jobWorkflow.loadPendingSubmit(session.id, { storage });
    assert.strictEqual(pending.stage, 'accepted');
    assert.strictEqual(busy, true, 'accepted ownership must lock the session before the first asynchronous capture step');
    assert.deepStrictEqual(taskEvents.map(event => event.type), [
      taskState.TASK_EVENTS.TASK_ACCEPTED,
      taskState.TASK_EVENTS.ATTACHMENT_CAPTURE_STARTED,
    ]);

    await workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    assert.strictEqual(stopCalls, 1, 'a second send click during capture must stop the owned run instead of starting a duplicate submission');

    capture.resolve([]);
    await first;
    assert.strictEqual(jobWorkflow.loadPendingSubmit(session.id, { storage }), null, 'explicit stop must be terminal and must not be resurrected by a late capture continuation');
    assert.strictEqual(busy, false);
    assert.strictEqual(clearRunCalls, 1);
    assert.strictEqual(taskEvents.at(-1).type, taskState.TASK_EVENTS.TASK_STOPPED);
  } finally {
    if (previousStorage === undefined) delete global.localStorage;
    else global.localStorage = previousStorage;
  }
}

async function testAttachmentCaptureFailureUsesUnifiedLifecycleCleanup() {
  const storage = makeStorage();
  const previousStorage = global.localStorage;
  global.localStorage = storage;
  const session = { id: 'session-a', messages: [], display: [] };
  const run = { token: 'run-a', stopped: false, abortController: new AbortController() };
  const state = { sessions: [session], activeSessionId: session.id, attachments: [], promptDrafts: new Map(), disposedSessionIds: new Set() };
  const prompt = { value: 'capture failure', focus() {} };
  const errors = [];
  let busy = false;
  let clearRunCalls = 0;
  const taskEvents = [];

  try {
    const workflow = submitWorkflow.createSubmitWorkflow({
      state,
      taskEvents: taskState.TASK_EVENTS,
      dispatchTaskEvent: (sessionId, event) => taskEvents.push({ sessionId, ...event }),
      $: id => id === 'prompt' ? prompt : null,
      isSessionBusy: () => busy,
      stopActiveRun: async () => {},
      toast: () => {},
      hasPendingUploads: () => false,
      updateSendAvailability: () => {},
      unlockDoneSound: () => {},
      saveConfig: () => {},
      ensureActiveRun: () => run,
      setSessionBusy: (sessionId, value) => { assert.strictEqual(sessionId, session.id); busy = !!value; },
      prepareUserAttachmentPreviews: async () => { throw new Error('capture exploded'); },
      clearActiveRun: () => { clearRunCalls += 1; },
      showRunError: (sessionId, error) => errors.push({ sessionId, error }),
    });

    await workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].error.message, 'capture exploded');
    assert.strictEqual(jobWorkflow.loadPendingSubmit(session.id, { storage }), null);
    assert.strictEqual(busy, false);
    assert.strictEqual(clearRunCalls, 1, 'setup failures must release the active run through the same finally boundary as routed work');
    assert.deepStrictEqual(taskEvents.map(event => event.type), [
      taskState.TASK_EVENTS.TASK_ACCEPTED,
      taskState.TASK_EVENTS.ATTACHMENT_CAPTURE_STARTED,
      taskState.TASK_EVENTS.TASK_FAILED,
    ]);
  } finally {
    if (previousStorage === undefined) delete global.localStorage;
    else global.localStorage = previousStorage;
  }
}

function testAcceptedSubmissionIsDurableBeforeCanonicalUserCommit() {
  const storage = makeStorage();
  const submissionId = jobWorkflow.makeSubmissionId(() => 1000, () => 0.5);
  const saved = jobWorkflow.savePendingSubmit('session-a', {
    submissionId,
    stage: 'accepted',
    rawPromptText: 'recover me',
    submitMode: 'chat',
    userCommitted: false,
  }, { storage });

  assert.strictEqual(saved, true);
  const pending = jobWorkflow.loadPendingSubmit('session-a', { storage });
  assert.strictEqual(pending.version, jobWorkflow.PENDING_SUBMIT_VERSION);
  assert.strictEqual(pending.submissionId, submissionId);
  assert.strictEqual(jobWorkflow.pendingSubmitHasRecoverableInput(pending), true);
  assert.strictEqual(jobWorkflow.isPendingSubmissionCommitted([], pending), false);

  const messages = [{ role: 'user', content: 'recover me', rawText: 'recover me', submissionId }];
  assert.strictEqual(jobWorkflow.findPendingSubmissionMessage(messages, pending), messages[0]);
  assert.strictEqual(jobWorkflow.isPendingSubmissionCommitted(messages, pending), true);
}

function testAttachmentOnlySubmissionRemainsRecoverable() {
  const pending = jobWorkflow.normalizePendingSubmit({
    stage: 'accepted',
    promptText: '',
    rawPromptText: '',
    attachmentCount: 2,
    userCommitted: false,
  });
  assert.strictEqual(jobWorkflow.pendingSubmitHasRecoverableInput(pending), true);
}

function testDisposedSessionCannotRecreatePendingOwner() {
  const storage = makeStorage();
  const result = jobWorkflow.savePendingSubmit('deleted-session', { rawPromptText: 'late write' }, {
    storage,
    isSessionDisposed: () => true,
  });
  assert.strictEqual(result, false);
  assert.strictEqual(storage.data.size, 0);
}

function testJobSnapshotMustRetainPayloadBeforeHandoff() {
  const storage = makeStorage();
  const full = sessionPersistence.safeSetJobStorage('chat:session-a', {
    id: 'chatjob-a',
    api: 'responses',
    submissionId: 'submit-a',
    payload: { model: 'gpt-5-mini', input: 'hello' },
  }, { storage });
  assert.strictEqual(jobWorkflow.isRecoverableJobSnapshot(full, { id: 'chatjob-a', submissionId: 'submit-a' }), true);

  let attempts = 0;
  const fallbackStorage = {
    setItem() {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('QuotaExceededError');
        error.name = 'QuotaExceededError';
        throw error;
      }
    },
  };
  const fallback = sessionPersistence.safeSetJobStorage('chat:session-a', {
    id: 'chatjob-a',
    api: 'responses',
    submissionId: 'submit-a',
    payload: { model: 'gpt-5-mini', input: 'hello' },
  }, { storage: fallbackStorage });
  assert.strictEqual(fallback.payload, null, 'the second storage candidate is identity-only, not restartable');
  assert.strictEqual(jobWorkflow.isRecoverableJobSnapshot(fallback, { id: 'chatjob-a', submissionId: 'submit-a' }), false);
}

function testPendingOwnerYieldsOnlyToItsMatchingDurableHandoff() {
  const pending = {
    stage: 'handoff',
    jobKind: 'image',
    jobId: 'imgjob-a',
    submissionId: 'submit-a',
    rawPromptText: 'draw',
  };
  const imageJob = { id: 'imgjob-a', submissionId: 'submit-a', payload: { model: 'image-model', prompt: 'draw' } };
  const chatJob = { id: 'chatjob-old', submissionId: 'submit-old', payload: { model: 'chat-model', messages: [] } };
  assert.deepStrictEqual(jobWorkflow.findPendingSubmitHandoffJob(pending, { chatJob, imageJob }), { kind: 'image', job: imageJob });
  assert.strictEqual(jobWorkflow.findPendingSubmitHandoffJob(pending, { chatJob, imageJob: { ...imageJob, payload: null } }), null,
    'a payload-less display/local fallback must never outrank pending-submit');
  assert.strictEqual(jobWorkflow.findPendingSubmitHandoffJob(pending, { chatJob, imageJob: { ...imageJob, submissionId: 'submit-other' } }), null,
    'a durable job from another submission must never steal ownership');

  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(app.includes('findPendingSubmitHandoffJob?.(pendingSubmit,{chatJob,imageJob})'));
  assert.ok(app.includes('if(pendingSubmit&&!handoffOwner)return void setTimeout(()=>getSubmitWorkflow().resumePendingSubmit(e),0)'),
    'pending-submit must remain authoritative unless the handoff snapshot matches its job and submission identity');
}

function testExplicitCancellationIsNotRecoverablePageLeave() {
  assert.strictEqual(jobWorkflow.shouldPreservePendingSubmitOnError(new DOMException('stopped', 'AbortError'), { pageUnloading: false }, { stopped: true }), false);
  assert.strictEqual(jobWorkflow.shouldPreservePendingSubmitOnError(new DOMException('interrupted', 'AbortError'), { pageUnloading: false }, { stopped: false }), true,
    'an unexpected abort should remain recoverable when it was not an explicit stop');
  assert.strictEqual(jobWorkflow.shouldPreservePendingSubmitOnError(new Error('leave'), { pageUnloading: true }), true);
  const commitError = new Error('snapshot commit failed');
  commitError.preservePendingSubmit = true;
  assert.strictEqual(jobWorkflow.shouldPreservePendingSubmitOnError(commitError, { pageUnloading: false }), true);

  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  assert.ok(submit.includes('isSessionBusy(state.activeSessionId)||pendingActiveSubmit'),
    'a retained pending owner must block a later submission even if a transient error cleared the in-memory busy flag');
  const stopStart = app.indexOf('async function stopActiveRun');
  const clearPending = app.indexOf('getJobWorkflow().clearPendingSubmit(e,{storage:localStorage})', stopStart);
  const firstAwait = app.indexOf('await Promise.all', stopStart);
  assert.ok(clearPending > stopStart && clearPending < firstAwait, 'explicit stop must synchronously clear pending-submit before any asynchronous managed-job abort');
}

function testImageHandoffUsesTheSameClientJobIdentity() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const image = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  assert.ok(submit.includes('jobKind:"image",stage:"handoff"') && submit.includes('clientJobId:preparedImageJobId'));
  assert.ok(image.includes('clientImageJobId=t.clientJobId||makeClientImageJobId()'));
  assert.strictEqual((image.match(/const e=clientImageJobId;/g) || []).length, 2, 'generation and edit must both reuse the durable preallocated image job id');
}

function testTerminalPreflightCommitsBeforeOwnerClear() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  assert.ok(submit.includes('await persistPendingTerminalMessages();emitTaskEvent(sessionId,taskEvents.TASK_COMPLETED_COMMITTED,{submissionId});clearPendingSubmit(sessionId)'),
    'terminal preflight and clarification responses must emit canonical completion after commit and before pending ownership is cleared');
  assert.ok(submit.includes('failure.preservePendingSubmit=!0'), 'a failed terminal commit must retain pending ownership for reload recovery');
}

function testTerminalManagedJobErrorsReleaseRecoveryOwners() {
  const terminal = jobWorkflow.makeTerminalJobError('upstream rejected');
  assert.strictEqual(terminal.name, 'JobTerminalError');
  assert.strictEqual(terminal.terminalJob, true);

  const chat = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  const image = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  const resume = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  assert.ok(chat.includes('if(e?.terminalJob){f&&clearChatJob(i);throw e}'), 'terminal chat failures must not leave an auto-resuming failed job');
  assert.ok(image.includes('catch(e){if(e?.terminalJob)clearImageJob(n);throw e}'), 'terminal image failures must not leave an auto-resuming failed job');
  assert.ok(resume.includes('(isMissingJobError(t)||t?.terminalJob)&&clearImageJob(e)'));
  assert.ok(resume.includes('(isMissingJobError(t)||t?.terminalJob)&&clearChatJob(e)'));
  assert.ok(resume.includes('n=completedJobData(t)') && resume.includes('n=completedJobData(e)'),
    'polling an already failed image job must classify it as terminal instead of trying to restart the same failed id forever');
}

function testImageCompletionCommitsBeforeClearingRecoveryOwner() {
  const image = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  const resume = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  assert.ok(image.includes('await saveSessionMessages(n,i.messages||[]);clearImageJob(n)'),
    'normal image completion must durably commit reconciliation before clearing its job');
  assert.ok(resume.includes('completedSession&&await saveSessionMessages(e,completedSession.messages||[]);clearImageJob(e)'),
    'resumed image completion must durably commit reconciliation before clearing its job');
}

module.exports = [
  testAcceptedOwnerMarksBusyBeforeAttachmentCaptureAndStopsCleanly,
  testAttachmentCaptureFailureUsesUnifiedLifecycleCleanup,
  testAcceptedSubmissionIsDurableBeforeCanonicalUserCommit,
  testAttachmentOnlySubmissionRemainsRecoverable,
  testDisposedSessionCannotRecreatePendingOwner,
  testJobSnapshotMustRetainPayloadBeforeHandoff,
  testPendingOwnerYieldsOnlyToItsMatchingDurableHandoff,
  testExplicitCancellationIsNotRecoverablePageLeave,
  testImageHandoffUsesTheSameClientJobIdentity,
  testTerminalPreflightCommitsBeforeOwnerClear,
  testTerminalManagedJobErrorsReleaseRecoveryOwners,
  testImageCompletionCommitsBeforeClearingRecoveryOwner,
];
