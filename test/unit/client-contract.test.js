const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routeService = require('../../client/services/route-service');
const chatService = require('../../client/services/chat-service');
const jobService = require('../../client/services/job-service');
const attachmentsCore = require('../../client/core/attachments');

function testClientContractUsesOneTaskContractRouteProtocol() {
  for (const key of [
    'ROUTE_SYSTEM_PROMPT',
    'INTENT_REVIEW_SYSTEM_PROMPT',
    'isTaskContractResult',
    'parseRouteResult',
    'buildRoutePayload',
    'buildIntentReviewPayload',
  ]) {
    assert.ok(key in routeService, `missing canonical route export: ${key}`);
  }
  assert.ok(!('apiRouteToExecutionRoute' in routeService));
  assert.ok(!('taskContractForRoute' in routeService));
  assert.ok(!('reconcileMultiImageCompositionContract' in routeService), 'valid model contracts must not be overridden by local keyword routing');
  assert.ok(!('semanticallySelectedCompositionCandidates' in routeService), 'image candidate matching belongs to the model contract, not a local fallback');
}

function testClientContractRoutePayloadKeepsCompactShape() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '总结这个文件',
    attachments: [{ id: 'file-1', name: 'a.txt', type: 'text/plain', size: 12, is_image: false, has_extracted_text: true }],
    context: {
      recent_messages: [{ role: 'user', content: '旧消息' }],
      image_candidates: [],
      file_candidates: [{ index: 1, source: 'history', file_id: 'old', name: 'old.txt' }],
      ignored_empty: [],
    },
    currentMode: 'chat',
    autoMode: true,
  });
  assert.strictEqual(payload.model, 'route-model');
  assert.strictEqual(payload.temperature, 0);
  assert.strictEqual(payload.messages.length, 2);
  assert.strictEqual(payload.messages[0].role, 'system');
  assert.strictEqual(payload.messages[1].role, 'user');
  const user = JSON.parse(payload.messages[1].content);
  assert.strictEqual(user.current_input, '总结这个文件');
  assert.ok(Array.isArray(user.attachments));
  assert.ok(Array.isArray(user.context.file_candidates));
  assert.ok(!('ignored_empty' in user.context));
  assert.ok(payload.messages[0].content.includes('attachments.media_index'), 'the model must receive the type-local attachment index rule');
  assert.ok(payload.messages[0].content.length < 4000, 'the route prompt must remain within its compact context budget');
  assert.ok(!/(reasoning|thinking|reasoning_effort|enable_thinking)/i.test(JSON.stringify(payload)));
}

function testClientContractAttachmentMetadataUsesTypedMediaIndexes() {
  const metadata = attachmentsCore.buildRouteAttachmentMetadata([
    { id: 'img-1', name: 'first.png', type: 'image/png' },
    { id: 'file-1', name: 'first.pdf', type: 'application/pdf' },
    { id: 'img-2', name: 'second.png', type: 'image/png' },
    { id: 'file-2', name: 'second.pdf', type: 'application/pdf' },
  ]);
  assert.deepStrictEqual(metadata.map(item => [item.index, item.source_index, item.media_index]), [[1, 1, 1], [2, 2, 1], [3, 3, 2], [4, 4, 2]]);

  const payload = routeService.buildRoutePayload({ model: 'route-model', input: 'compare the image and files', attachments: metadata, context: {} });
  const user = JSON.parse(payload.messages[1].content);
  assert.deepStrictEqual(user.context.file_candidates.map(item => [item.index, item.source_index]), [[1, 2], [2, 4]], 'file candidates must retain their typed index and original attachment position');

  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(app.includes('window.ChatUICore?.attachments?.buildRouteAttachmentMetadata'), 'the root entry must delegate attachment metadata to the canonical core implementation');
  assert.ok(!app.includes('media_index:i'), 'the root entry must not retain a second attachment-metadata implementation');
}

function testClientContractRouteParsingPreservesClarificationShape() {
  const question = 'Please specify which image to edit.';
  const parsed = routeService.parseRouteResult(JSON.stringify({
    schema_version: 'task_contract.v3',
    operation: 'clarify',
    relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'context', role: 'target', index: 1, id: '', reference_id: '', missing: true }],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question, missing_resource_keys: ['r1'] },
    confidence: 0.7,
    review_reasons: [],
    rationale: 'multiple candidates',
  }), { input: 'edit this image', attachments: [], context: {} });
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.needClarification, true);
  assert.strictEqual(parsed.clarificationQuestion, question);
  assert.strictEqual(parsed.taskContract.operation, 'clarify');
  assert.strictEqual(parsed.operationType, 'clarify');
}

function testClientContractRejectsRedundantOrUnknownFields() {
  const invalid = {
    schema_version: 'task_contract.v3',
    operation: 'plain_chat',
    relation: 'new',
    resources: [],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', missing_resource_keys: [] },
    confidence: 0.9,
    review_reasons: [],
    rationale: 'chat',
    intent: 'chat',
  };
  assert.strictEqual(routeService.isTaskContractResult(invalid), false);
  assert.strictEqual(routeService.parseRouteResult(JSON.stringify(invalid), { input: 'hello' }), null);
}

function taskContract({ operation, relation = 'new', resources = [], directive, confidence = 0.9, reviewReasons = [] } = {}) {
  return {
    schema_version: 'task_contract.v3',
    operation,
    relation,
    resources,
    directive: directive || { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', missing_resource_keys: [] },
    confidence,
    review_reasons: reviewReasons,
    rationale: 'contract validation test',
  };
}

function testClientContractBindsMediaResourcesToExactCandidates() {
  const edit = taskContract({
    operation: 'edit_image',
    relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'history', role: 'target', index: 1, id: 'img-cat', reference_id: 'imgref-cat', missing: false }],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [{ op: 'replace', target: 'background', value: 'blue' }], constraints: [] },
  });
  const context = {
    image_candidates: [{ index: 1, source_index: 3, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat', target: 'previous' }],
  };
  const parsed = routeService.parseRouteResult(JSON.stringify(edit), { input: 'make the background blue', context });
  assert.ok(parsed, 'a resource that exactly identifies one candidate should be executable');
  assert.deepStrictEqual(parsed.selectedIndexes, [3]);
  assert.deepStrictEqual(parsed.selectedImageIds, ['img-cat']);
  assert.strictEqual(parsed.target, 'previous');

  const wrongId = structuredClone(edit);
  wrongId.resources[0].id = 'img-not-cat';
  assert.strictEqual(routeService.parseRouteResult(JSON.stringify(wrongId), { input: 'make the background blue', context }), null, 'an unknown image id must not be converted into an executable edit');

  const wrongSource = structuredClone(edit);
  wrongSource.resources[0].source = 'current';
  assert.strictEqual(routeService.parseRouteResult(JSON.stringify(wrongSource), { input: 'make the background blue', context }), null, 'a resource must not bind an historical candidate while claiming it is current');
}

function testClientContractEnforcesOperationSpecificResourcesAndTypedIndexes() {
  const incompleteCompare = taskContract({
    operation: 'image_compare',
    resources: [{ key: 'r1', type: 'image', source: 'current', role: 'compare_a', index: 1, id: 'img-a', reference_id: '', missing: false }],
  });
  assert.strictEqual(routeService.isTaskContractResult(incompleteCompare), false, 'an image comparison requires exactly two explicitly assigned images');

  const multimodal = taskContract({
    operation: 'multimodal_qa',
    resources: [
      { key: 'r1', type: 'image', source: 'current', role: 'source', index: 1, id: 'img-current', reference_id: '', missing: false },
      { key: 'r2', type: 'file', source: 'current', role: 'attachment', index: 1, id: 'file-current', reference_id: '', missing: false },
    ],
  });
  const parsed = routeService.parseRouteResult(JSON.stringify(multimodal), {
    input: 'read the image and the document together',
    context: {
      image_candidates: [{ index: 1, source_index: 4, source: 'current', image_id: 'img-current', reference_id: '', target: 'uploaded' }],
      file_candidates: [{ index: 1, source_index: 7, source: 'current', file_id: 'file-current', target: 'uploaded' }],
    },
  });
  assert.ok(parsed);
  assert.deepStrictEqual(parsed.selectedIndexes, [4], 'legacy image selection must never receive file indexes');
  assert.deepStrictEqual(parsed.selectedImageIndexes, [4]);
  assert.deepStrictEqual(parsed.selectedFileIndexes, [7]);

  const fileWithReferenceId = structuredClone(multimodal);
  fileWithReferenceId.resources[1].reference_id = 'file-current';
  assert.strictEqual(routeService.isTaskContractResult(fileWithReferenceId), false, 'file resources must not invent an image-style reference id');

  const clarifyWithPatch = {
    schema_version: 'task_contract.v3', operation: 'clarify', relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'history', role: 'target', index: 1, id: '', reference_id: '', missing: true }],
    directive: { mode: 'patch', base_resource_keys: [], unmentioned_policy: 'preserve', operations: [], constraints: [] },
    clarification: { question: 'Which image should I edit?', missing_resource_keys: ['r1'] },
    confidence: 0.5, review_reasons: ['image selection is ambiguous'], rationale: 'two candidates match',
  };
  assert.strictEqual(routeService.isTaskContractResult(clarifyWithPatch), false, 'clarification must use a standalone, non-executing directive');
}

function testClientContractServiceExportsStayStable() {
  for (const key of ['extractChatJobText', 'requestJson', 'parseSseLine']) {
    assert.strictEqual(typeof chatService[key], 'function', `missing chatService export: ${key}`);
  }
  for (const key of ['makeClientJobId', 'makeClientImageJobId', 'makeClientChatJobId', 'startChatJob', 'registerChatStreamJob', 'getJob', 'abortManagedJob', 'waitJobEvent', 'startImageGenerationJob']) {
    assert.strictEqual(typeof jobService[key], 'function', `missing jobService export: ${key}`);
  }
  assert.match(jobService.makeClientChatJobId(), /^chatjob-[a-z0-9]+-[a-z0-9]+$/);
  assert.match(jobService.makeClientImageJobId(), /^imgjob-[a-z0-9]+-[a-z0-9]+$/);
}

function testClientContractChatAndSseParsingShape() {
  assert.deepStrictEqual(chatService.extractChatJobText({ choices: [{ message: { content: '答复', reasoning_content: '推理' } }], metrics: { firstTokenMs: 12, durationMs: 34 } }), {
    content: '答复',
    reasoning: '推理',
    firstTokenMs: 12,
    durationMs: 34,
  });
  assert.deepStrictEqual(chatService.parseSseLine('data: [DONE]', value => value), { done: true });
  assert.deepStrictEqual(chatService.parseSseLine('data: {"delta":"abc"}', value => value.delta), { done: false, delta: 'abc' });
  assert.strictEqual(chatService.parseSseLine(': keepalive', value => value), null);
}

module.exports = [
  testClientContractUsesOneTaskContractRouteProtocol,
  testClientContractRoutePayloadKeepsCompactShape,
  testClientContractAttachmentMetadataUsesTypedMediaIndexes,
  testClientContractRouteParsingPreservesClarificationShape,
  testClientContractRejectsRedundantOrUnknownFields,
  testClientContractBindsMediaResourcesToExactCandidates,
  testClientContractEnforcesOperationSpecificResourcesAndTypedIndexes,
  testClientContractServiceExportsStayStable,
  testClientContractChatAndSseParsingShape,
];
