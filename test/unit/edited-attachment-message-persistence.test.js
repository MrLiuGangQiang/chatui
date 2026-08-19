'use strict';

const assert = require('assert');
const messageRecords = require('../../client/app/message-records');

function attachmentContext(prompt, attachments = [{ id: 'a1', name: 'a.png', type: 'image/png', src: 'indexeddb://a1' }]) {
  return JSON.stringify({ prompt, content: prompt, attachments });
}

function testRefreshAttachmentContextForEditUpdatesPromptAndContent() {
  const refreshed = messageRecords.refreshAttachmentContextForEdit(
    attachmentContext('旧提示'),
    '新提示'
  );
  const parsed = JSON.parse(refreshed);
  assert.strictEqual(parsed.prompt, '新提示');
  assert.strictEqual(parsed.content, '新提示');
  assert.strictEqual(parsed.attachments.length, 1, 'attachments must be preserved');
}

function testRefreshAttachmentContextForEditReturnsOriginalForInvalidInput() {
  assert.strictEqual(messageRecords.refreshAttachmentContextForEdit('', '新提示'), '');
  assert.strictEqual(messageRecords.refreshAttachmentContextForEdit('not-json', '新提示'), 'not-json');
  assert.strictEqual(messageRecords.refreshAttachmentContextForEdit(JSON.stringify('str'), '新提示'), JSON.stringify('str'));
}

function testEditedAttachmentCanonicalPresentationUsesNewPrompt() {
  const refreshed = messageRecords.refreshAttachmentContextForEdit(
    attachmentContext('旧提示'),
    '新提示'
  );
  const canonical = messageRecords.normalizeCanonicalMessage({
    role: 'user',
    content: '新提示',
    rawText: '新提示',
    attachmentContext: refreshed,
  }, { sessionId: 'edit-session', sequence: 0 });
  assert.strictEqual(canonical.presentation.displayText, '新提示');
}

function testStaleAttachmentContextStillShowsOldPrompt() {
  // Documents the exact failure mode this fix prevents: if the persisted
  // attachmentContext prompt is not refreshed on edit, the canonical
  // presentation falls back to the stale prompt after reload.
  const canonical = messageRecords.normalizeCanonicalMessage({
    role: 'user',
    content: '新提示',
    rawText: '新提示',
    attachmentContext: attachmentContext('旧提示'),
  }, { sessionId: 'edit-session', sequence: 0 });
  assert.strictEqual(canonical.presentation.displayText, '旧提示');
}

module.exports = [
  testRefreshAttachmentContextForEditUpdatesPromptAndContent,
  testRefreshAttachmentContextForEditReturnsOriginalForInvalidInput,
  testEditedAttachmentCanonicalPresentationUsesNewPrompt,
  testStaleAttachmentContextStillShowsOldPrompt,
];