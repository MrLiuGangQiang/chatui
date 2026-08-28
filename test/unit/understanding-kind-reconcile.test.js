'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const submitHelpers = require('../../client/app/submit-workflow.helpers');

function understanding(overrides = {}) {
  return {
    schema_version: 'intent_understanding.v1',
    dependency: 'followup',
    actions: [{
      index: 1,
      kind: 'file_read',
      target: '统计引用消息的文字数量',
      resolved_refs: [{ candidate_key: 'm1', text: '我是 OpenAI 的 ChatGPT。当前对话中我无法直接查看或确认具体的底层模型版本。' }],
    }],
    ...overrides,
  };
}

function quotedContext(text = '我是 OpenAI 的 ChatGPT。当前对话中我无法直接查看或确认具体的底层模型版本。') {
  return {
    recent_messages: [{ index: 1, role: 'assistant', content: text }],
    quoted_message: { index: 1, role: 'assistant', content: text },
  };
}

// A message-only catalog cannot satisfy file_read. The understanding node
// mislabeled "统计引用消息字数" as file_read; the deterministic kind
// reconciliation must downgrade it to plain_text so the route classifies the
// turn as plain_chat instead of file_qa asking for a file.
function testFileReadDowngradesToPlainTextWhenNoFileCandidateExists() {
  const inspected = routeService.inspectUnderstandingResult(JSON.stringify(understanding()), {
    input: '这有多少字',
    attachments: [],
    context: quotedContext(),
  });

  assert.ok(inspected.understanding, inspected.reason);
  assert.strictEqual(inspected.understanding.actions[0].kind, 'plain_text',
    'file_read without any file candidate must be reconciled to plain_text');
  assert.deepStrictEqual(inspected.understanding.actions[0].resolved_refs,
    [{ candidate_key: 'm1', text: '我是 OpenAI 的 ChatGPT。当前对话中我无法直接查看或确认具体的底层模型版本。' }],
    'the quoted message ref must survive as context evidence');

  const shape = routeService.compileUnderstandingShape(inspected.understanding.actions, '这有多少字');
  assert.strictEqual(shape.operation, 'plain_chat');
  assert.strictEqual(shape.taskShape, 'single');
}

// A current/quoted file candidate keeps file_read: a file task is still
// possible even when the model forgot to bind it in resolved_refs.
function testFileReadStaysWhenFileCandidateExists() {
  const inspected = routeService.inspectUnderstandingResult(JSON.stringify(understanding({
    actions: [{
      index: 1,
      kind: 'file_read',
      target: '总结这个文件',
      resolved_refs: [],
    }],
  })), {
    input: '总结这个文件',
    attachments: [{
      id: 'file-1', fileId: 'file-1', type: 'text/markdown', name: 'plan.md', is_image: false,
    }],
    context: {},
  });

  assert.ok(inspected.understanding, inspected.reason);
  assert.strictEqual(inspected.understanding.actions[0].kind, 'file_read',
    'a catalog containing a file must keep the file_read kind');
}

function testFileReadStaysWhenFileRefBound() {
  const inspected = routeService.inspectUnderstandingResult(JSON.stringify(understanding({
    actions: [{
      index: 1,
      kind: 'file_read',
      target: '总结这个文件',
      resolved_refs: [{ candidate_key: 'f1', text: 'plan.md' }],
    }],
  })), {
    input: '总结这个文件',
    attachments: [{
      id: 'file-1', fileId: 'file-1', type: 'text/markdown', name: 'plan.md', is_image: false,
    }],
    context: {},
  });

  assert.ok(inspected.understanding, inspected.reason);
  assert.strictEqual(inspected.understanding.actions[0].kind, 'file_read',
    'a bound file ref must keep the file_read kind');
}

function testImageReadDowngradesToPlainTextWhenNoImageCandidateExists() {
  const inspected = routeService.inspectUnderstandingResult(JSON.stringify(understanding({
    actions: [{
      index: 1,
      kind: 'image_read',
      target: '描述一下这条消息配图',
      resolved_refs: [{ candidate_key: 'm1', text: '配图' }],
    }],
  })), {
    input: '描述一下这条消息配图',
    attachments: [],
    context: quotedContext(),
  });

  assert.ok(inspected.understanding, inspected.reason);
  assert.strictEqual(inspected.understanding.actions[0].kind, 'plain_text',
    'image_read without any image candidate must be reconciled to plain_text');
}


// Raw route intent must never bind a message as a file. file_qa + m1/attachment
// is a deterministic contradiction that enters the repair loop.
function testRouteIntentForIntentFlagsMessageAsAttachment() {
  const issues = routeService.routeIntentSemanticIssuesForIntent(JSON.stringify({
    operation: 'file_qa',
    relation: 'followup',
    goal: '统计引用消息的文字数量',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'm1', role: 'attachment' }],
    task_shape: 'single',
  }));
  const codes = issues.map(issue => issue.code);
  assert.ok(codes.includes('route_message_ref_role_invalid'), 'm1/attachment must be flagged, got ' + JSON.stringify(codes));
  assert.ok(codes.includes('route_operation_requires_file'), 'file_qa without a file ref must be flagged, got ' + JSON.stringify(codes));
}

function testRouteIntentForIntentAcceptsCorrectedPlainChat() {
  assert.deepStrictEqual(routeService.routeIntentSemanticIssuesForIntent(JSON.stringify({
    operation: 'plain_chat',
    relation: 'followup',
    goal: '统计引用消息的文字数量',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'm1', role: 'context' }],
    task_shape: 'single',
  })), [], 'plain_chat + m1/context must be valid');
}

function testRouteIntentForIntentAcceptsFileQaWithFileRef() {
  assert.deepStrictEqual(routeService.routeIntentSemanticIssuesForIntent(JSON.stringify({
    operation: 'file_qa',
    relation: 'new',
    goal: '总结这个文件',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
    task_shape: 'single',
  })), [], 'file_qa + f1/attachment must be valid');
}


async function testWorkflowRepairsMessageAsAttachmentRoute() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '这有多少字';
  const quotedText = '我是 OpenAI 的 ChatGPT。当前对话中我无法直接查看或确认具体的底层模型版本。';
  const quotedMessage = { id: 'quote-1', role: 'assistant', content: quotedText };
  const quoteContext = submitHelpers.buildQuotedRouteContext({ quotedMessage, currentInput: input }).context;
  const context = submitHelpers.mergeQuotedRouteContext({ recent_messages: [{ index: 1, role: 'assistant', content: quotedText }] }, quoteContext);
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || ''));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({
          schema_version: 'intent_understanding.v1',
          dependency: 'followup',
          actions: [{ index: 1, kind: 'file_read', target: '统计引用消息的文字数量', resolved_refs: [{ candidate_key: 'm1', text: '我是 OpenAI 的 ChatGPT。当前对话中我无法直接查看或确认具体的底层模型版本。' }] }],
        }) };
      }
      const routeCalls = calls.filter(item => item === 'intent_recognition' || item === 'route_repair').length;
      if (routeCalls === 1) {
        return { output_text: JSON.stringify({
          operation: 'file_qa', relation: 'followup', goal: '统计引用消息的文字数量',
          goal_mode: 'replace', resource_refs: [{ candidate_key: 'm1', role: 'attachment' }], task_shape: 'single',
        }) };
      }
      return { output_text: JSON.stringify({
        operation: 'plain_chat', relation: 'followup', goal: '统计引用消息的文字数量',
        goal_mode: 'replace', resource_refs: [{ candidate_key: 'm1', role: 'context' }], task_shape: 'single',
      }) };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, [], 'session-1', null, context, { currentTurn: { messageIndex: 19 } });
    assert.ok(calls.includes('route_repair'), 'file_qa with a message-as-attachment must enter the repair loop, calls=' + JSON.stringify(calls));
    assert.strictEqual(route.operationType, 'plain_chat');
    assert.strictEqual(route.needClarification, false);
    assert.strictEqual(route.dispatchContract?.operation, 'plain_chat');
    assert.strictEqual(route.relation, 'followup');
    assert.strictEqual(route.dispatchContract?.context_policy?.quoted, true, 'the quoted message must flow through the chat context policy');
    assert.strictEqual(route.dispatchContract?.context_policy?.history, 'bound_only');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


// No refs at all: the model did not confuse a message with a file. Keep the
// resource kind so the normal missing-resource clarification asks for the
// actual file instead of silently degrading the task to plain text.
function testFileReadWithoutRefsStaysWhenNoFileCandidateExists() {
  const inspected = routeService.inspectUnderstandingResult(JSON.stringify(understanding({
    actions: [{
      index: 1,
      kind: 'file_read',
      target: '读一下这个文件',
      resolved_refs: [],
    }],
  })), {
    input: '读一下这个文件',
    attachments: [],
    context: {},
  });

  assert.ok(inspected.understanding, inspected.reason);
  assert.strictEqual(inspected.understanding.actions[0].kind, 'file_read',
    'a ref-less file_read must not be silently downgraded to plain_text');
}


// A plain_text action that binds a real file ref is incoherent: plain_text only
// carries message/context evidence. The deterministic kind reconciliation must
// promote it to file_read so the multi-task plan expects file_qa (summary),
// not plain_chat, and the 1:1 faithfulness check can align.
function testPlainTextWithFileRefPromotesToFileRead() {
  const inspected = routeService.inspectUnderstandingResult(JSON.stringify(understanding({
    actions: [{
      index: 1,
      kind: 'plain_text',
      target: '对引言.docx进行几句话总结',
      resolved_refs: [{ candidate_key: 'f1', text: '引言.docx' }],
    }, {
      index: 2,
      kind: 'image_generate',
      target: '一只猫',
      resolved_refs: [],
    }],
  })), {
    input: '几句话总结一下 之后给我画一只猫',
    attachments: [{ id: 'file-1', fileId: 'file-1', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: '引言.docx', is_image: false }],
    context: {},
  });

  assert.ok(inspected.understanding, inspected.reason);
  assert.strictEqual(inspected.understanding.actions[0].kind, 'file_read',
    'plain_text bound to a file ref must be promoted to file_read');
  const shape = routeService.compileUnderstandingShape(inspected.understanding.actions, '几句话总结一下 之后给我画一只猫');
  assert.deepStrictEqual(shape.actions.map(action => action.kind), ['file_read', 'image_generate']);
  assert.strictEqual(shape.taskShape, 'multi');
}

function testPlainTextWithImageRefPromotesToImageRead() {
  const inspected = routeService.inspectUnderstandingResult(JSON.stringify(understanding({
    actions: [{
      index: 1,
      kind: 'plain_text',
      target: '描述一下这张图',
      resolved_refs: [{ candidate_key: 'i1', text: '一张海报' }],
    }],
  })), {
    input: '描述一下这张图',
    attachments: [{ id: 'img-1', imageId: 'img-1', type: 'image/png', name: 'poster.png', is_image: true }],
    context: {},
  });

  assert.ok(inspected.understanding, inspected.reason);
  assert.strictEqual(inspected.understanding.actions[0].kind, 'image_read',
    'plain_text bound to an image ref must be promoted to image_read');
}

function testPlainTextWithoutResourceRefsStaysPlainText() {
  const inspected = routeService.inspectUnderstandingResult(JSON.stringify(understanding({
    actions: [{
      index: 1,
      kind: 'plain_text',
      target: '讲一个笑话',
      resolved_refs: [],
    }],
  })), {
    input: '讲一个笑话',
    attachments: [],
    context: {},
  });

  assert.ok(inspected.understanding, inspected.reason);
  assert.strictEqual(inspected.understanding.actions[0].kind, 'plain_text',
    'a ref-less plain_text stays plain_text');
}


async function testWorkflowMultiTaskPlanPassesFaithfulnessAfterKindReconcile() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '几句话总结一下 之后给我画一只猫';
  const attachments = [{
    index: 1, source_index: 1, media_index: 1, id: 'file-1', file_id: 'file-1',
    name: '引言.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    is_image: false, has_extracted_text: true,
  }];
  const context = {
    file_candidates: [{ index: 1, source_index: 1, source: 'current', file_id: 'file-1', name: '引言.docx', has_extracted_text: true }],
  };
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || ''));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({
          schema_version: 'intent_understanding.v1',
          dependency: 'new',
          actions: [
            { index: 1, kind: 'plain_text', target: '对引言.docx进行几句话总结', resolved_refs: [{ candidate_key: 'f1', text: '引言.docx' }] },
            { index: 2, kind: 'image_generate', target: '一只猫', resolved_refs: [] },
          ],
        }) };
      }
      if (options.requestPurpose === 'intent_recognition') {
        return { output_text: JSON.stringify({
          operation: 'file_qa', relation: 'new', goal: input,
          goal_mode: 'replace', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }], task_shape: 'multi',
        }) };
      }
      // multi_task_planning
      return { output_text: JSON.stringify({
        schema_version: 'multi_task_plan.v1',
        tasks: [
          { key: 't1', operation: 'file_qa', description: '总结引言.docx', goal: '请阅读附件引言.docx，并用几句话总结其核心内容。', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只猫', goal: '生成一张可爱的猫咪图片。', resource_refs: [] },
        ],
      }) };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, attachments, 'session-1', null, context, { currentTurn: { messageIndex: 1 } });
    assert.ok(calls.includes('multi_task_planning'), 'the multi-task planner must run, calls=' + JSON.stringify(calls));
    assert.strictEqual(route.needClarification, true, 'a faithful multi-task plan should ask the user to pick a task');
    assert.ok(Array.isArray(route.multiTaskPlanCompiled));
    assert.ok(route.multiTaskPlanCompiled.length >= 2, 'both the summary and the cat task must be planned');
    assert.strictEqual(route.multiTaskPlanCompiled[1].route.operationType, 'text_to_image',
      'the cat request must stay a text_to_image task, not be degraded to plain_chat');
    assert.doesNotMatch(String(route.clarificationQuestion), /不一致|重试/,
      'the plan must not fail the 1:1 faithfulness gate');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


async function testWorkflowDisjunctionOffersChoiceInsteadOfFailing() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '总结这个文件 然后画一只猫 或者 讲一个笑话';
  const attachments = [{ index: 1, source_index: 1, media_index: 1, id: 'file-1', file_id: 'file-1', name: '引言.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', is_image: false, has_extracted_text: true }];
  const context = { file_candidates: [{ index: 1, source_index: 1, source: 'current', file_id: 'file-1', name: '引言.docx', has_extracted_text: true }] };
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || ''));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', dependency: 'new', actions: [
          { index: 1, kind: 'plain_text', target: '对引言.docx进行几句话总结', resolved_refs: [{ candidate_key: 'f1', text: '引言.docx' }] },
          { index: 2, kind: 'image_generate', target: '一只猫', resolved_refs: [] },
        ] }) };
      }
      if (options.requestPurpose === 'intent_recognition') {
        return { output_text: JSON.stringify({ operation: 'file_qa', relation: 'new', goal: input, goal_mode: 'replace', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }], task_shape: 'multi' }) };
      }
      // An unfaithful plan: the model degrades the cat into a joke and adds a third task.
      return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
        { key: 't1', operation: 'file_qa', description: '总结引言.docx', goal: '请阅读附件引言.docx，并用几句话总结其核心内容。', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
        { key: 't2', operation: 'plain_chat', description: '讲一个笑话', goal: '讲一个笑话', resource_refs: [] },
        { key: 't3', operation: 'text_to_image', description: '画一只猫', goal: '生成一张可爱的猫咪图片', resource_refs: [] },
      ] }) };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, attachments, 'session-1', null, context, { currentTurn: { messageIndex: 1 } });
    assert.strictEqual(route.needClarification, true, 'a disjunctive multi-task request must offer a choice, not fail');
    assert.strictEqual(route.readiness, 'needs_clarification');
    assert.match(route.clarificationQuestion, /或者/);
    assert.match(route.clarificationQuestion, /识别到 2 个独立任务/);
    assert.doesNotMatch(route.clarificationQuestion, /不一致|重试/, 'disjunction must not produce a rejection');
    assert.ok(Array.isArray(route.multiTaskPlanCompiled));
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


function testBuildFallbackMultiTaskPlanFromActions() {
  const plan = routeService.buildFallbackMultiTaskPlan([
    { index: 1, kind: 'file_read', target: '总结引言.docx', resolved_refs: [{ candidate_key: 'f1', text: '引言.docx' }] },
    { index: 2, kind: 'image_generate', target: '一只猫', resolved_refs: [] },
  ], { input: '总结文件 然后画一只猫' });
  assert.strictEqual(plan.schema_version, 'multi_task_plan.v1');
  assert.strictEqual(plan.tasks.length, 2);
  assert.strictEqual(plan.tasks[0].operation, 'file_qa');
  assert.strictEqual(plan.tasks[0].resource_refs[0].role, 'attachment');
  assert.strictEqual(plan.tasks[1].operation, 'text_to_image');
}

async function testWorkflowMixedMultiStaysOnMultiTaskPath() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '讲一个笑话 然后画一只猫';
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || ''));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', dependency: 'new', actions: [
          { index: 1, kind: 'plain_text', target: '讲一个笑话', resolved_refs: [] },
          { index: 2, kind: 'image_generate', target: '一只猫', resolved_refs: [] },
        ] }) };
      }
      if (options.requestPurpose === 'intent_recognition') {
        // The route model wrongly labels the operation as an image op (mixed multi).
        return { output_text: JSON.stringify({ operation: 'text_to_image', relation: 'new', goal: '画一只猫', goal_mode: 'replace', resource_refs: [], task_shape: 'multi' }) };
      }
      // The planner returns a schema-invalid single-task plan.
      return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
        { key: 't1', operation: 'text_to_image', description: '画一只猫', goal: '画一只猫', resource_refs: [] },
      ] }) };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, [], 'session-1');
    assert.ok(calls.includes('multi_task_planning'), 'must run the multi-task plan, calls=' + JSON.stringify(calls));
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.readiness, 'needs_clarification');
    assert.ok(Array.isArray(route.multiTaskPlanCompiled) && route.multiTaskPlanCompiled.length >= 2,
      'both the joke and the cat must be presented as options');
    const ops = route.multiTaskPlanCompiled.map(item => item.route.operationType);
    assert.ok(ops.includes('plain_chat') && ops.includes('text_to_image'),
      'must present a plain_chat and a text_to_image option, got ' + JSON.stringify(ops));
    assert.doesNotMatch(String(route.clarificationQuestion), /不一致|重试/);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


function testImagePlanEnvelopeIsNotMaterializedAsSingleInstruction() {
  const envelope = {
    operationType: 'edit_image', taskShape: 'multi', readiness: 'ready',
    needClarification: false, dispatchAuthorized: false, dispatchContract: null,
    resources: [], userGoal: '把图1改成黑白',
  };
  assert.strictEqual(routeService.requiresImageInstructionMaterialization(envelope), false,
    'an image_plan envelope must not be materialized as one single image instruction');
}

async function testWorkflowEmptyInputNoResourcesClarifiesWithoutModelCall() {
  const previous = globalThis.ChatUIRouteService; globalThis.ChatUIRouteService = routeService;
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'k', routeModel: 'm', chatModel: 'm' }),
    getSessionRouteModel: () => 'm', getSessionChatModel: () => 'm',
    requestJson: async () => { calls.push('called'); return { output_text: '{}' }; },
  });
  try {
    const route = await workflow.getEffectiveRoute('', [], 's');
    assert.strictEqual(calls.length, 0, 'empty input with no resources must not call any model');
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.readiness, 'needs_clarification');
  } finally { if (previous === undefined) delete globalThis.ChatUIRouteService; else globalThis.ChatUIRouteService = previous; }
}

async function testWorkflowMultiImageReferenceRunsImagePlan() {
  const previous = globalThis.ChatUIRouteService; globalThis.ChatUIRouteService = routeService;
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'k', routeModel: 'm', chatModel: 'm' }),
    getSessionRouteModel: () => 'm', getSessionChatModel: () => 'm',
    requestJson: async (_u, payload, _k, options = {}) => {
      calls.push(String(options.requestPurpose || ''));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', dependency: 'new', actions: [
          { index: 1, kind: 'image_reference', target: '参考图1生成一张新图', resolved_refs: [{ candidate_key: 'i1', text: '图1' }] },
          { index: 2, kind: 'image_reference', target: '参考图2生成一张新图', resolved_refs: [{ candidate_key: 'i2', text: '图2' }] },
        ] }) };
      }
      if (options.requestPurpose === 'intent_recognition') {
        return { output_text: JSON.stringify({ operation: 'image_reference_gen', relation: 'new', goal: '分别参考两张图各生成一张', goal_mode: 'replace', resource_refs: [{ candidate_key: 'i1', role: 'reference' }, { candidate_key: 'i2', role: 'reference' }], task_shape: 'multi' }) };
      }
      // image_planning: two reference tasks
      return { output_text: JSON.stringify({ schema_version: 'image_plan.v1', tasks: [
        { task_type: 'generate', prompt: '基于图1生成一张新图', input_images: [{ candidate_key: 'i1', role: 'reference' }], quality: 'auto', background: 'auto', output_format: 'auto', label: '图1新图' },
        { task_type: 'generate', prompt: '基于图2生成一张新图', input_images: [{ candidate_key: 'i2', role: 'reference' }], quality: 'auto', background: 'auto', output_format: 'auto', label: '图2新图' },
      ] }) };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute('分别参考这两张图各生成一张', [{ index:1, source_index:1, media_index:1, id:'img-1', imageId:'img-1', type:'image/png', name:'图1.png', is_image:true }, { index:2, source_index:2, media_index:2, id:'img-2', imageId:'img-2', type:'image/png', name:'图2.png', is_image:true }], 's');
    assert.ok(calls.includes('image_planning'), 'multi-image reference must run the image plan, calls=' + JSON.stringify(calls));
    assert.ok(!calls.includes('image_instruction_materialization'), 'the envelope must not be materialized as one instruction');
    assert.ok(Array.isArray(route.imagePlan?.tasks) && route.imagePlan.tasks.length >= 2, 'must plan two reference images');
  } finally { if (previous === undefined) delete globalThis.ChatUIRouteService; else globalThis.ChatUIRouteService = previous; }
}


async function testWorkflowEmptyGenerationSubjectClarifies() {
  const previous = globalThis.ChatUIRouteService; globalThis.ChatUIRouteService = routeService;
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'k', routeModel: 'm', chatModel: 'm' }),
    getSessionRouteModel: () => 'm', getSessionChatModel: () => 'm',
    requestJson: async () => ({ output_text: JSON.stringify({ operation: 'text_to_image', relation: 'new', goal: '生成', goal_mode: 'replace', resource_refs: [], task_shape: 'single' }) }),
  });
  try {
    const route = await workflow.getEffectiveRoute('生成', [], 's');
    assert.strictEqual(route.needClarification, true, 'an empty generation subject must clarify, not dispatch');
    assert.strictEqual(route.readiness, 'needs_clarification');
  } finally { if (previous === undefined) delete globalThis.ChatUIRouteService; else globalThis.ChatUIRouteService = previous; }
}



module.exports = [
  testWorkflowEmptyGenerationSubjectClarifies,
  testImagePlanEnvelopeIsNotMaterializedAsSingleInstruction,
  testWorkflowEmptyInputNoResourcesClarifiesWithoutModelCall,
  testWorkflowMultiImageReferenceRunsImagePlan,
  testBuildFallbackMultiTaskPlanFromActions,
  testWorkflowMixedMultiStaysOnMultiTaskPath,
  testWorkflowDisjunctionOffersChoiceInsteadOfFailing,
  testWorkflowMultiTaskPlanPassesFaithfulnessAfterKindReconcile,
  testPlainTextWithFileRefPromotesToFileRead,
  testPlainTextWithImageRefPromotesToImageRead,
  testPlainTextWithoutResourceRefsStaysPlainText,
  testFileReadWithoutRefsStaysWhenNoFileCandidateExists,
  testWorkflowRepairsMessageAsAttachmentRoute,
  testRouteIntentForIntentFlagsMessageAsAttachment,
  testRouteIntentForIntentAcceptsCorrectedPlainChat,
  testRouteIntentForIntentAcceptsFileQaWithFileRef,

  testFileReadDowngradesToPlainTextWhenNoFileCandidateExists,
  testFileReadStaysWhenFileCandidateExists,
  testFileReadStaysWhenFileRefBound,
  testImageReadDowngradesToPlainTextWhenNoImageCandidateExists,
];
