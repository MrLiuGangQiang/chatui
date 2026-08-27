'use strict';

const assert = require('assert');

const imageRouteContext = require('../../client/core/image-route-context');

function fileCandidate(index, source = 'history', overrides = {}) {
  return {
    index,
    source,
    file_id: `${source}-file-${index}`,
    name: `document-${index}-${'x'.repeat(120)}.pdf`,
    type: 'application/pdf',
    has_extracted_text: true,
    unsupported_reason: 'reason '.repeat(40),
    ...overrides,
  };
}

function testRouteContextPrunesOldestHistoricalFilesWithinBudget() {
  const maxChars = 12000;
  const context = {
    recent_messages: Array.from({ length: 30 }, (_, index) => ({
      index: index + 1,
      role: 'user',
      content: 'old message '.repeat(80),
    })),
    image_candidates: [],
    file_candidates: Array.from({ length: 500 }, (_, index) => fileCandidate(index + 1)),
    recent_image_references: [],
    recent_uploaded_image_references: [],
  };

  const trimmed = imageRouteContext.trimRouteContextToSize(context, maxChars);

  assert.ok(
    imageRouteContext.routeContextSize(trimmed) <= maxChars,
    `route context must stay within ${maxChars} chars, got ${imageRouteContext.routeContextSize(trimmed)}`,
  );
  assert.ok(trimmed.file_candidates.length < context.file_candidates.length, 'old historical file candidates must be pruned');
  assert.strictEqual(trimmed.file_candidates[0].file_id, 'history-file-1', 'newest historical file must be retained');
  assert.ok(!trimmed.file_candidates.some(candidate => candidate.file_id === 'history-file-500'), 'oldest historical file should be dropped first');
  assert.strictEqual(context.file_candidates.length, 500, 'trimming must not mutate the caller context');
}

function testRouteContextPreservesCurrentAndQuotedFilesWhenPruningHistory() {
  const context = {
    recent_messages: [],
    image_candidates: [],
    file_candidates: [
      fileCandidate(1, 'current', { file_id: 'current-file', name: 'current-plan.pdf', text: 'current body '.repeat(1000) }),
      ...Array.from({ length: 200 }, (_, index) => fileCandidate(index + 2)),
      fileCandidate(999, 'quoted', { file_id: 'quoted-file', name: 'quoted-contract.pdf', fileData: 'quoted payload '.repeat(1000) }),
    ],
    recent_image_references: [],
    recent_uploaded_image_references: [],
  };

  const trimmed = imageRouteContext.trimRouteContextToSize(context, 1600);
  const ids = new Set(trimmed.file_candidates.map(candidate => candidate.file_id));

  assert.ok(imageRouteContext.routeContextSize(trimmed) <= 1600);
  assert.ok(ids.has('current-file'), 'current files must never be removed by history pruning');
  assert.ok(ids.has('quoted-file'), 'quoted files must never be removed by history pruning');
  assert.ok(trimmed.file_candidates.every(candidate => !Object.hasOwn(candidate, 'text') && !Object.hasOwn(candidate, 'fileData')));
  assert.ok(trimmed.file_candidates.every(candidate => candidate.name.length <= 240));
  assert.ok(trimmed.file_candidates.every(candidate => candidate.unsupported_reason.length <= 240));
}


function testBuildRouteContextKeepsAllMessagesThatFitTheConfiguredWindow() {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    id: `message-${index + 1}`,
    content: `short message ${index + 1} ${'x'.repeat(300)}`,
  }));
  const context = imageRouteContext.buildRouteContext({ messages, maxChars: 256 * 1024 });
  assert.strictEqual(context.recent_messages.length, 40, 'all messages that fit the configured window must be retained');
  assert.strictEqual(context.recent_messages[context.recent_messages.length - 1].index, 40, 'the latest message keeps its original index');
  assert.strictEqual(context.recent_messages[0].index, 1, 'the earliest message remains when the window has room');
  const recentStart = Math.max(0, context.recent_messages.length - 6);
  assert.ok(context.recent_messages.slice(0, recentStart).every(message => message.content.length <= 240),
    'older route message contents must stay short for intent recognition');
  assert.ok(context.recent_messages.slice(recentStart).every(message => message.content.length <= 800),
    'the most recent route messages may carry more context for understanding the current topic');
}

function testBuildRouteContextBoundsHistoricalFileCatalog() {
  const maxChars = 12000;
  const messages = Array.from({ length: 300 }, (_, index) => ({
    role: 'user',
    content: `上传第 ${index + 1} 个文件`,
    attachmentContext: JSON.stringify({
      attachments: [{
        id: `persisted-file-${index + 1}`,
        name: `historical-${index + 1}-${'n'.repeat(120)}.pdf`,
        type: 'application/pdf',
        size: 2048,
        text: 'extracted text',
      }],
    }),
  }));

  const context = imageRouteContext.buildRouteContext({ messages, maxChars });

  assert.ok(imageRouteContext.routeContextSize(context) <= maxChars);
  assert.strictEqual(context.file_candidates[0].file_id, 'persisted-file-300', 'the newest historical file remains first');
  assert.ok(context.file_candidates.length < messages.length, 'the route context must not expose every historical file indefinitely');
  assert.ok(!context.file_candidates.some(candidate => candidate.file_id === 'persisted-file-1'));
}

module.exports = [
  testRouteContextPrunesOldestHistoricalFilesWithinBudget,
  testRouteContextPreservesCurrentAndQuotedFilesWhenPruningHistory,
  testBuildRouteContextBoundsHistoricalFileCatalog,
  testBuildRouteContextKeepsAllMessagesThatFitTheConfiguredWindow,
];
