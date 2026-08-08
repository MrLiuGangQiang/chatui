'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');
const dispatchContract = require('../../shared/dispatch-contract');
const imageExecution = require('../../client/core/image-execution');
const clarificationAnswer = require('../../shared/clarification-answer');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

function inspect(routeDraft, options = {}) {
  return routeService.compileLocalRoute(routeDraft, {
    input: routeDraft.arguments?.prompt || '',
    attachments: [],
    context: {},
    ...options,
  });
}

function pools(sourcePools = {}, options = {}) {
  return submitHelpers.buildExecutionResourcePools(sourcePools, {
    isImageFile: item => String(item?.type || '').startsWith('image/'),
    ...options,
  });
}

function testRouteContractDeclaresCanonicalBindingRoles() {
  const schema = routeService.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema;
  const roleSchema = schema.properties.resource_refs.items.properties.role;
  assert.deepStrictEqual(roleSchema.enum, [
    'target', 'reference', 'style_reference', 'mask',
    'source', 'attachment', 'context', 'compare_a', 'compare_b',
  ]);
  assert.deepStrictEqual(schema.required, ['operation', 'relation', 'goal', 'resource_refs']);
  assert.strictEqual(schema.properties.api, undefined);
  assert.strictEqual(schema.properties.arguments, undefined);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /edit_image 待编辑图用 target/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /text_to_image 不绑定图片或文件/);
}

function testPlainChatAlwaysCarriesAnEmptyCanonicalProjection() {
  const route = inspect(makeExecutionFixture({ operation: 'plain_chat', prompt: 'hello' }).dispatchContract);
  assert.strictEqual(route.executionResources.version, 'execution_resources.v2');
  assert.strictEqual(route.executionResources.operation, 'plain_chat');
  assert.deepStrictEqual(route.executionResources.images, []);
  assert.deepStrictEqual(route.executionResources.files, []);
  assert.deepStrictEqual(route.executionResources.messages, []);
  assert.strictEqual(route.executionResources.selectedMessageRefs.length, 0);
  assert.strictEqual(dispatchContract.hasExactDispatchContract(route.dispatchContract), true);
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
  assert.doesNotThrow(() => submitHelpers.projectRouteExecutionMedia(route, pools()));
}

function testMessageBoundFollowupProjectsWhenSessionMessagesAreSupplied() {
  const resource = {
    key: 'r1',
    type: 'message',
    source: 'history',
    role: 'context',
    index: 2,
    id: 'chat-session:assistant:1',
    resource_id: 'res:message:chat-session%3Aassistant%3A1',
    reference_id: '',
  };
  const plan = makeExecutionFixture({
    operation: 'plain_chat',
    prompt: '追问',
    resources: [resource],
  }).dispatchContract;
  const route = inspect(plan, {
    context: {
      recent_messages: [
        { index: 1, id: 'chat-session:user:0', role: 'user', content: '问题' },
        { index: 2, id: 'chat-session:assistant:1', role: 'assistant', content: '答案' },
        { index: 3, id: 'chat-session:user:2', role: 'user', content: '追问' },
      ],
    },
  });
  assert.strictEqual(route.executionResources.messages.length, 1);
  assert.strictEqual(route.executionResources.messages[0].key, 'r1');

  // The submit/regenerate workflows must feed the session messages into the
  // execution pools; without them the message resource cannot resolve.
  assert.throws(
    () => submitHelpers.projectRouteExecutionMedia(route, pools()),
    error => error.code === 'EXECUTION_RESOURCE_UNRESOLVED'
      && error.resourceKey === 'r1',
    'message-bound routes must fail closed when the caller omits session messages',
  );

  const media = submitHelpers.projectRouteExecutionMedia(route, pools({}, {
    messages: [
      { role: 'user', id: 'chat-session:user:0', content: '问题' },
      { role: 'assistant', id: 'chat-session:assistant:1', content: '答案' },
      { role: 'user', id: 'chat-session:user:2', content: '追问' },
    ],
  }));
  assert.strictEqual(media.chatMessages.length, 1);
  assert.strictEqual(media.chatMessages[0].routeResourceKey, 'r1');
  assert.strictEqual(media.chatMessages[0].routeId, 'chat-session:assistant:1');
  assert.strictEqual(media.chatMessages[0].routeSource, 'history');
}

function testTextToImageWithoutInputsIsDispatchableAndImageAuthorized() {
  const route = inspect(makeExecutionFixture({ operation: 'text_to_image', prompt: 'a red fox' }).dispatchContract);
  const media = submitHelpers.projectRouteExecutionMedia(route, pools());
  const policy = imageExecution.createImageExecutionPolicy({ dispatchContract });
  const authorized = policy.requireCanonicalImageExecution(route.dispatchContract, media);
  assert.strictEqual(authorized.operation, 'text_to_image');
  assert.strictEqual(authorized.api, 'image_generation');
  assert.deepStrictEqual(authorized.imageInputs, []);
}

function testCurrentImageBindingProjectsByCanonicalIdentity() {
  const resource = {
    key: 'r1',
    type: 'image',
    source: 'current',
    role: 'target',
    index: 1,
    id: 'upload-1',
    resource_id: 'res:image:upload-1',
    reference_id: 'upload-ref-1',
    missing: false,
  };
  const plan = makeExecutionFixture({ operation: 'edit_image', prompt: 'make it blue', resources: [resource] }).dispatchContract;
  const route = inspect(plan, {
    attachments: [{
      type: 'image/png',
      image_id: 'upload-1',
      resource_id: 'res:image:upload-1',
      reference_id: 'upload-ref-1',
      source_index: 1,
      name: 'source.png',
    }],
  });
  assert.strictEqual(route.executionResources.images[0].key, 'r1');
  assert.strictEqual(route.executionResources.images[0].id, 'upload-1');
  assert.strictEqual(route.executionResources.images[0].resource_id, 'res:image:upload-1');
  const media = submitHelpers.projectRouteExecutionMedia(route, pools({
    current: [{
      type: 'image/png',
      imageId: 'upload-1',
      resource_id: 'res:image:upload-1',
      referenceId: 'upload-ref-1',
      name: 'source.png',
    }],
  }));
  assert.strictEqual(media.targets.length, 1);
  assert.strictEqual(media.targets[0].routeResourceKey, 'r1');
  assert.strictEqual(media.targets[0].routeResourceId, 'res:image:upload-1');
}

function localRouteDraft({ operation, prompt, bindings = [], relation = 'new' } = {}) {
  return {
    operation,
    relation,
    arguments: { prompt },
    bindings,
    constraints: [],
  };
}

function testModelImageRoleAliasesAreCanonicalizedBeforeImageDispatch() {
  const prompt = '这个图给我美化一下';
  const aliases = ['source_image', 'input_image', 'image_to_edit', '参考图'];
  for (const role of aliases) {
    const route = inspect(localRouteDraft({
      operation: 'edit_image',
      api: 'image_edit',
      prompt,
      bindings: [{
        key: 'r1', type: 'image', role,
        resource_id: 'res:image:upload-role-alias', source: 'current',
      }],
    }), {
      attachments: [{
        type: 'image/png', image_id: 'upload-role-alias',
        resource_id: 'res:image:upload-role-alias', source_index: 1,
        name: 'beautify.png',
      }],
    });
    assert.strictEqual(route.executionResources.images[0].role, 'target', role);
    assert.strictEqual(route.executionResources.targets.length, 1, role);
    assert.strictEqual(route.executionResources.imageInputs.length, 1, role);
    assert.strictEqual(route.dispatchContract.bindings[0].role, 'target', role);

    const media = submitHelpers.projectRouteExecutionMedia(route, pools({
      current: [{
        type: 'image/png', imageId: 'upload-role-alias',
        resource_id: 'res:image:upload-role-alias', name: 'beautify.png',
      }],
    }));
    const authorized = imageExecution.createImageExecutionPolicy({ dispatchContract }).requireCanonicalImageExecution(
      route.dispatchContract,
      media,
    );
    assert.strictEqual(authorized.api, 'image_edit', role);
    assert.strictEqual(authorized.imageInputs.length, 1, role);
  }
}

function testUnknownLocalBindingRoleFailsClosed() {
  const prompt = '这个图给我美化一下';
  assert.throws(() => routeService.compileLocalRoute(localRouteDraft({
    operation: 'edit_image',
    prompt,
    bindings: [{
      key: 'r1', type: 'image', role: 'invented_visual_role',
      resource_id: 'res:image:upload-unknown-role', source: 'current',
    }],
  }), {
    input: prompt,
    attachments: [{
      type: 'image/png', image_id: 'upload-unknown-role',
      resource_id: 'res:image:upload-unknown-role', source_index: 1,
    }],
    context: {},
  }), /Unsupported image binding role/);
}

function testImageEditWithoutAResourceFailsClosedBeforeDispatch() {
  const prompt = '这个图给我美化一下';
  const route = routeService.compileLocalRoute(localRouteDraft({
    operation: 'edit_image',
    prompt,
    bindings: [],
  }), {
    input: prompt,
    attachments: [],
    context: {},
  });
  assert.strictEqual(route.readiness, 'needs_clarification');
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.deepStrictEqual(route.clarificationSlots, [{
    key: 'r1', type: 'image', role: 'target', reason: 'missing', choices: [],
  }]);
}

function testArgumentClarificationUsesCanonicalParameterSlotsAndReplaysTheSelection() {
  const prompt = '画一只猫，尺寸 1024x1024 和 1024x1536';
  const draft = localRouteDraft({ operation: 'text_to_image', prompt });
  const route = inspect(draft);
  const [slot] = route.clarificationSlots;

  assert.strictEqual(route.needClarification, true);
  assert.deepStrictEqual({
    key: slot.key,
    type: slot.type,
    role: slot.role,
    parameter_name: slot.parameter_name,
    choices: slot.choices.map(choice => ({ key: choice.key, value: choice.value })),
  }, {
    key: 'p1',
    type: 'parameter',
    role: 'argument',
    parameter_name: 'size',
    choices: [
      { key: 'v1', value: '1024x1024' },
      { key: 'v2', value: '1024x1536' },
    ],
  });

  const pending = clarificationAnswer.createPendingClarification({
    id: 'clarify-size',
    messages: [{ role: 'user', content: prompt }],
    clarificationText: route.clarificationQuestion,
    routeInfo: route,
  });
  const answer = clarificationAnswer.createClarificationAnswer({
    clarificationId: pending.id,
    answers: [{ resource_key: slot.key, choice_key: 'v2' }],
    freeText: '选择竖图',
  });
  const applied = clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
  assert.strictEqual(applied.complete, true);
  assert.deepStrictEqual(applied.application.selectedParameters, { size: '1024x1536' });

  const resumed = routeService.compileLocalRoute(draft, {
    input: prompt,
    attachments: [],
    context: clarificationAnswer.buildClarificationRouteContext({ pending: applied.pending }),
  });
  assert.strictEqual(resumed.needClarification, false);
  assert.strictEqual(routeService.isRouteDispatchable(resumed), true);
  assert.strictEqual(resumed.dispatchContract.arguments.size, '1024x1536');
}

function testResolvedImageChoiceSeedsTheRerouteCatalogAndExecutionMedia() {
  const prompt = '把猫的颜色换成橙色';
  const selectedImage = {
    id: 'img_imgref_cat-result_1',
    resource_id: 'res:image:img_imgref_cat-result_1',
    reference_id: 'imgref_cat-result',
    source: 'history',
    index: 3,
    label: '一只猫',
  };
  const pending = clarificationAnswer.createPendingClarification({
    id: 'clarify-cat',
    messages: [{ role: 'user', content: prompt }],
    clarificationText: '请选择要修改的图片。',
    routeInfo: {
      operationType: 'image_reference_gen',
      relation: 'followup',
      resources: [],
      clarificationSlots: [{
        key: 'r1', type: 'image', role: 'reference', reason: 'ambiguous', choices: [{
          key: 'c1', ...selectedImage,
        }],
      }],
    },
  });
  const answer = clarificationAnswer.createClarificationAnswer({
    clarificationId: pending.id,
    answers: [{ resource_key: 'r1', choice_key: 'c1' }],
    freeText: '猫',
  });
  const applied = clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
  const clarificationContext = clarificationAnswer.buildClarificationRouteContext({
    baseContext: {},
    pending: applied.pending,
  });

  assert.deepStrictEqual(clarificationContext.image_candidates.map(candidate => ({
    image_id: candidate.image_id,
    resource_id: candidate.resource_id,
    reference_id: candidate.reference_id,
    source: candidate.source,
  })), [{
    image_id: selectedImage.id,
    resource_id: selectedImage.resource_id,
    reference_id: selectedImage.reference_id,
    source: 'history',
  }], 'the selected image must survive the empty-context answer handoff');

  const route = routeService.compileLocalRoute(localRouteDraft({
    operation: 'image_reference_gen',
    relation: 'followup',
    prompt,
  }), {
    input: prompt,
    attachments: [],
    context: clarificationContext,
  });
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
  assert.deepStrictEqual(route.executionResources.imageInputs.map(image => image.id), [selectedImage.id]);

  const media = submitHelpers.projectRouteExecutionMedia(route, pools({
    history: [{
      type: 'image/png',
      imageId: selectedImage.id,
      resource_id: selectedImage.resource_id,
      referenceId: selectedImage.reference_id,
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }],
  }));
  assert.strictEqual(media.imageInputs.length, 1);
  assert.strictEqual(media.imageInputs[0].routeResourceId, selectedImage.resource_id);
}

function testResolvedClarificationPreservesEstablishedBindingsWithoutModelReplay() {
  const prompt = '把猫和鱼合并成一张图';
  const established = {
    key: 'r1', type: 'image', role: 'reference', source: 'history', index: 1,
    id: 'img-cat', resource_id: 'res:image:img-cat', reference_id: 'ref-cat', label: '猫',
  };
  const pending = clarificationAnswer.createPendingClarification({
    id: 'clarify-compose',
    messages: [{ role: 'user', content: prompt }],
    clarificationText: '请选择鱼。',
    routeInfo: {
      operationType: 'image_reference_gen', relation: 'followup', resources: [established],
      clarificationSlots: [{
        key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous', choices: [{
          key: 'c1', source: 'history', index: 2, id: 'img-fish',
          resource_id: 'res:image:img-fish', reference_id: 'ref-fish', label: '彩色鱼',
        }],
      }],
    },
  });
  const answer = clarificationAnswer.createClarificationAnswer({
    clarificationId: pending.id, answers: [{ resource_key: 'r2', choice_key: 'c1' }], freeText: '彩色鱼',
  });
  const applied = clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
  const context = clarificationAnswer.buildClarificationRouteContext({ pending: applied.pending });

  const route = routeService.compileLocalRoute({
    operation: 'image_reference_gen', relation: 'followup', arguments: { prompt }, bindings: [], constraints: [],
  }, { input: prompt, attachments: [], context });

  assert.strictEqual(routeService.isRouteDispatchable(route), true);
  assert.deepStrictEqual(route.resources.map(resource => ({ key: resource.key, id: resource.id, role: resource.role })), [
    { key: 'r1', id: 'img-cat', role: 'reference' },
    { key: 'r2', id: 'img-fish', role: 'reference' },
  ], 'the local replay must retain established bindings even when the model draft repeats none of them');
}

function testFileInputRoleAliasIsCanonicalizedToAttachment() {
  const prompt = '这是什么';
  const route = inspect(localRouteDraft({
    operation: 'file_qa',
    api: 'chat',
    prompt,
    bindings: [{
      key: 'r1', type: 'file', role: 'input_file',
      resource_id: 'res:file:notes-role-alias', source: 'current',
    }],
  }), {
    attachments: [{
      type: 'text/plain', file_id: 'notes-role-alias',
      resource_id: 'res:file:notes-role-alias', source_index: 1,
      name: 'notes.txt',
    }],
  });
  assert.strictEqual(route.executionResources.files[0].role, 'attachment');
  assert.strictEqual(route.dispatchContract.bindings[0].role, 'attachment');
}

function testModelImageSelectionRemainsAuthoritativeOverInputIndex() {
  const intent = {
    operation: 'edit_image',
    relation: 'new',
    goal: '将所选图片变成黑白。',
    resource_refs: [{ candidate_key: 'i2', role: 'target' }],
  };
  const result = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input: '编辑第1张，把它变成黑白',
    attachments: [
      { type: 'image/png', image_id: 'image-1', resource_id: 'res:image:image-1', index: 1, source_index: 1, name: 'first.png' },
      { type: 'image/png', image_id: 'image-2', resource_id: 'res:image:image-2', index: 2, source_index: 2, name: 'second.png' },
    ],
    context: {},
  });
  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.readiness, 'ready');
  assert.strictEqual(result.route.dispatchAuthorized, true);
  assert.deepStrictEqual(result.route.executionResources.targets.map(resource => resource.id), ['image-2']);
}

function testModelFileSelectionRemainsAuthoritativeOverInputIndex() {
  const intent = {
    operation: 'file_qa',
    relation: 'new',
    goal: '总结所选文件。',
    resource_refs: [{ candidate_key: 'f2', role: 'attachment' }],
  };
  const result = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input: 'summarize file 1',
    attachments: [
      { type: 'application/pdf', file_id: 'file-1', resource_id: 'res:file:file-1', index: 1, source_index: 1, name: 'first.pdf', has_extracted_text: true },
      { type: 'application/pdf', file_id: 'file-2', resource_id: 'res:file:file-2', index: 2, source_index: 2, name: 'second.pdf', has_extracted_text: true },
    ],
    context: {},
  });
  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.readiness, 'ready');
  assert.strictEqual(result.route.dispatchAuthorized, true);
  assert.deepStrictEqual(result.route.executionResources.files.map(resource => resource.id), ['file-2']);
}

function testModelCandidateKeyIsAuthoritativeAndUnknownKeyFailsClosed() {
  const attachments = [
    { type: 'image/png', image_id: 'image-1', resource_id: 'res:image:image-1', index: 1, source_index: 1, name: 'first.png' },
    { type: 'image/png', image_id: 'image-2', resource_id: 'res:image:image-2', index: 2, source_index: 2, name: 'second.png' },
  ];
  const selected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'new',
    goal: '将所选图片变成黑白。',
    resource_refs: [{ candidate_key: 'i2', role: 'target' }],
  }), {
    input: 'edit res:image:image-1 and make it monochrome', attachments, context: {},
  });
  assert.ok(selected.route, selected.error || selected.reason);
  assert.strictEqual(selected.route.readiness, 'ready');
  assert.deepStrictEqual(selected.route.executionResources.targets.map(resource => resource.id), ['image-2']);

  const missing = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'new',
    goal: '将所选图片变成黑白。',
    resource_refs: [{ candidate_key: 'i9', role: 'target' }],
  }), {
    input: 'edit res:image:image-1 and make it monochrome', attachments, context: {},
  });
  assert.ok(missing.route, missing.error || missing.reason);
  assert.strictEqual(missing.route.readiness, 'needs_clarification');
  assert.strictEqual(missing.route.dispatchAuthorized, false);
}

function testModelFileSelectionRemainsAuthoritativeOverFilename() {
  const intent = {
    operation: 'file_qa',
    relation: 'new',
    goal: '总结所选文件。',
    resource_refs: [{ candidate_key: 'f2', role: 'attachment' }],
  };
  const result = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input: 'summarize first-report.pdf',
    attachments: [
      { type: 'application/pdf', file_id: 'file-1', resource_id: 'res:file:file-1', index: 1, source_index: 1, name: 'first-report.pdf', has_extracted_text: true },
      { type: 'application/pdf', file_id: 'file-2', resource_id: 'res:file:file-2', index: 2, source_index: 2, name: 'second-report.pdf', has_extracted_text: true },
    ],
    context: {},
  });
  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.readiness, 'ready');
  assert.deepStrictEqual(result.route.executionResources.files.map(resource => resource.id), ['file-2']);
}

function testModelBoundaryRejectsDispatchContractProtocol() {
  const result = routeService.inspectModelRouteResult(JSON.stringify(localRouteDraft({
    operation: 'plain_chat', api: 'chat', prompt: 'hello', bindings: [],
  })), { input: 'hello', attachments: [], context: {} });
  assert.strictEqual(result.route, null);
  assert.strictEqual(result.reason, 'route_intent_invalid');
}

function testFileBindingProjectsThroughTheSameCanonicalProjection() {
  const resource = {
    key: 'r1',
    type: 'file',
    source: 'current',
    role: 'attachment',
    index: 1,
    id: 'notes-1',
    resource_id: 'res:file:notes-1',
    reference_id: '',
    missing: false,
  };
  const plan = makeExecutionFixture({ operation: 'file_qa', prompt: 'summarize the file', resources: [resource] }).dispatchContract;
  const route = inspect(plan, {
    attachments: [{
      type: 'text/plain',
      file_id: 'notes-1',
      resource_id: 'res:file:notes-1',
      source_index: 1,
      name: 'notes.txt',
    }],
  });
  const media = submitHelpers.projectRouteExecutionMedia(route, pools({
    current: [{
      type: 'text/plain',
      fileId: 'notes-1',
      resource_id: 'res:file:notes-1',
      name: 'notes.txt',
    }],
  }));
  assert.strictEqual(media.files.length, 1);
  assert.strictEqual(media.files[0].routeResourceKey, 'r1');
  assert.strictEqual(media.chatFiles[0].routeResourceId, 'res:file:notes-1');
}

function testProjectionFailsClosedWhenTheModelBindsAnUnknownResource() {
  const plan = makeExecutionFixture({
    operation: 'edit_image',
    prompt: 'edit it',
    resources: [{
      key: 'r1', type: 'image', source: 'current', role: 'target', index: 1,
      id: 'missing-image', resource_id: 'res:image:missing-image', reference_id: '', missing: false,
    }],
  }).dispatchContract;
  const route = routeService.compileLocalRoute(plan, {
    input: 'edit it',
    attachments: [{ type: 'image/png', image_id: 'other-image', resource_id: 'res:image:other-image', source_index: 1 }],
    context: {},
  });
  assert.strictEqual(route.readiness, 'needs_clarification');
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.deepStrictEqual(route.clarificationSlots, [{
    key: 'r1', type: 'image', role: 'target', reason: 'missing', choices: [],
  }]);
}

function testLocalRouteDraftCompilesToCanonicalDispatchContract() {
  const route = inspect({
    operation: 'plain_chat',
    relation: 'new',
    arguments: { prompt: 'hello' },
    bindings: [],
    constraints: [],
  });
  assert.strictEqual(dispatchContract.hasExactDispatchContract(route.dispatchContract), true);
  assert.match(route.dispatchContract.idempotency_key, /^ep1-/);
  assert.deepStrictEqual(route.dispatchContract.arguments, { prompt: 'hello' });
}

function testModelSelectedQuotedImageProjectsWithoutLocalFallback() {
  const quotedImage = {
    type: 'image/png',
    imageId: 'quoted-image-1',
    resource_id: 'res:image:quoted-image-1',
    referenceId: 'quoted-ref-1',
    name: 'quoted.png',
  };
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_qa',
    relation: 'followup',
    goal: '分析所选引用图片。',
    resource_refs: [{ candidate_key: 'i2', role: 'source' }],
  }), {
    input: '这个呢',
    attachments: [{
      type: 'image/png',
      image_id: 'current-image-1',
      resource_id: 'res:image:current-image-1',
      routeSource: 'current',
    }],
    context: {
      quoted_message: { index: 1, role: 'assistant', id: 'quoted-message-1' },
      image_candidates: [
        {
          index: 1,
          image_id: 'quoted-image-1',
          resource_id: 'res:image:quoted-image-1',
          reference_id: 'quoted-ref-1',
          source: 'quoted',
        },
        {
          index: 2,
          image_id: 'history-image-1',
          resource_id: 'res:image:history-image-1',
          reference_id: 'history-ref-1',
          source: 'history',
        },
      ],
    },
  });

  assert.ok(result.route, result.error || result.reason);
  const route = result.route;
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
  assert.strictEqual(route.operationType, 'image_qa');
  assert.strictEqual(route.relation, 'followup');
  assert.deepStrictEqual(route.executionResources.images.map(resource => ({
    id: resource.id,
    resource_id: resource.resource_id,
    source: resource.source,
    role: resource.role,
  })), [{
    id: 'quoted-image-1',
    resource_id: 'res:image:quoted-image-1',
    source: 'quoted',
    role: 'source',
  }]);

  const media = submitHelpers.projectRouteExecutionMedia(route, pools({
    current: [{
      type: 'image/png', imageId: 'current-image-1', resource_id: 'res:image:current-image-1', name: 'current.png',
    }],
    quoted: [quotedImage],
    history: [{
      type: 'image/png', imageId: 'history-image-1', resource_id: 'res:image:history-image-1', name: 'history.png',
    }],
  }));
  assert.strictEqual(media.chatImages.length, 1);
  assert.strictEqual(media.chatImages[0].imageId, 'quoted-image-1');
  assert.strictEqual(media.chatImages[0].routeSource, 'quoted');
}

module.exports = [
  testRouteContractDeclaresCanonicalBindingRoles,
  testPlainChatAlwaysCarriesAnEmptyCanonicalProjection,
  testMessageBoundFollowupProjectsWhenSessionMessagesAreSupplied,
  testTextToImageWithoutInputsIsDispatchableAndImageAuthorized,
  testCurrentImageBindingProjectsByCanonicalIdentity,
  testModelImageRoleAliasesAreCanonicalizedBeforeImageDispatch,
  testUnknownLocalBindingRoleFailsClosed,
  testImageEditWithoutAResourceFailsClosedBeforeDispatch,
  testArgumentClarificationUsesCanonicalParameterSlotsAndReplaysTheSelection,
  testResolvedImageChoiceSeedsTheRerouteCatalogAndExecutionMedia,
  testResolvedClarificationPreservesEstablishedBindingsWithoutModelReplay,
  testFileInputRoleAliasIsCanonicalizedToAttachment,
  testModelImageSelectionRemainsAuthoritativeOverInputIndex,
  testModelFileSelectionRemainsAuthoritativeOverInputIndex,
  testModelCandidateKeyIsAuthoritativeAndUnknownKeyFailsClosed,
  testModelFileSelectionRemainsAuthoritativeOverFilename,
  testModelBoundaryRejectsDispatchContractProtocol,
  testFileBindingProjectsThroughTheSameCanonicalProjection,
  testProjectionFailsClosedWhenTheModelBindsAnUnknownResource,
  testLocalRouteDraftCompilesToCanonicalDispatchContract,
  testModelSelectedQuotedImageProjectsWithoutLocalFallback,
];


