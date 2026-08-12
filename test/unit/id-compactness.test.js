'use strict';

const assert = require('assert');

// Quality gate: every generated identifier in the product must stay compact.
// Long IDs bloat logs, URLs, wire payloads and local storage. This gate pins
// the shortened formats so a future refactor cannot silently regrow them.

function testJobIdStaysCompact() {
  const { makeJobId } = require('../../server/jobs/common');
  const id = makeJobId();
  assert.match(id, /^imgjob-[a-z0-9]{10}$/, `job id must match the compact format, got ${id}`);
  assert.ok(id.length <= 17, `job id must stay under 17 chars, got ${id} (${id.length})`);
  // Accept a caller-supplied id unchanged.
  assert.strictEqual(makeJobId('imgjob-external-12345'), 'imgjob-external-12345');
}

function testTraceIdStaysCompact() {
  const logger = require('../../server/logging/logger');
  const id = logger.traceId();
  assert.match(id, /^trace-[a-f0-9]{12}$/, `trace id must be trace + 12 hex, got ${id}`);
  assert.ok(id.length <= 18, `trace id must stay under 18 chars, got ${id} (${id.length})`);
  const second = logger.traceId();
  assert.notStrictEqual(id, second, 'trace ids must be unique');
}

function testClientJobIdsStayCompact() {
  const jobService = require('../../client/services/job-service');
  const imageId = jobService.makeClientImageJobId();
  const chatId = jobService.makeClientChatJobId();
  assert.match(imageId, /^imgjob-[a-z0-9]{10}$/, `client image job id compact, got ${imageId}`);
  assert.match(chatId, /^chatjob-[a-z0-9]{10}$/, `client chat job id compact, got ${chatId}`);
  assert.ok(imageId.length <= 17 && chatId.length <= 18, 'client job ids must stay under 17/18 chars');
}

function testDisplayItemIdStaysCompact() {
  const { makeDisplayItemId } = require('../../client/app/display-items');
  const id = makeDisplayItemId();
  assert.match(id, /^display_[a-z0-9]{10}$/, `display id must be compact, got ${id}`);
  assert.ok(id.length <= 18, `display id must stay under 18 chars, got ${id} (${id.length})`);
}

function testSubmissionIdStaysCompact() {
  const { makeSubmissionId } = require('../../client/app/job-workflow');
  const id = makeSubmissionId();
  assert.match(id, /^submit-[a-z0-9]{10}$/, `submission id must be compact, got ${id}`);
  assert.ok(id.length <= 17, `submission id must stay under 17 chars, got ${id} (${id.length})`);
}

function testGeneratedNativeIdStaysCompact() {
  const resourceIdentity = require('../../client/core/resource-identity');
  // generatedNativeId is internal; ensureResourceIdentity is the public path
  // that assigns the compact rid_ identity to a new image resource.
  const item = resourceIdentity.ensureResourceIdentity({}, 'image');
  const id = String(item.imageId || item.image_id || item.id || '');
  assert.match(id, /^rid_[a-z0-9]{16}$/, `resource identity id must be compact, got ${id}`);
  assert.ok(id.length <= 20, `resource identity id must stay under 20 chars, got ${id} (${id.length})`);
}

function testClarificationIdStaysCompact() {
  const clarification = require('../../shared/clarification-answer');
  const pending = clarification.createPendingClarification({
    messages: [{ role: 'user', content: '请选择要修改的图片' }],
    clarificationText: '选择要修改的图片',
  });
  const id = String(pending.id || '');
  assert.match(id, /^clarify_[a-z0-9]{16}$/, `clarification id must be compact, got ${id}`);
  assert.ok(id.length <= 24, `clarification id must stay under 24 chars, got ${id} (${id.length})`);
}

function testImageReferenceIdsStayCompact() {
  const imageReferences = require('../../client/core/image-references');
  const referenceId = imageReferences.makeImageReferenceId('a-prompt-that-is-very-long-'.repeat(6));
  assert.ok(referenceId.startsWith('imgref_'), 'reference id keeps the imgref_ prefix');
  assert.ok(referenceId.length <= 56, `image reference id must stay compact, got ${referenceId} (${referenceId.length})`);
  const itemId = imageReferences.makeImageItemId(referenceId, 1);
  assert.match(itemId, /^img_imgref_.+_\d+$/, 'image item id keeps the parseable shape');
  assert.ok(itemId.length <= 62, `image item id must stay compact, got ${itemId} (${itemId.length})`);
  // Parsing round-trip must keep working on the shorter ids.
  const parsed = imageReferences.parseImageItemId(itemId);
  assert.strictEqual(parsed.referenceId, referenceId);
  assert.strictEqual(parsed.index, 1);
}

function testMessageRecordImageIdsStayCompact() {
  const messageRecords = require('../../client/app/message-records');
  const canonical = messageRecords.normalizeCanonicalMessage({
    role: 'assistant',
    content: '[图片生成完成] compact',
    responseIndex: '1',
    imageContext: JSON.stringify({
      referenceId: 'imgref_latest',
      attachments: [{ imageId: 'img_imgref_latest_1', src: 'indexeddb://legacy-image', sourceIndex: 1 }],
    }),
  }, { sessionId: 'compact-session', sequence: 1 });
  const context = JSON.parse(canonical.imageContext);
  assert.ok(context.referenceId.length <= 56, `generated reference id must stay compact, got ${context.referenceId} (${context.referenceId.length})`);
  assert.ok(context.attachments[0].imageId.length <= 62, `generated image id must stay compact, got ${context.attachments[0].imageId} (${context.attachments[0].imageId.length})`);
}

function testRouteContextBudgetShrinks() {
  const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
  const previousCore = globalThis.ChatUICore;
  delete globalThis.ChatUICore;
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    displayItemId: `message-${index + 1}`,
    content: `historical message ${index + 1} ${'x'.repeat(580)}`,
  }));
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: {
      activeSessionId: 'long-session',
      mode: 'chat',
      autoMode: true,
      sessions: [],
      messages,
    },
    getConfig: () => ({ context: { windowTokens: 262144 } }),
  });
  try {
    const context = workflow.buildRouteContext('long-session');
    const serializedSize = JSON.stringify(context).length;
    assert.ok(serializedSize <= 500000, `route context must stay within 500000 chars, got ${serializedSize}`);
    assert.ok(context.recent_messages.some(message => message.id === 'message-40'), 'latest message must be retained');
    assert.ok(context.recent_messages.some(message => message.id === 'message-1'), 'oldest message must be retained within budget');
  } finally {
    if (previousCore === undefined) delete globalThis.ChatUICore;
    else globalThis.ChatUICore = previousCore;
  }
}

module.exports = [
  testJobIdStaysCompact,
  testTraceIdStaysCompact,
  testClientJobIdsStayCompact,
  testDisplayItemIdStaysCompact,
  testSubmissionIdStaysCompact,
  testGeneratedNativeIdStaysCompact,
  testClarificationIdStaysCompact,
  testImageReferenceIdsStayCompact,
  testMessageRecordImageIdsStayCompact,
  testRouteContextBudgetShrinks,
];
