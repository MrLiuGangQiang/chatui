const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routeService = require('../../client/services/route-service');
const chatService = require('../../client/services/chat-service');
const jobService = require('../../client/services/job-service');
const attachmentsCore = require('../../client/core/attachments');

function currentTextResource(key = 'r9') {
  return { key, type: 'text', source: 'current', role: 'source', index: 1, id: '', reference_id: '', missing: false };
}

function testClientContractUsesOneTaskContractRouteProtocol() {
  for (const key of [
    'ROUTE_SYSTEM_PROMPT',
    'INTENT_REVIEW_SYSTEM_PROMPT',
    'INTENT_REPAIR_SYSTEM_PROMPT',
    'ROUTE_RESPONSE_FORMAT',
    'inspectRouteResult',
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

function testRoutePromptIsOneOrderedDecisionSpecification() {
  const system = routeService.ROUTE_SYSTEM_PROMPT;
  assert.ok(system.includes('按以下顺序决策'), 'the route prompt must give the model one explicit decision order');
  for (const step of ['1. 边界', '2. 关系', '3. 操作', '4. 资源', '5. 指令', '6. 澄清与审计']) {
    assert.ok(system.includes(step), `missing route decision step: ${step}`);
  }
  assert.ok(system.includes('context.quoted_message'), 'an explicit UI quote must be part of the routing specification');
  assert.ok(!system.includes('边界示例'), 'the production prompt must not grow into a second rulebook of examples');
  assert.ok(system.length < 2400, 'the complete primary routing specification must stay cognitively compact');
  assert.ok(routeService.ROUTE_OUTPUT_CONTRACT_CHECK.length < 180, 'the final check should remain a short invariant check, not duplicate the routing rules');
  assert.ok(routeService.ROUTE_OUTPUT_CONTRACT_CHECK.includes('绝不省略'), 'the first route request must require a complete contract even when the intent is simple');
  assert.ok(routeService.ROUTE_OUTPUT_CONTRACT_CHECK.includes('constraints；空数组也输出 []'), 'the first route request must explicitly retain empty directive fields instead of relying on contract repair');
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
  assert.strictEqual(payload.response_format?.type, 'json_schema');
  assert.strictEqual(payload.response_format?.json_schema?.strict, true);
  assert.strictEqual(payload.response_format?.json_schema?.schema?.additionalProperties, false);
  assert.strictEqual(payload.messages.length, 2);
  assert.strictEqual(payload.messages[0].role, 'system');
  assert.strictEqual(payload.messages[1].role, 'user');
  const user = JSON.parse(payload.messages[1].content);
  assert.strictEqual(user.current_input, '总结这个文件');
  assert.ok(Array.isArray(user.attachments));
  assert.ok(Array.isArray(user.context.file_candidates));
  assert.ok(!('ignored_empty' in user.context));
  assert.ok(payload.messages[0].content.includes('attachments.media_index'), 'the model must receive the type-local attachment index rule');
  assert.ok(payload.messages[0].content.includes(routeService.ROUTE_OUTPUT_CONTRACT_CHECK), 'the first route request must carry the complete-contract output constraint');
  assert.ok(payload.messages[0].content.length < 4000, 'the route prompt must remain within its compact context budget');
  assert.ok(!/(reasoning|thinking|reasoning_effort|enable_thinking)/i.test(JSON.stringify(payload)));
}

function testRouteResultInspectionSeparatesShapeAndResourceFailures() {
  const malformed = routeService.inspectRouteResult('{not-json');
  assert.strictEqual(malformed.route, null);
  assert.strictEqual(malformed.reason, 'contract_semantics');

  const unknownField = routeService.inspectRouteResult(JSON.stringify({
    schema_version: 'task_contract.v3', operation: 'plain_chat', relation: 'new', resources: [],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', missing_resource_keys: [] }, confidence: 0.9, review_reasons: [], rationale: 'valid intent but invalid shape', extra: true,
  }));
  assert.strictEqual(unknownField.route, null);
  assert.strictEqual(unknownField.reason, 'contract_shape');
}

function testClientContractRoutePayloadRetainsHistoricalFilesAlongsideCurrentFiles() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: 'Compare the newly uploaded file with the prior report.',
    attachments: [{ id: 'current-file', name: 'current.txt', type: 'text/plain', size: 10, is_image: false }],
    context: {
      recent_messages: [
        { index: 1, role: 'user', content: 'Earlier report' },
        { index: 2, role: 'user', content: 'Compare the newly uploaded file with the prior report.' },
      ],
      file_candidates: [
        { index: 1, source: 'history', file_id: 'history-file', name: 'history.txt', message_index: 1 },
        { index: 2, source: 'history', file_id: 'stale-current-file', name: 'current.txt', message_index: 2 },
      ],
    },
  });
  const user = JSON.parse(payload.messages[1].content);

  assert.deepStrictEqual(user.context.file_candidates.map(item => [item.source, item.file_id]), [
    ['history', 'history-file'],
    ['current', 'current-file'],
  ], 'current attachments must augment, not erase, selectable historical file candidates');
  assert.deepStrictEqual(user.context.recent_messages.map(item => item.index), [1], 'the current input remains represented only by current_input and attachments');
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

function testExplicitQuoteCompletesOnlyAnOmittedFollowupMessageBinding() {
  const incompleteFollowup = {
    schema_version: 'task_contract.v3',
    operation: 'plain_chat',
    relation: 'followup',
    resources: [],
    directive: { mode: 'patch', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', missing_resource_keys: [] },
    confidence: 0.95,
    review_reasons: [],
    rationale: 'the user is asking about the explicitly quoted message',
  };

  assert.strictEqual(routeService.parseRouteResult(JSON.stringify(incompleteFollowup), { input: 'Can this be improved?', context: {} }), null, 'ordinary history must never be guessed as a quote binding');
  const parsed = routeService.parseRouteResult(JSON.stringify(incompleteFollowup), {
    input: 'Can this be improved?',
    context: { quoted_message: { index: 1, role: 'assistant', id: 'quoted-answer-1' } },
  });

  assert.ok(parsed, 'an explicit UI quote should make an otherwise mechanically incomplete followup executable without a retry');
  assert.deepStrictEqual(parsed.taskContract.resources, [{ key: 'r1', type: 'message', source: 'history', role: 'context', index: 1, id: 'quoted-answer-1', reference_id: '', missing: false }]);
  assert.deepStrictEqual(parsed.taskContract.directive.base_resource_keys, ['r1']);
  assert.strictEqual(parsed.taskContract.directive.unmentioned_policy, 'preserve');

  const incorrectlyStandalone = {
    ...incompleteFollowup,
    relation: 'new',
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
  };
  const normalizedStandalone = routeService.parseRouteResult(JSON.stringify(incorrectlyStandalone), {
    input: 'Can this be improved?',
    context: { quoted_message: { index: 1, role: 'assistant', id: 'quoted-answer-1' } },
  });
  assert.strictEqual(normalizedStandalone.taskContract.relation, 'followup', 'a visible explicit quote is a route fact, not optional background history');
  assert.strictEqual(normalizedStandalone.taskContract.directive.mode, 'patch');
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

function testClientContractAcceptsHistoryAliasForAnExplicitlyQuotedImageOnly() {
  const quotedImageQuestion = taskContract({
    operation: 'image_qa',
    relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'history', role: 'source', index: 1, id: 'img_imgref_latest_1', reference_id: 'imgref_latest', missing: false }],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [], constraints: [] },
  });
  const context = {
    quoted_message: { index: 1, role: 'assistant', id: 'quoted-image-message' },
    image_candidates: [{ index: 1, source_index: 1, source: 'quoted', image_id: 'img_imgref_latest_1', reference_id: 'imgref_latest', target: 'previous' }],
  };
  const parsed = routeService.parseRouteResult(JSON.stringify(quotedImageQuestion), { input: 'What breed is this?', context });
  assert.ok(parsed, 'a model may describe an explicitly quoted image as history');
  assert.deepStrictEqual(parsed.selectedImageIds, ['img_imgref_latest_1']);
  assert.strictEqual(parsed.imageRefs[0].source, 'quoted', 'execution must retain the UI quote source after resolving the alias');

  const wrongImage = structuredClone(quotedImageQuestion);
  wrongImage.resources[0].id = 'img_imgref_latest_2';
  assert.strictEqual(routeService.parseRouteResult(JSON.stringify(wrongImage), { input: 'What breed is this?', context }), null, 'the history alias must not bind a different quoted image');

  const ordinaryHistory = structuredClone(context);
  ordinaryHistory.image_candidates[0].source = 'context';
  assert.strictEqual(routeService.parseRouteResult(JSON.stringify(quotedImageQuestion), { input: 'What breed is this?', context: ordinaryHistory }), null, 'the alias must not match non-quoted resources');
}

function testClientContractAcceptsCurrentTextResourceForTextToImage() {
  const textToImage = taskContract({
    operation: 'text_to_image',
    resources: [{ key: 'r1', type: 'text', source: 'current', role: 'source', index: 1, id: '', reference_id: '', missing: false }],
  });
  const parsed = routeService.parseRouteResult(JSON.stringify(textToImage), { input: 'Generate a 16:9 presentation image.', attachments: [], context: {} });

  assert.ok(parsed, 'a current text resource must be valid for a standalone text-to-image task');
  assert.strictEqual(parsed.mode, 'image');
  assert.strictEqual(parsed.api, 'image_generation');
  assert.strictEqual(parsed.operationType, 'text_to_image');
}

function testClientContractAcceptsCurrentTextResourceForEveryExecutableOperation() {
  const currentImage = { key: 'r1', type: 'image', source: 'current', role: 'source', index: 1, id: 'img-current', reference_id: '', missing: false };
  const compareImage = { key: 'r2', type: 'image', source: 'current', role: 'compare_b', index: 2, id: 'img-compare', reference_id: '', missing: false };
  const compareBase = { ...currentImage, role: 'compare_a' };
  const currentFile = { key: 'r3', type: 'file', source: 'current', role: 'attachment', index: 1, id: 'file-current', reference_id: '', missing: false };
  const historyReference = { key: 'r4', type: 'image', source: 'history', role: 'reference', index: 1, id: 'img-history', reference_id: 'imgref-history', missing: false };
  const historyTarget = { key: 'r5', type: 'image', source: 'history', role: 'target', index: 1, id: 'img-history', reference_id: 'imgref-history', missing: false };
  const patch = (baseKey, operation) => ({ mode: 'patch', base_resource_keys: [baseKey], unmentioned_policy: 'preserve', operations: [operation], constraints: [] });
  const cases = [
    taskContract({ operation: 'plain_chat', resources: [currentTextResource()] }),
    taskContract({ operation: 'file_qa', resources: [currentFile, currentTextResource()] }),
    taskContract({ operation: 'multimodal_qa', resources: [currentImage, currentFile, currentTextResource()] }),
    taskContract({ operation: 'image_qa', resources: [currentImage, currentTextResource()] }),
    taskContract({ operation: 'ocr', resources: [currentImage, currentTextResource()] }),
    taskContract({ operation: 'image_compare', resources: [compareBase, compareImage, currentTextResource()] }),
    taskContract({ operation: 'image_reference_gen', relation: 'followup', resources: [historyReference, currentTextResource()], directive: patch('r4', { op: 'add', target: 'composition', value: 'combine the reference' }) }),
    taskContract({ operation: 'edit_image', relation: 'correction', resources: [historyTarget, currentTextResource()], directive: patch('r5', { op: 'replace', target: 'background', value: 'blue' }) }),
  ];

  for (const contract of cases) {
    assert.strictEqual(routeService.isTaskContractResult(contract), true, `${contract.operation} must accept one neutral current-text resource`);
  }
}

function testClientContractAcceptsHistoricalStyleReferenceForHtmlChat() {
  const reference = taskContract({
    operation: 'plain_chat',
    relation: 'followup',
    resources: [
      { key: 'r1', type: 'message', source: 'history', role: 'context', index: 4, id: 'message-style-source', reference_id: '', missing: false },
      { key: 'r2', type: 'image', source: 'history', role: 'style_reference', index: 1, id: 'img-reference-page', reference_id: 'imgref-reference-page', missing: false },
    ],
    directive: { mode: 'patch', base_resource_keys: ['r1', 'r2'], unmentioned_policy: 'preserve', operations: [{ op: 'replace', target: 'page visual style', value: 'reference image visual style' }], constraints: ['do not embed the image'] },
  });
  const parsed = routeService.parseRouteResult(JSON.stringify(reference), {
    input: 'Restyle the previous webpage to match the reference image without embedding it.',
    context: {
      recent_messages: [{ index: 4, id: 'message-style-source', role: 'assistant', content: 'The earlier webpage implementation.' }],
      image_candidates: [{ index: 1, source_index: 1, source: 'history', image_id: 'img-reference-page', reference_id: 'imgref-reference-page', target: 'previous' }],
    },
  });

  assert.ok(parsed, 'a historical style reference for HTML generation must remain executable');
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.api, 'chat');
  assert.deepStrictEqual(parsed.selectedImageIds, ['img-reference-page']);
  assert.deepStrictEqual(parsed.messageRefs, [{ key: 'r1', role: 'assistant', message_id: 'message-style-source', index: 4, source: 'history' }]);

  const staleMessage = structuredClone(reference);
  staleMessage.resources[0].id = 'missing-message';
  assert.strictEqual(routeService.parseRouteResult(JSON.stringify(staleMessage), {
    input: 'Restyle the previous webpage to match the reference image without embedding it.',
    context: {
      recent_messages: [{ index: 4, id: 'message-style-source', role: 'assistant', content: 'The earlier webpage implementation.' }],
      image_candidates: [{ index: 1, source_index: 1, source: 'history', image_id: 'img-reference-page', reference_id: 'imgref-reference-page', target: 'previous' }],
    },
  }), null, 'a route-selected historical message must resolve exactly instead of silently falling back to arbitrary history');
}

function testClientContractAcceptsTheCurrentUploadAttachmentIdAsACanonicalAlias() {
  const edit = taskContract({
    operation: 'edit_image',
    resources: [{ key: 'r1', type: 'image', source: 'current', role: 'target', index: 1, id: 'att_current_1.png', reference_id: 'imgref_uploaded_7', missing: false }],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [{ op: 'replace', target: 'person gender', value: 'female' }], constraints: [] },
  });
  const context = {
    recent_messages: [{ index: 7, role: 'user' }],
    image_candidates: [{ index: 4, source_index: 1, source: 'current', image_id: 'img_imgref_uploaded_7_1', reference_id: 'imgref_uploaded_7', target: 'uploaded' }],
  };
  const attachments = [{ id: 'att_current_1.png', image_id: 'att_current_1.png', media_index: 1, source_index: 1, is_image: true, type: 'image/png' }];
  const parsed = routeService.parseRouteResult(JSON.stringify(edit), { input: 'change the man into a woman', context, attachments });
  assert.ok(parsed, 'the transient attachment id must resolve to the same current image as its durable context candidate');
  assert.deepStrictEqual(parsed.selectedImageIds, ['img_imgref_uploaded_7_1'], 'execution must use the durable canonical image id');
  assert.deepStrictEqual(parsed.selectedIndexes, [1], 'execution must retain the source-local attachment index');

  const unrelated = structuredClone(edit);
  unrelated.resources[0].id = 'att_other.png';
  assert.strictEqual(routeService.parseRouteResult(JSON.stringify(unrelated), { input: 'change the man into a woman', context, attachments }), null, 'an unrelated attachment id must remain non-executable');
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
  testRoutePromptIsOneOrderedDecisionSpecification,
  testClientContractRoutePayloadKeepsCompactShape,
  testRouteResultInspectionSeparatesShapeAndResourceFailures,
  testClientContractRoutePayloadRetainsHistoricalFilesAlongsideCurrentFiles,
  testClientContractAttachmentMetadataUsesTypedMediaIndexes,
  testClientContractRouteParsingPreservesClarificationShape,
  testClientContractRejectsRedundantOrUnknownFields,
  testExplicitQuoteCompletesOnlyAnOmittedFollowupMessageBinding,
  testClientContractBindsMediaResourcesToExactCandidates,
  testClientContractAcceptsHistoryAliasForAnExplicitlyQuotedImageOnly,
  testClientContractAcceptsCurrentTextResourceForTextToImage,
  testClientContractAcceptsCurrentTextResourceForEveryExecutableOperation,
  testClientContractAcceptsHistoricalStyleReferenceForHtmlChat,
  testClientContractAcceptsTheCurrentUploadAttachmentIdAsACanonicalAlias,
  testClientContractEnforcesOperationSpecificResourcesAndTypedIndexes,
  testClientContractServiceExportsStayStable,
  testClientContractChatAndSseParsingShape,
];
