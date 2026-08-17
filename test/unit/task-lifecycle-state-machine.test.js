'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jobWorkflow = require('../../client/app/job-workflow');
const sessionPersistence = require('../../client/app/session-persistence');
const submitWorkflow = require('../../client/app/submit-workflow');
const taskState = require('../../client/core/task-state');
const { makeExecutionFixture, makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

function makeFinalExecutionJob({ id = 'chatjob-a', submissionId = 'submit-a' } = {}) {
  return {
    id,
    api: 'chat',
    requestPurpose: 'final_execution',
    submissionId,
    payload: { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hello' }] },
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'hello' }),
    bindingEvidence: [],
  };
}

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

function testJobSnapshotMustRetainFinalExecutionContractBeforeHandoff() {
  const storage = makeStorage();
  const durableJob = makeFinalExecutionJob();
  const full = sessionPersistence.safeSetJobStorage('chat:session-a', durableJob, { storage });
  assert.strictEqual(jobWorkflow.isRecoverableJobSnapshot(full, { id: 'chatjob-a', submissionId: 'submit-a' }), true);
  assert.strictEqual(jobWorkflow.isRecoverableJobSnapshot({
    ...durableJob,
    dispatchContract: undefined,
  }, { id: 'chatjob-a', submissionId: 'submit-a' }), false,
  'a payload alone cannot authorize final_execution recovery');
}

function testQuotaFallbackNeverReplacesARecoverableExecutionContract() {
  const key = 'image:quoted-edit';
  const fixture = makeExecutionFixture({
    operation: 'edit_image',
    prompt: '将引用图片改成蓝色',
    resources: [{ type: 'image', role: 'target', source: 'quoted', id: 'quoted-image', reference_id: 'quoted-ref' }],
  });
  const durableJob = {
    id: 'imgjob-quoted-edit',
    prompt: '将引用图片改成蓝色',
    mode: 'edit_image',
    requestPurpose: 'final_execution',
    submissionId: 'submit-quoted-edit',
    payload: { model: 'image-model', prompt: '将引用图片改成蓝色' },
    dispatchContract: fixture.dispatchContract,
    bindingEvidence: require('../../shared/dispatch-contract').bindingEvidenceFromMedia(fixture.executionResources),
  };
  const storage = makeStorage({ [key]: JSON.stringify(durableJob) });
  storage.setItem = (storedKey, value) => {
    const candidate = JSON.parse(value);
    if (candidate.dispatchContract) {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    storage.data.set(storedKey, String(value));
  };

  const saved = sessionPersistence.safeSetJobStorage(key, durableJob, { storage });
  assert.strictEqual(saved, null,
    'quota fallback must fail the update instead of storing a payload-less job shell');
  const retained = JSON.parse(storage.getItem(key));
  assert.strictEqual(jobWorkflow.isRecoverableJobSnapshot(retained, {
    id: durableJob.id, submissionId: durableJob.submissionId,
  }), true, 'the last valid quoted-image edit owner must remain resumable');
}

function testUndeliveredPendingSubmitIsPresentedAndClearedWithoutReplay() {
  const storage = makeStorage();
  const previousStorage = global.localStorage;
  global.localStorage = storage;
  const session = {
    id: 'session-a',
    messages: [{ role: 'user', content: 'draw two portraits' }],
    display: [{ id: 'pending-submit-submit-a', role: 'assistant', rawText: '正在识别任务…', pending: true, responseIndex: '1' }],
  };
  const state = { sessions: [session], activeSessionId: session.id };
  const updates = [];
  const toasts = [];
  try {
    jobWorkflow.savePendingSubmit(session.id, {
      submissionId: 'submit-a', stage: 'routing', rawPromptText: 'draw two portraits', responseIndex: 1,
    }, { storage });
    const workflow = submitWorkflow.createSubmitWorkflow({
      state,
      updateSessionDisplayItem: (_sessionId, item, role, content, options) => {
        updates.push({ item, role, content, options });
        item.role = role;
        item.rawText = options.rawText;
        item.pending = options.pending;
      },
      persistSessionDisplay: () => {},
      findMessageNodeByDisplayItem: () => null,
      updateMessage: () => { throw new Error('a detached pending display must not require DOM access'); },
      toast: message => toasts.push(message),
      getEffectiveRoute: () => { throw new Error('undelivered recovery must not replay routing'); },
    });

    const discarded = workflow.discardUndeliveredPendingSubmit(session.id);
    assert.strictEqual(discarded.submissionId, 'submit-a');
    assert.strictEqual(jobWorkflow.loadPendingSubmit(session.id, { storage }), null,
      'a request without a server-owned job must be removed before the UI is made available again');
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].options.pending, false);
    assert.match(updates[0].content, /停止自动重放/);
    assert.strictEqual(session.display[0].pending, false,
      'the page must replace the stale “recovering” indicator with an explicit manual-retry message');
    assert.deepStrictEqual(toasts, [updates[0].content]);
  } finally {
    if (previousStorage === undefined) delete global.localStorage;
    else global.localStorage = previousStorage;
  }
}

function testPendingOwnerYieldsOnlyToItsMatchingDurableHandoff() {
  const pending = {
    stage: 'handoff',
    jobKind: 'image',
    jobId: 'imgjob-a',
    submissionId: 'submit-a',
    rawPromptText: 'draw',
  };
  const imageJob = {
    id: 'imgjob-a', submissionId: 'submit-a', requestPurpose: 'final_execution',
    payload: { model: 'image-model', prompt: 'draw' },
    dispatchContract: makeDispatchContract({ operation: 'text_to_image', prompt: 'draw' }), bindingEvidence: [],
  };
  const chatJob = makeFinalExecutionJob({ id: 'chatjob-old', submissionId: 'submit-old' });
  assert.deepStrictEqual(jobWorkflow.findPendingSubmitHandoffJob(pending, { chatJob, imageJob }), { kind: 'image', job: imageJob });
  assert.strictEqual(jobWorkflow.findPendingSubmitHandoffJob(pending, { chatJob, imageJob: { ...imageJob, payload: null } }), null,
    'a payload-less display/local fallback must never outrank pending-submit');
  assert.strictEqual(jobWorkflow.findPendingSubmitHandoffJob(pending, { chatJob, imageJob: { ...imageJob, submissionId: 'submit-other' } }), null,
    'a durable job from another submission must never steal ownership');

  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const resumeStart = app.indexOf('function resumeSessionJobs');
  const resumeEnd = app.indexOf('function resumeBackgroundSessionJobs', resumeStart);
  const resumeSource = app.slice(resumeStart, resumeEnd);
  assert.ok(app.includes('findPendingSubmitHandoffJob?.(pendingSubmit,{chatJob,imageJob})'));
  assert.ok(resumeSource.includes('if(pendingSubmit&&!handoffOwner){getSubmitWorkflow().discardUndeliveredPendingSubmit?.(e);return void finishSessionTask(e)}'),
    'a pending submit without a verified durable handoff must be cleared instead of replaying its uncertain route/planning request');
  assert.ok(!resumeSource.includes('resumePendingSubmit'),
    'refresh recovery must never replay a pre-handoff pending submit; only a durable chat/image/batch job may be resumed');
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
  const lifecycle = fs.readFileSync(path.join(__dirname, '../../client/app/task-lifecycle.js'), 'utf8');
  const stopStart = lifecycle.indexOf('async function stopSessionTask');
  const clearPending = lifecycle.indexOf("runCleanup('pending submission'", stopStart);
  const firstAwait = lifecycle.indexOf('await Promise.race', stopStart);
  assert.ok(clearPending > stopStart && clearPending < firstAwait, 'explicit stop must synchronously clear pending-submit before any asynchronous managed-job abort');
  assert.ok(app.includes('function stopActiveRun(e=state.activeSessionId){try{getProblemFeedbackWorkflow()?.suppressForStop?.()}catch{}return getTaskLifecycleController().stopSessionTask(e)}'),
    'the browser composition root must delegate explicit stop to the shared lifecycle controller');
}

function testImageHandoffUsesTheSameClientJobIdentity() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const image = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  assert.ok(submit.includes('jobKind:"image",stage:"handoff"') && submit.includes('clientJobId:preparedImageJobId'));
  assert.match(image, /clientImageJobId\s*=\s*prepared\.jobId\s*\|\|\s*t\.clientJobId\s*\|\|\s*makeClientImageJobId\(\)/);
  assert.strictEqual((image.match(/const e\s*=\s*clientImageJobId;/g) || []).length, 2, 'generation and edit must both reuse the durable preallocated image job id');
}

function testTerminalPreflightCommitsBeforeOwnerClear() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  assert.ok(submit.includes('await persistPendingTerminalMessages();commitTerminalEvent(taskEvents.TASK_COMPLETED_COMMITTED,{submissionId});clearPendingSubmit(sessionId)'),
    'terminal preflight and clarification responses must pass the terminal guard after commit and before pending ownership is cleared');
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
  assert.match(image, /catch\s*\(e\)\s*\{\s*if\s*\(e\?\.terminalJob\s*&&\s*!t\.skipDurableSnapshot\)\s*clearDurableImageJob\(\);\s*throw e;?\s*\}/, 'terminal image failures must not leave an auto-resuming failed job');
  assert.match(resume, /terminal\s*&&\s*\(\s*clearImageJob\(e\),\s*\(taskOutcome\s*=\s*"failed"\),\s*\(taskError\s*=\s*t\)\s*\)/);
  assert.match(resume, /terminal\s*&&\s*\(\s*clearChatJob\(e\),\s*\(taskOutcome\s*=\s*"failed"\),\s*\(taskError\s*=\s*t\)\s*\)/);
  assert.match(resume, /taskOutcome\s*\?\s*settleSessionTask\(e,\s*\{\s*\.\.\.options/,
    'terminal recovery failures must settle the canonical task before releasing transient owners');
  assert.ok((resume.match(/n\s*=\s*completedJobData\(existingJob\)/g) || []).length >= 2,
    'polling an already failed image job must classify it as terminal instead of trying to restart the same failed id forever');
}

function testImageCompletionCommitsBeforeClearingRecoveryOwner() {
  const image = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  const resume = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  const normalSave = image.indexOf('await saveSessionMessages(n, i.messages || []);');
  const clear = image.indexOf('(t.skipDurableSnapshot || clearDurableImageJob(), notifyInterfaceCompleted(), playDoneSound());', normalSave);
  assert.ok(normalSave >= 0 && clear > normalSave,
    'normal image completion must durably save its reconciled canonical message before clearing its job and publishing completion');
  assert.match(resume, /completedSession\s*&&\s*\(?await saveSessionMessages\(e,\s*completedSession\.messages\s*\|\|\s*\[\]\)\)?;\s*\(?clearImageJob\(e\)/,
    'resumed image completion must durably commit reconciliation before clearing its job');
}

module.exports = [
  testAcceptedOwnerMarksBusyBeforeAttachmentCaptureAndStopsCleanly,
  testAttachmentCaptureFailureUsesUnifiedLifecycleCleanup,
  testAcceptedSubmissionIsDurableBeforeCanonicalUserCommit,
  testAttachmentOnlySubmissionRemainsRecoverable,
  testDisposedSessionCannotRecreatePendingOwner,
  testJobSnapshotMustRetainFinalExecutionContractBeforeHandoff,
  testQuotaFallbackNeverReplacesARecoverableExecutionContract,
  testUndeliveredPendingSubmitIsPresentedAndClearedWithoutReplay,
  testPendingOwnerYieldsOnlyToItsMatchingDurableHandoff,
  testExplicitCancellationIsNotRecoverablePageLeave,
  testImageHandoffUsesTheSameClientJobIdentity,
  testTerminalPreflightCommitsBeforeOwnerClear,
  testTerminalManagedJobErrorsReleaseRecoveryOwners,
  testImageCompletionCommitsBeforeClearingRecoveryOwner,
];
