const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routeService = require('../../client/services/route-service');
const clarificationService = require('../../client/services/clarification-service');
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
    'terminalClarificationRouteFromResult',
    'mergeRouteReadinessRequirement',
    'isRouteDispatchable',
    'buildRoutePayload',
    'buildIntentReviewPayload',
  ]) {
    assert.ok(key in routeService, `missing canonical route export: ${key}`);
  }
  assert.ok(!('apiRouteToExecutionRoute' in routeService));
  assert.ok(!('taskContractForRoute' in routeService));
  assert.ok(!('reconcileMultiImageCompositionContract' in routeService), 'valid model contracts must not be overridden by local keyword routing');
  assert.ok(!('semanticallySelectedCompositionCandidates' in routeService), 'image candidate matching belongs to the model contract, not a local fallback');
  assert.ok(!('resolveClarificationRoute' in routeService), 'clarification choices must return through the full router instead of a local execution path');
  const intentContract = require('../../client/core/intent-contract');
  assert.deepStrictEqual({
    plain_chat: intentContract.contractMode({ operation: 'plain_chat' }),
    file_qa: intentContract.contractMode({ operation: 'file_qa' }),
    multimodal_qa: intentContract.contractMode({ operation: 'multimodal_qa' }),
    image_qa: intentContract.contractMode({ operation: 'image_qa' }),
    image_compare: intentContract.contractMode({ operation: 'image_compare' }),
    ocr: intentContract.contractMode({ operation: 'ocr' }),
    text_to_image: intentContract.contractMode({ operation: 'text_to_image' }),
    image_reference_gen: intentContract.contractMode({ operation: 'image_reference_gen' }),
    edit_image: intentContract.contractMode({ operation: 'edit_image' }),
  }, {
    plain_chat: 'chat', file_qa: 'chat', multimodal_qa: 'chat', image_qa: 'chat', image_compare: 'chat', ocr: 'chat',
    text_to_image: 'image', image_reference_gen: 'image', edit_image: 'edit_image',
  });
}

function testRoutePromptIsOneOrderedDecisionSpecification() {
  const system = routeService.ROUTE_SYSTEM_PROMPT;
  for (const section of ['一、输入边界与优先级', '二、operation 语义', '三、资源绑定与附件可用性', '四、readiness 与澄清', '五、relation 与 directive', '六、最终合同校验']) {
    assert.ok(system.includes(section), `missing ordered route section: ${section}`);
  }
  assert.ok(system.includes('context.quoted_message'), 'an explicit UI quote must be part of the routing specification');
  assert.ok(!system.includes('边界示例'), 'the production prompt must not grow into a second rulebook of examples');
  assert.ok(system.length < 6500, 'the complete primary routing specification must stay cognitively compact');
  for (const operation of ['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'ocr', 'text_to_image', 'image_compare', 'edit_image', 'image_reference_gen']) {
    assert.ok(system.includes(operation), `the contract self-check must cover ${operation}`);
  }
  assert.ok(system.includes('has_extracted_text=false') && system.includes('reason=unavailable'), 'unusable files must be a first-class non-executing state');
  assert.ok(system.includes('多个相互独立或跨执行族') && system.includes('不得部分执行'), 'cross-API multi-task input must fail into clarification instead of partial execution');
  assert.ok(system.includes('current_input 为空但存在附件') && system.includes('不猜用户目的'), 'attachment-only input must have an explicit safe policy');
  assert.ok(system.includes('auto_mode=false') && system.includes('current_mode'), 'manual and automatic routing modes must be defined');
  assert.ok(system.includes('绝不能一律写成 followup'), 'historical reference generation must preserve correction and continuation relations');
  assert.ok(system.includes('“生成提示词”绝不是“生成图片”') && system.includes('属于 image_qa'), 'image-to-prompt requests must remain text-producing vision tasks');
  assert.ok(system.includes('image 允许 text_to_image 与 image_reference_gen') && system.includes('仍属于 image 产品模式'), 'reference generation must remain allowed in the image product mode');
  assert.ok(routeService.ROUTE_OUTPUT_CONTRACT_CHECK.length < 450, 'the final check should remain a compact invariant list, not duplicate the routing rules');
  assert.ok(routeService.ROUTE_OUTPUT_CONTRACT_CHECK.includes('逐字段自检'), 'the first route request must require a complete contract even when the intent is simple');
  assert.ok(routeService.ROUTE_OUTPUT_CONTRACT_CHECK.includes('空数组也必须输出 []'), 'the first route request must explicitly retain empty contract fields instead of relying on contract repair');
  assert.ok(routeService.ROUTE_OUTPUT_CONTRACT_CHECK.includes('所有参考图均为 patch 基线') && routeService.ROUTE_OUTPUT_CONTRACT_CHECK.includes('preserve/remove 的 value=""'), 'the final check must state image-reference and directive invariants');
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
  const unresolvedReason = payload.response_format?.json_schema?.schema?.properties?.clarification?.properties?.unresolved_resources?.items?.properties?.reason;
  assert.ok(unresolvedReason?.enum?.includes('unavailable'), 'strict output schema must represent an unusable attachment without pretending it is missing or selectable');
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
  assert.ok(payload.messages[0].content.length < 7000, 'the route prompt must remain within its compact context budget');
  assert.ok(!/(reasoning|thinking|reasoning_effort|enable_thinking)/i.test(JSON.stringify(payload)));

  const manual = JSON.parse(routeService.buildRoutePayload({ model: 'route-model', input: 'answer this', currentMode: 'chat', autoMode: false }).messages[1].content);
  assert.strictEqual(manual.current_mode, 'chat', 'manual chat mode must not disappear merely because chat is the default');
  assert.strictEqual(manual.auto_mode, false);

  const automatic = JSON.parse(routeService.buildRoutePayload({ model: 'route-model', input: '画一只中国的猫', currentMode: 'edit_image', autoMode: true }).messages[1].content);
  assert.deepStrictEqual(automatic, { current_input: '画一只中国的猫' }, 'automatic routing must not carry a mode inferred for the previous task');
}

function testRouteResultInspectionSeparatesShapeAndResourceFailures() {
  const malformed = routeService.inspectRouteResult('{not-json');
  assert.strictEqual(malformed.route, null);
  assert.strictEqual(malformed.reason, 'contract_semantics');

  const unknownField = routeService.inspectRouteResult(JSON.stringify({
    schema_version: 'task_contract.v4', operation: 'plain_chat', relation: 'new', resources: [],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', resume_operation: '', unresolved_resources: [] }, confidence: 0.9, review_reasons: [], rationale: 'valid intent but invalid shape', extra: true,
  }));
  assert.strictEqual(unknownField.route, null);
  assert.strictEqual(unknownField.reason, 'contract_shape');

  const declaredClarification = routeService.inspectRouteResult(JSON.stringify({
    schema_version: 'task_contract.v5', readiness: 'needs_clarification', operation: 'image_reference_gen', relation: 'followup', resources: [],
    directive: { mode: 'patch', base_resource_keys: [], unmentioned_policy: 'preserve', operations: [], constraints: [] },
    clarification: {
      question: 'Which fish image should be used?',
      unresolved_resources: [{
        key: 'r1', type: 'image', role: 'reference', reason: 'ambiguous',
        choices: [{ key: 'c1', source: 'history', index: 1, id: 'unbound-fish', reference_id: 'unbound-ref', label: 'fish' }],
      }],
    },
    confidence: 0, review_reasons: [], rationale: 'the route requires a customer choice',
  }));
  assert.strictEqual(declaredClarification.reason, '', 'a declared clarification is a successful non-executing route even when its future execution contract is incomplete');
  assert.strictEqual(declaredClarification.route.api, 'clarify');
  assert.strictEqual(declaredClarification.route.dispatchAuthorized, false);
  assert.strictEqual(declaredClarification.route.taskContract, null);
  assert.strictEqual(declaredClarification.route.requiresRerouteAfterClarification, true);
  assert.strictEqual(declaredClarification.route.clarificationQuestion, 'Which fish image should be used?');
  const degradedPending = clarificationService.createPendingClarification({
    messages: [
      { role: 'user', content: 'combine the cat and fish' },
      { role: 'assistant', content: declaredClarification.route.clarificationQuestion },
    ],
    clarificationText: declaredClarification.route.clarificationQuestion,
    routeInfo: declaredClarification.route,
  });
  assert.strictEqual(degradedPending.routeInfo.requiresRerouteAfterClarification, true, 'a degraded clarification must persist the requirement to reroute after the customer answers');
  assert.strictEqual(degradedPending.routeInfo.clarificationDegraded, true);
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
    schema_version: 'task_contract.v4',
    operation: 'clarify',
    relation: 'followup',
    resources: [],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [{ op: 'replace', target: 'background', value: 'red' }], constraints: [] },
    clarification: {
      question,
      resume_operation: 'edit_image',
      unresolved_resources: [{
        key: 'r1', type: 'image', role: 'target', reason: 'ambiguous', choices: [
          { key: 'c1', source: 'history', index: 1, id: 'img-cat', reference_id: 'imgref-cat', label: 'cat image' },
          { key: 'c2', source: 'history', index: 2, id: 'img-fish', reference_id: 'imgref-fish', label: 'fish image' },
        ],
      }],
    },
    confidence: 0.7,
    review_reasons: [],
    rationale: 'multiple candidates',
  }), { input: 'edit this image', attachments: [], context: { image_candidates: [
    { index: 1, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat', target: 'previous' },
    { index: 2, source: 'history', image_id: 'img-fish', reference_id: 'imgref-fish', target: 'previous' },
  ] } });
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.needClarification, true);
  assert.ok(parsed.clarificationQuestion.startsWith(question));
  assert.match(parsed.clarificationQuestion, /1\. cat image/);
  assert.match(parsed.clarificationQuestion, /2\. fish image/);
  assert.strictEqual(parsed.taskContract.readiness, 'needs_clarification');
  assert.strictEqual(parsed.taskContract.operation, 'edit_image');
  assert.strictEqual(parsed.operationType, 'edit_image');
  assert.strictEqual(parsed.resumeOperation, 'edit_image');
}

function testClientContractRejectsRedundantOrUnknownFields() {
  const invalid = {
    schema_version: 'task_contract.v4',
    operation: 'plain_chat',
    relation: 'new',
    resources: [],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', resume_operation: '', unresolved_resources: [] },
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
    schema_version: 'task_contract.v4',
    operation: 'plain_chat',
    relation: 'followup',
    resources: [],
    directive: { mode: 'patch', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', resume_operation: '', unresolved_resources: [] },
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
    schema_version: 'task_contract.v4',
    operation,
    relation,
    resources,
    directive: directive || { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', resume_operation: '', unresolved_resources: [] },
    confidence,
    review_reasons: reviewReasons,
    rationale: 'contract validation test',
  };
}

function testClientContractSeparatesConversationRelationFromResourcePatching() {
  for (const relation of ['followup', 'correction', 'continuation']) {
    const conversational = taskContract({ operation: 'plain_chat', relation });
    assert.strictEqual(
      routeService.isTaskContractResult(conversational),
      true,
      `resource-free plain chat must allow the ${relation} discourse relation without a patch baseline`
    );
  }

  const withCurrentText = taskContract({
    operation: 'plain_chat',
    relation: 'followup',
    resources: [currentTextResource()],
  });
  assert.strictEqual(routeService.isTaskContractResult(withCurrentText), true, 'the optional current-text resource must not become a historical patch baseline');

  const boundHistoryWithoutPatch = taskContract({
    operation: 'plain_chat',
    relation: 'followup',
    resources: [{ key: 'r1', type: 'message', source: 'history', role: 'context', index: 1, id: 'message-1', reference_id: '', missing: false }],
  });
  assert.strictEqual(routeService.isTaskContractResult(boundHistoryWithoutPatch), false, 'an explicit history binding must still use a patch directive');

  const resourceOperationWithoutPatch = taskContract({
    operation: 'image_qa',
    relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'current', role: 'source', index: 1, id: 'image-1', reference_id: '', missing: false }],
  });
  assert.strictEqual(routeService.isTaskContractResult(resourceOperationWithoutPatch), true, 'a current-turn resource remains standalone regardless of the discourse relation');

  const historyImageWithoutPatch = taskContract({
    operation: 'image_qa',
    relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'history', role: 'source', index: 1, id: 'image-1', reference_id: 'imgref-1', missing: false }],
  });
  assert.strictEqual(routeService.isTaskContractResult(historyImageWithoutPatch), false, 'historical resources must declare their patch baseline regardless of operation');
}

function testUnavailableFilesAndAttachmentOnlyInputRemainNonExecuting() {
  const unavailableFile = {
    index: 1,
    source_index: 1,
    source: 'current',
    file_id: 'file-binary-pdf',
    name: 'scan.pdf',
    has_extracted_text: false,
    unsupported_reason: '未提取到文本',
  };
  const readyFileRoute = taskContract({
    operation: 'file_qa',
    resources: [{ key: 'r1', type: 'file', source: 'current', role: 'attachment', index: 1, id: 'file-binary-pdf', reference_id: '', missing: false }],
  });
  assert.strictEqual(
    routeService.parseRouteResult(JSON.stringify(readyFileRoute), { input: '总结文件', context: { file_candidates: [unavailableFile] } }),
    null,
    'a model must not authorize a formal file request when extraction explicitly failed',
  );

  const unavailableClarification = {
    schema_version: 'task_contract.v5',
    readiness: 'needs_clarification',
    operation: 'file_qa',
    relation: 'new',
    resources: [],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: {
      question: '该文件没有可读取的正文，请重新上传可解析格式。',
      unresolved_resources: [{ key: 'r1', type: 'file', role: 'attachment', reason: 'unavailable', choices: [] }],
    },
    confidence: 0.98,
    review_reasons: [],
    rationale: 'the requested file has no extracted text',
  };
  const unavailablePlan = routeService.parseRouteResult(JSON.stringify(unavailableClarification), {
    input: '总结文件',
    context: { file_candidates: [unavailableFile] },
  });
  assert.ok(unavailablePlan);
  assert.strictEqual(unavailablePlan.api, 'clarify');
  assert.strictEqual(unavailablePlan.dispatchAuthorized, false);
  assert.strictEqual(unavailablePlan.taskContract.clarification.unresolved_resources[0].reason, 'unavailable');

  const attachmentOnly = {
    schema_version: 'task_contract.v5',
    readiness: 'needs_clarification',
    operation: 'image_qa',
    relation: 'new',
    resources: [{ key: 'r1', type: 'image', source: 'current', role: 'source', index: 1, id: 'image-current', reference_id: 'image-current-ref', missing: false }],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: {
      question: '你希望我对这张图片做什么？',
      unresolved_resources: [{ key: 'r2', type: 'text', role: 'source', reason: 'missing', choices: [] }],
    },
    confidence: 0.95,
    review_reasons: [],
    rationale: 'the current image is known but the instruction is missing',
  };
  const attachmentOnlyPlan = routeService.parseRouteResult(JSON.stringify(attachmentOnly), {
    input: '',
    attachments: [{ id: 'image-current', image_id: 'image-current', type: 'image/png', is_image: true, media_index: 1 }],
    context: { image_candidates: [{ index: 1, source_index: 1, source: 'current', image_id: 'image-current', reference_id: 'image-current-ref' }] },
  });
  assert.ok(attachmentOnlyPlan);
  assert.strictEqual(attachmentOnlyPlan.api, 'clarify');
  assert.strictEqual(attachmentOnlyPlan.dispatchAuthorized, false);
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

function testCurrentTurnResourcesStayStandaloneAcrossConversationRelations() {
  for (const relation of ['followup', 'correction', 'continuation']) {
    const image = { key: 'r1', type: 'image', source: 'current', role: 'source', index: 1, id: 'img-current', reference_id: '', missing: false };
    const file = { key: 'r1', type: 'file', source: 'current', role: 'attachment', index: 1, id: 'file-current', reference_id: '', missing: false };
    assert.strictEqual(routeService.isTaskContractResult(taskContract({ operation: 'image_qa', relation, resources: [image] })), true);
    assert.strictEqual(routeService.isTaskContractResult(taskContract({ operation: 'file_qa', relation, resources: [file] })), true);
    assert.strictEqual(routeService.isTaskContractResult(taskContract({ operation: 'text_to_image', relation, resources: [currentTextResource('r1')] })), true);
  }

  const currentReference = { key: 'r1', type: 'image', source: 'current', role: 'reference', index: 1, id: 'img-current', reference_id: '', missing: false };
  const currentTarget = { ...currentReference, role: 'target' };
  assert.strictEqual(routeService.isTaskContractResult(taskContract({ operation: 'image_reference_gen', relation: 'followup', resources: [currentReference] })), false, 'reference generation still requires an explicit patch baseline');
  assert.strictEqual(routeService.isTaskContractResult(taskContract({ operation: 'edit_image', relation: 'followup', resources: [currentTarget] })), false, 'image editing still requires an explicit patch baseline');
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

  const structuredClarification = {
    schema_version: 'task_contract.v4', operation: 'clarify', relation: 'followup',
    resources: [],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [{ op: 'replace', target: 'background', value: 'blue' }], constraints: [] },
    clarification: { question: 'Which image should I edit?', resume_operation: 'edit_image', unresolved_resources: [{ key: 'r1', type: 'image', role: 'target', reason: 'missing', choices: [] }] },
    confidence: 0.5, review_reasons: ['image selection is missing'], rationale: 'no candidate is available',
  };
  assert.strictEqual(routeService.isTaskContractResult(structuredClarification), true, 'clarification must preserve the directive of the task that resumes after resource binding');
}

function testStructuredClarificationSelectionResumesTheOriginalCompositionContract() {
  const contract = {
    schema_version: 'task_contract.v4',
    operation: 'clarify',
    relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'history', role: 'reference', index: 4, id: 'img-cat', reference_id: 'imgref-cat', missing: false }],
    directive: {
      mode: 'patch',
      base_resource_keys: ['r1', 'r2'],
      unmentioned_policy: 'preserve',
      operations: [{ op: 'add', target: 'composition', value: 'combine the cat and selected fish' }],
      constraints: ['natural composition'],
    },
    clarification: {
      question: 'Which fish image should be combined with the cat?',
      resume_operation: 'image_reference_gen',
      unresolved_resources: [{
        key: 'r2',
        type: 'image',
        role: 'reference',
        reason: 'ambiguous',
        choices: [
          { key: 'c1', source: 'history', index: 1, id: 'img-fish-sketch', reference_id: 'imgref-fish-sketch', label: 'hand-drawn fish' },
          { key: 'c2', source: 'history', index: 2, id: 'img-fish-color', reference_id: 'imgref-fish-color', label: 'colorful fish' },
        ],
      }],
    },
    confidence: 0.9,
    review_reasons: [],
    rationale: 'the cat is unique but two fish candidates remain',
  };
  const context = { image_candidates: [
    { index: 4, source_index: 4, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat', target: 'previous' },
    { index: 1, source_index: 1, source: 'history', image_id: 'img-fish-sketch', reference_id: 'imgref-fish-sketch', target: 'previous' },
    { index: 2, source_index: 2, source: 'history', image_id: 'img-fish-color', reference_id: 'imgref-fish-color', target: 'previous' },
  ] };
  const clarificationRoute = routeService.parseRouteResult(JSON.stringify(contract), { input: 'combine the cat and fish', context });
  assert.ok(clarificationRoute);
  assert.strictEqual(clarificationRoute.needClarification, true);
  assert.strictEqual(clarificationRoute.api, 'clarify');
  assert.strictEqual(clarificationRoute.dispatchAuthorized, false);
  assert.strictEqual(routeService.isRouteDispatchable(clarificationRoute), false);
  assert.match(clarificationRoute.clarificationQuestion, /1\. hand-drawn fish/);
  assert.match(clarificationRoute.clarificationQuestion, /2\. colorful fish/);

  const pending = clarificationService.createPendingClarification({
    messages: [{ role: 'user', content: 'combine the cat and fish' }, { role: 'assistant', content: clarificationRoute.clarificationQuestion }],
    clarificationText: clarificationRoute.clarificationQuestion,
    routeInfo: clarificationRoute,
  });
  assert.deepStrictEqual(pending.routeInfo.taskContract, routeService.decodeTaskContract(contract), 'the pending state must retain the validated canonical contract instead of only its question text');

  const decision = clarificationService.parseContinuationClassifierResult(JSON.stringify({
    schema_version: clarificationService.CONTINUATION_SCHEMA_VERSION,
    relation: 'pending_answer',
    confidence: 0.99,
    resolved_input: 'combine the cat and colorful fish',
    selections: [{ resource_key: 'r2', choice_key: 'c2' }],
    should_merge: true,
    should_clear_pending: true,
    assistant_reply: '',
    reason: 'the user selected the colorful fish option',
  }), { pending });
  assert.ok(decision);
  const rerouteContext = clarificationService.buildClarificationRouteContext({
    baseContext: context,
    pending,
    currentInput: 'the colorful fish',
    resolvedInput: decision.resolvedInput,
    selections: decision.selections,
    attachments: [],
  });
  assert.ok(rerouteContext, 'a valid choice must become non-executing context for a fresh route request');
  assert.strictEqual(rerouteContext.clarification_context.selected_choices[0].id, 'img-fish-color');
  assert.strictEqual(rerouteContext.clarification_context.prior_task_contract.readiness, 'needs_clarification');
  const reroutePayload = routeService.buildRoutePayload({ model: 'route-model', input: decision.resolvedInput, context: rerouteContext });
  const rerouteUser = JSON.parse(reroutePayload.messages[1].content);
  assert.strictEqual(rerouteUser.context.clarification_context.resolved_input, decision.resolvedInput);
  assert.strictEqual(routeService.isRouteDispatchable(clarificationRoute), false, 'the prior clarification route must remain non-executable');
  assert.strictEqual(clarificationService.parseContinuationClassifierResult(JSON.stringify({
    schema_version: clarificationService.CONTINUATION_SCHEMA_VERSION,
    relation: 'pending_answer', confidence: 0.99, resolved_input: 'combine them',
    selections: [{ resource_key: 'r2', choice_key: 'c9' }], should_merge: true,
    should_clear_pending: true, assistant_reply: '', reason: 'unknown choice',
  }), { pending }), null, 'an unknown choice must never enter the reroute context');

  const missingUpload = {
    schema_version: 'task_contract.v4',
    operation: 'clarify',
    relation: 'followup',
    resources: [],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [{ op: 'replace', target: 'background', value: 'red' }], constraints: [] },
    clarification: { question: 'Please upload the image to edit.', resume_operation: 'edit_image', unresolved_resources: [{ key: 'r1', type: 'image', role: 'target', reason: 'missing', choices: [] }] },
    confidence: 0.8,
    review_reasons: [],
    rationale: 'the required image is absent',
  };
  const missingRoute = routeService.parseRouteResult(JSON.stringify(missingUpload), { input: 'make the background red', context: {} });
  const uploadPending = clarificationService.createPendingClarification({
    messages: [{ role: 'user', content: 'make the background red' }],
    clarificationText: missingRoute.clarificationQuestion,
    routeInfo: missingRoute,
  });
  const uploadContext = clarificationService.buildClarificationRouteContext({
    baseContext: {}, pending: uploadPending, currentInput: 'uploaded', resolvedInput: 'make the uploaded image background red', selections: [],
    attachments: [{ id: 'upload-1', image_id: 'upload-1', name: 'photo.png', type: 'image/png', is_image: true }],
  });
  assert.strictEqual(uploadContext.clarification_context.attachments.current[0].id, 'upload-1');
  assert.strictEqual(uploadContext.clarification_context.attachments.current[0].source, 'current');
  assert.strictEqual(missingRoute.dispatchAuthorized, false, 'an upload answer still requires a full route result before dispatch');
}

function testStableResourceIdentityCanonicalizesDisplayIndexesWithoutChoosingForTheUser() {
  const contract = {
    schema_version: 'task_contract.v4',
    operation: 'image_reference_gen',
    relation: 'followup',
    resources: [{
      key: 'r1', type: 'image', source: 'history', role: 'reference', index: 10,
      id: 'img_imgref_pending-submit-submit-ms1628mm-7ym9tfcp_1',
      reference_id: 'imgref_pending-submit-submit-ms1628mm-7ym9tfcp', missing: false,
    }],
    directive: {
      mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'allow_change',
      operations: [{ op: 'add', target: 'prompt', value: '把猫和鱼合并成一张图，场景要自然协调' }], constraints: [],
    },
    clarification: {
      question: '您指的是哪一张鱼图片？',
      resume_operation: 'image_reference_gen',
      unresolved_resources: [{
        key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous', choices: [
          {
            key: 'c1', source: 'history', index: 20,
            id: 'img_imgref_pending-submit-submit-ms19jzdh-5gfu2ma1_1',
            reference_id: 'imgref_pending-submit-submit-ms19jzdh-5gfu2ma1', label: '手绘一条鱼',
          },
          {
            key: 'c2', source: 'history', index: 18,
            id: 'img_imgref_pending-submit-submit-ms19h3ic-htripy4j_1',
            reference_id: 'imgref_pending-submit-submit-ms19h3ic-htripy4j', label: '画一条鱼',
          },
        ],
      }],
    },
    confidence: 0,
    review_reasons: ['ambiguous_reference'],
    rationale: '猫图唯一，但存在两张鱼图，需要用户选择。',
  };
  const context = { image_candidates: [
    {
      index: 4, source: 'history', target: 'previous',
      image_id: contract.resources[0].id, reference_id: contract.resources[0].reference_id,
    },
    {
      index: 1, source: 'history', target: 'previous',
      image_id: contract.clarification.unresolved_resources[0].choices[0].id,
      reference_id: contract.clarification.unresolved_resources[0].choices[0].reference_id,
    },
    {
      index: 2, source: 'history', target: 'previous',
      image_id: contract.clarification.unresolved_resources[0].choices[1].id,
      reference_id: contract.clarification.unresolved_resources[0].choices[1].reference_id,
    },
  ] };

  const route = routeService.parseRouteResult(JSON.stringify(contract), {
    input: '把猫和鱼合并成一张图 场景要自然协调', context, attachments: [],
  });
  assert.ok(route, 'stable candidate identities must survive a stale model-authored display index');
  assert.strictEqual(route.needClarification, true);
  assert.strictEqual(route.api, 'clarify');
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.strictEqual(routeService.isRouteDispatchable(route), false);
  assert.deepStrictEqual(route.taskContract.directive.base_resource_keys, ['r1', 'r2'], 'non-executing directive bindings must be derived from the declared resource slots');
  assert.strictEqual(route.taskContract.resources[0].index, 4, 'the runtime candidate table owns the canonical display index');
  assert.deepStrictEqual(route.taskContract.clarification.unresolved_resources[0].choices.map(choice => choice.index), [1, 2]);
  assert.deepStrictEqual(route.taskContract.clarification.unresolved_resources[0].choices.map(choice => choice.key), ['c1', 'c2'], 'canonicalization must retain every user choice');

  const pending = clarificationService.createPendingClarification({
    messages: [{ role: 'user', content: '把猫和鱼合并成一张图 场景要自然协调' }],
    clarificationText: route.clarificationQuestion,
    routeInfo: route,
  });
  const rerouteContext = clarificationService.buildClarificationRouteContext({
    baseContext: context, pending, currentInput: '第二张鱼',
    resolvedInput: '把猫和第二张鱼合并成一张图，场景自然协调',
    selections: [{ resource_key: 'r2', choice_key: 'c2' }], attachments: [],
  });
  assert.ok(rerouteContext);
  assert.strictEqual(rerouteContext.clarification_context.selected_choices[0].id, contract.clarification.unresolved_resources[0].choices[1].id);
  assert.strictEqual(route.dispatchAuthorized, false, 'candidate canonicalization must not turn the first route into an executable one');
}

function testClarificationPresentationNeverExposesInternalResourceKeys() {
  const contract = {
    schema_version: 'task_contract.v5', readiness: 'needs_clarification', operation: 'image_reference_gen', relation: 'followup', resources: [],
    directive: { mode: 'patch', base_resource_keys: ['r1', 'r2'], unmentioned_policy: 'preserve', operations: [], constraints: [] },
    clarification: {
      question: '请选择要合并的狗图片和鱼图片。',
      unresolved_resources: [
        { key: 'r1', type: 'image', role: 'reference', reason: 'ambiguous', choices: [
          { key: 'c1', source: 'history', index: 1, id: 'dog-original', reference_id: 'dog-original-ref', label: '画一只狗（原始）' },
          { key: 'c2', source: 'history', index: 2, id: 'dog-color', reference_id: 'dog-color-ref', label: '狗要彩绘（彩绘版）' },
        ] },
        { key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous', choices: [
          { key: 'c1', source: 'history', index: 3, id: 'fish-original', reference_id: 'fish-original-ref', label: '画一条鱼（原始）' },
          { key: 'c2', source: 'history', index: 4, id: 'fish-color', reference_id: 'fish-color-ref', label: '鱼要彩绘（彩绘版）' },
        ] },
      ],
    },
    confidence: 0.9, review_reasons: [], rationale: 'both image groups need a customer choice',
  };
  const route = routeService.parseRouteResult(JSON.stringify(contract), {
    context: { image_candidates: [
      { index: 1, source: 'history', target: 'previous', image_id: 'dog-original', reference_id: 'dog-original-ref' },
      { index: 2, source: 'history', target: 'previous', image_id: 'dog-color', reference_id: 'dog-color-ref' },
      { index: 3, source: 'history', target: 'previous', image_id: 'fish-original', reference_id: 'fish-original-ref' },
      { index: 4, source: 'history', target: 'previous', image_id: 'fish-color', reference_id: 'fish-color-ref' },
    ] },
  });
  assert.ok(route);
  assert.match(route.clarificationQuestion, /狗图片/);
  assert.match(route.clarificationQuestion, /鱼图片/);
  assert.doesNotMatch(route.clarificationQuestion, /(?:^|\n)\s*\d+\. r[12](?:\n|$)/);
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
  testClientContractSeparatesConversationRelationFromResourcePatching,
  testUnavailableFilesAndAttachmentOnlyInputRemainNonExecuting,
  testClientContractBindsMediaResourcesToExactCandidates,
  testClientContractAcceptsHistoryAliasForAnExplicitlyQuotedImageOnly,
  testClientContractAcceptsCurrentTextResourceForTextToImage,
  testClientContractAcceptsCurrentTextResourceForEveryExecutableOperation,
  testCurrentTurnResourcesStayStandaloneAcrossConversationRelations,
  testClientContractAcceptsHistoricalStyleReferenceForHtmlChat,
  testClientContractAcceptsTheCurrentUploadAttachmentIdAsACanonicalAlias,
  testClientContractEnforcesOperationSpecificResourcesAndTypedIndexes,
  testStructuredClarificationSelectionResumesTheOriginalCompositionContract,
  testStableResourceIdentityCanonicalizesDisplayIndexesWithoutChoosingForTheUser,
  testClarificationPresentationNeverExposesInternalResourceKeys,
  testClientContractServiceExportsStayStable,
  testClientContractChatAndSseParsingShape,
];
