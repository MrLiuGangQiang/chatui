'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const attachmentsWorkflow = require('../../client/app/attachments-workflow');
const mediaWorkflow = require('../../client/app/media-workflow');
const sessionResources = require('../../client/app/session-resources');
const sessionUiWorkflow = require('../../client/app/session-ui-workflow');

class DeferredFileReader {
  static latest = null;

  readAsArrayBuffer() {
    DeferredFileReader.latest = this;
  }

  completeText(text) {
    this.result = new TextEncoder().encode(text).buffer;
    this.onload?.();
  }
}

function createAttachmentHarness() {
  DeferredFileReader.latest = null;
  const state = {
    sessions: [{ id: 'session-a' }, { id: 'session-b' }],
    activeSessionId: 'session-a',
    attachments: [],
    uploadTasks: [],
    attachmentDrafts: new Map([['session-a', []], ['session-b', []]]),
    attachmentDraftVersions: new Map(),
    uploadTaskDrafts: new Map([['session-a', []], ['session-b', []]]),
    uploadTaskSessionIds: new Map(),
    uploadProgressTimers: new Map(),
    disposedSessionIds: new Set(),
  };
  const workflow = attachmentsWorkflow.createAttachmentsWorkflow({
    getState: () => state,
    getElement: () => null,
    FileReader: DeferredFileReader,
    isImageFile: () => false,
    isCompressibleRasterImage: () => false,
    autoResize() {},
    updateSendAvailability() {},
    toast() {},
  });
  return { state, workflow };
}

async function testUploadCompletionStaysWithItsOriginatingSession() {
  const { state, workflow } = createAttachmentHarness();
  const upload = workflow.addFiles([{ name: 'draft.txt', type: 'text/plain', size: 5 }]);
  assert.ok(DeferredFileReader.latest, 'upload should begin reading before a session switch');

  state.activeSessionId = 'session-b';
  state.attachments = state.attachmentDrafts.get('session-b');
  state.uploadTasks = state.uploadTaskDrafts.get('session-b');
  DeferredFileReader.latest.completeText('draft text');
  await upload;

  assert.strictEqual(state.attachments.length, 0, 'the newly active session must not display the previous session attachment');
  assert.strictEqual(state.attachmentDrafts.get('session-b').length, 0, 'a switched-to session must retain its own empty attachment draft');
  assert.strictEqual(state.attachmentDrafts.get('session-a').length, 1, 'the completed upload must return to the session that initiated it');
  assert.strictEqual(state.attachmentDrafts.get('session-a')[0].text, 'draft text');
}

async function testClearingDraftPreventsLateUploadFromReturning() {
  const { state, workflow } = createAttachmentHarness();
  const upload = workflow.addFiles([{ name: 'discard.txt', type: 'text/plain', size: 7 }]);
  assert.ok(DeferredFileReader.latest, 'upload should be in flight');

  workflow.clearAttachments();
  DeferredFileReader.latest.completeText('discard me');
  await upload;

  assert.deepStrictEqual(state.attachmentDrafts.get('session-a'), [], 'clearing a draft must invalidate an in-flight upload result');
}

function testNewSessionStartsWithAnIndependentAttachmentDraft() {
  const state = {
    sessions: [{ id: 'session-a', messages: [] }],
    activeSessionId: 'session-a',
    messages: [],
    attachments: [{ name: 'a.png', type: 'image/png' }],
    attachmentDrafts: new Map([['session-a', [{ name: 'a.png', type: 'image/png' }]]]),
    uploadTasks: [],
    uploadTaskDrafts: new Map([['session-a', []]]),
    promptDrafts: new Map(),
    activeOutputSessions: new Map(),
  };
  const saveActiveAttachmentDraft = () => {
    state.attachmentDrafts.set(state.activeSessionId, state.attachments);
    state.uploadTaskDrafts.set(state.activeSessionId, state.uploadTasks);
  };
  const restoreAttachmentDraft = sessionId => {
    if (!state.attachmentDrafts.has(sessionId)) state.attachmentDrafts.set(sessionId, []);
    if (!state.uploadTaskDrafts.has(sessionId)) state.uploadTaskDrafts.set(sessionId, []);
    state.attachments = state.attachmentDrafts.get(sessionId);
    state.uploadTasks = state.uploadTaskDrafts.get(sessionId);
  };
  const workflow = sessionUiWorkflow.createSessionUiWorkflow({
    getState: () => state,
    getElement: () => null,
    createSession: () => ({ id: 'session-b', messages: [] }),
    saveActivePromptDraft() {}, restorePromptDraft() {}, saveActiveAttachmentDraft, restoreAttachmentDraft,
    saveSessionsMeta() {}, saveChatHistory() {}, saveDisplayHistory() {}, loadReasoningPreference() {}, renderActiveSession() {}, updateResumeStreamButton() {}, updateSendAvailability() {}, closeSessionDrawer() {},
  });

  workflow.newSession();

  assert.strictEqual(state.activeSessionId, 'session-b');
  assert.deepStrictEqual(state.attachmentDrafts.get('session-a'), [{ name: 'a.png', type: 'image/png' }], 'creating a session must retain the previous session draft');
  assert.deepStrictEqual(state.attachments, [], 'a new session must not inherit attachments from the previous session');
}

function collectIndexedDbKeys(value, target) {
  if (typeof value === 'string') {
    if (value.startsWith('indexeddb://')) target.add(value.slice('indexeddb://'.length));
    return target;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectIndexedDbKeys(item, target));
    return target;
  }
  if (value && typeof value === 'object') Object.values(value).forEach(item => collectIndexedDbKeys(item, target));
  return target;
}

function testDraftAttachmentsParticipateInMediaLifecycle() {
  const state = {
    sessions: [{ id: 'session-a' }, { id: 'session-b' }],
    activeSessionId: 'session-b',
    attachments: [],
    attachmentDrafts: new Map([
      ['session-a', [{ dataUrl: 'indexeddb://draft-a-image' }]],
      ['session-b', []],
    ]),
    activeRuns: new Map(),
    liveRuns: new Map(),
  };
  const workflow = mediaWorkflow.createMediaWorkflow({
    IMAGE_DB: 'test-db',
    IMAGE_STORE: 'images',
    state,
    localStorage: { getItem: () => null },
    sessionImageJobKey: id => `image:${id}`,
    sessionChatJobKey: id => `chat:${id}`,
    pendingSubmitKey: id => `pending:${id}`,
    URL: { revokeObjectURL() {} },
    imageStoreHelpers: {
      createImageStore: () => ({ openImageDb: async () => null, putImageBlob: async () => {}, getImageBlob: async () => null, clearImageDb: async () => {}, deleteImageDbKeys: async () => {}, getImageDbKeys: async () => [] }),
      collectIndexedDbKeys,
    },
  });

  assert.deepStrictEqual(workflow.collectSessionImageKeys({ id: 'session-a' }), ['draft-a-image'], 'inactive-session attachment drafts must be retained by media cleanup');
}

async function testDeletingSessionReleasesAttachmentDraftRuntimeState() {
  let clearedTimer = null;
  const state = {
    attachmentDrafts: new Map([['session-a', [{ dataUrl: 'indexeddb://draft-a-image' }]]]),
    attachmentDraftVersions: new Map([['session-a', 3]]),
    uploadTaskDrafts: new Map([['session-a', [{ id: 'task-a' }]]]),
    uploadTaskSessionIds: new Map([['task-a', 'session-a']]),
    uploadProgressTimers: new Map([['session-a', 42]]),
    activeRuns: new Map(), liveRuns: new Map(), busySessions: new Set(), activeOutputSessions: new Map(), taskStates: new Map(), stoppedSessions: new Map(), promptDrafts: new Map(), resumingJobs: new Set(), followingChatJobs: new Set(), followingImageJobs: new Set(), disposedSessionIds: new Set(),
  };
  const lifecycle = sessionResources.createSessionResourceLifecycle({
    getState: () => state,
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, removeItem() {} },
    collectSessionImageKeys: () => [],
    collectAllSessionImageKeys: () => new Set(),
    deleteImageDbKeys: async () => {},
    deleteOrphanImageBlobs: async () => {},
    deleteSessionSnapshot: async () => {},
    disposeManagedJob: async () => {},
    sessionStorageKey: () => '', sessionChatJobKey: () => '', sessionImageJobKey: () => '',
  });
  const originalClearTimeout = global.clearTimeout;
  global.clearTimeout = timer => { clearedTimer = timer; };
  try {
    await lifecycle.disposeSessions([{ id: 'session-a' }], []);
  } finally {
    global.clearTimeout = originalClearTimeout;
  }

  assert.strictEqual(state.attachmentDrafts.has('session-a'), false);
  assert.strictEqual(state.uploadTaskDrafts.has('session-a'), false);
  assert.strictEqual(state.uploadTaskSessionIds.has('task-a'), false);
  assert.strictEqual(clearedTimer, 42, 'deleting a session must cancel its deferred upload-progress cleanup');
}

function testRootSwitchRestoresAttachmentsBeforeRenderingTheNextSession() {
  const app = fs.readFileSync(path.join(__dirname, '../..', 'app.js'), 'utf8');
  assert.ok(app.includes('saveActivePromptDraft(),saveActiveAttachmentDraft();'), 'switching sessions must save the active attachment draft alongside the prompt draft');
  assert.ok(app.includes('loadReasoningPreference(),restoreAttachmentDraft(e),renderActiveSession({reason:"switch-bottom"})'), 'the next session attachment draft must be restored before its UI renders');
}

module.exports = [
  testUploadCompletionStaysWithItsOriginatingSession,
  testClearingDraftPreventsLateUploadFromReturning,
  testNewSessionStartsWithAnIndependentAttachmentDraft,
  testDraftAttachmentsParticipateInMediaLifecycle,
  testDeletingSessionReleasesAttachmentDraftRuntimeState,
  testRootSwitchRestoresAttachmentsBeforeRenderingTheNextSession,
];
