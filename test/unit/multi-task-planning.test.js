'use strict';

function stringValue(value) { return String(value ?? '').trim(); }

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const routePrompts = require('../../client/services/route-prompts');

function multiRoute() {
  return {
    operationType: 'file_qa',
    taskShape: 'multi',
    multiTask: true,
    needClarification: true,
    readiness: 'needs_clarification',
    userGoal: '读完这个文件后再画一只狗',
  };
}

function plan() {
  return {
    schema_version: 'multi_task_plan.v1',
    tasks: [
      { key: 't1', operation: 'file_qa', description: '分析引言.docx', goal: '分析引言.docx的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
      { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
    ],
  };
}

function contextWithFile() {
  return {
    recent_messages: [],
    image_candidates: [],
    file_candidates: [{
      index: 1,
      source_index: 1,
      source: 'current',
      file_id: 'file-current',
      name: 'plan.md',
      has_extracted_text: true,
    }],
  };
}

function testShouldRequestMultiTaskPlanOnlyForNonImageMulti() {
  assert.strictEqual(routeService.shouldRequestMultiTaskPlan(multiRoute()), true);
  assert.strictEqual(routeService.shouldRequestMultiTaskPlan({ ...multiRoute(), operationType: 'text_to_image' }), false,
    'image multi stays on the existing image_plan path');
  assert.strictEqual(routeService.shouldRequestMultiTaskPlan({ ...multiRoute(), multiTask: false }), false);
}

function testCompiledMultiRouteExposesMultiTaskFlag() {
  const input = '读完这个文件之后再画一只狗';
  const attachments = [{
    index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current',
    name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true,
  }];
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'file_qa', relation: 'new', goal: input, goal_mode: 'replace',
    task_shape: 'multi', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
  }), { input, attachments, context: contextWithFile() });
  assert.ok(inspected.route);
  assert.strictEqual(inspected.route.multiTask, true, 'the multi-intent flag must be exposed on the compiled route');
  assert.strictEqual(routeService.shouldRequestMultiTaskPlan(inspected.route), true);
}

async function testWorkflowInvokesMultiTaskPlannerAndListsTasks() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '读完这个文件之后再画一只狗 画完之后再讲一个笑话';
  const attachments = [{
    index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current',
    name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true,
  }];
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || 'intent_recognition'));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', ordering: 'sequential', dependency: 'new', actions: [{"index":1,"kind":"file_read","verb":"读","target":"这个文件","resolved_refs":[{"candidate_key":"f1","text":"这个文件"}]},{"index":2,"kind":"image_generate","verb":"画","target":"一只狗","resolved_refs":[]},{"index":3,"kind":"plain_text","verb":"讲","target":"一个笑话","resolved_refs":[]}] }) };
      }
      if (options.requestPurpose === 'multi_task_planning') {
        return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
          { key: 't1', operation: 'file_qa', description: '分析引言.docx', goal: '分析引言.docx的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
          { key: 't3', operation: 'plain_chat', description: '讲一个笑话', goal: '讲一个笑话', resource_refs: [] },
        ] }) };
      }
      // The route model mis-marks the combined request as single; the
      // understanding Shape Compiler must force the multi-task planner anyway.
      return { output_text: JSON.stringify({ operation: 'file_qa', relation: 'new', goal: input, goal_mode: 'replace', task_shape: 'single', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] }) };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, attachments, 'session-1');
    assert.strictEqual(calls.length, 3, 'the workflow must run understanding, intent recognition, then the multi-task planner');
    assert.strictEqual(route.needClarification, true);
    assert.ok(Array.isArray(route.multiTaskPlanCompiled));
    assert.strictEqual(route.multiTaskPlanCompiled.length, 3);
    assert.match(route.clarificationQuestion, /识别到 3 个独立任务/);
    assert.match(route.clarificationQuestion, /1\. 分析引言\.docx/);
    assert.match(route.clarificationQuestion, /2\. 画一只狗/);
    assert.match(route.clarificationQuestion, /3\. 讲一个笑话/);
    assert.strictEqual(route.multiTaskPlanCompiled[1].route.operationType, 'text_to_image');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

function testMultiTaskPlanPromptAndInspect() {
  assert.ok(routePrompts.createRoutePromptSet().MULTI_TASK_PLAN_SYSTEM_PROMPT.includes('multi_task_plan.v1'),
    'the planner prompt must be available');
  const inspected = routeService.inspectMultiTaskPlan(JSON.stringify(plan()));
  assert.ok(inspected.plan);
  assert.strictEqual(inspected.plan.tasks.length, 2);
  assert.deepStrictEqual(routeService.inspectMultiTaskPlan('not json').plan, null);
}

function testCompileMultiTaskPlanBuildsIndependentExecutableRoutes() {
  const compiled = routeService.compileMultiTaskPlan(plan(), {
    attachments: [{
      index: 1,
      source_index: 1,
      media_index: 1,
      id: 'file-current',
      file_id: 'file-current',
      name: 'plan.md',
      type: 'text/markdown',
      is_image: false,
      has_extracted_text: true,
    }],
    context: contextWithFile(),
  });
  assert.strictEqual(compiled.ok, true, compiled.reason);
  assert.strictEqual(compiled.items.length, 2);
  assert.strictEqual(compiled.items[0].route.operationType, 'file_qa');
  assert.strictEqual(compiled.items[0].route.readiness, 'ready');
  assert.strictEqual(compiled.items[1].route.operationType, 'text_to_image');
  assert.strictEqual(compiled.items[1].route.readiness, 'ready');
}



function testTaskSelectionUsesModelSelectedGoalAsProviderPrompt() {
  const input = '3';
  const context = {
    recent_messages: [],
    image_candidates: [],
    file_candidates: [],
    multi_task_plan: {
      schema_version: 'multi_task_plan.v1',
      tasks: [
        { key: 't3', operation: 'plain_chat', description: '讲一个笑话', goal: '讲一个笑话', resource_refs: [] },
      ],
    },
  };
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat', relation: 'new', goal: '讲一个笑话', goal_mode: 'replace',
    task_shape: 'single', resource_refs: [],
  }), { input, attachments: [], context, currentMode: 'chat', autoMode: true });
  assert.strictEqual(inspected.route.dispatchContract.arguments.prompt, '讲一个笑话',
    'a multi-task selection must execute the model-selected task goal, not the raw selector');
  assert.notStrictEqual(inspected.route.dispatchContract.arguments.prompt, input);
}

function testClarificationContextCarriesMultiTaskPlanForModelSelection() {
  const clarificationAnswer = require('../../shared/clarification-answer');
  const pending = clarificationAnswer.createPendingClarification({
    messages: [],
    clarificationText: '识别到 2 个独立任务',
    routeInfo: {
      multiTaskPlan: {
        schema_version: 'multi_task_plan.v1',
        tasks: [
          { key: 't1', operation: 'file_qa', description: '总结文件', goal: '总结文件', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ],
      },
    },
  });
  const context = clarificationAnswer.buildClarificationRouteContext({ baseContext: {}, pending });
  assert.ok(context.clarification_context.multi_task_plan, 'the task list must be available to intent recognition');
  assert.strictEqual(context.clarification_context.multi_task_plan.tasks.length, 2);
  assert.deepStrictEqual(context.clarification_context.multi_task_plan.tasks[1], {
    index: 2, key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [],
  });
}

function testTaskSelectionKeepsPlanBindingsAndStripsOriginalRequest() {
  const clarificationAnswer = require('../../shared/clarification-answer');
  const pending = clarificationAnswer.createPendingClarification({
    messages: [],
    clarificationText: '请回复要执行的编号',
    routeInfo: {
      multiTaskPlan: {
        schema_version: 'multi_task_plan.v1',
        tasks: [
          { key: 't1', operation: 'file_qa', description: '总结文件', goal: '总结文件', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
          { key: 't3', operation: 'plain_chat', description: '讲一个笑话', goal: '讲一个笑话', resource_refs: [] },
        ],
      },
    },
  });
  const context = clarificationAnswer.buildClarificationRouteContext({
    baseContext: {
      recent_messages: [{ index: 1, role: 'user', content: '原始多任务请求' }],
      image_candidates: [],
      file_candidates: [{ index: 1, source: 'current', file_id: 'file-current', name: 'plan.md' }],
    },
    pending,
  });
  assert.deepStrictEqual(context.recent_messages, [], 'the original multi request must not distract task selection');
  assert.strictEqual(context.file_candidates.length, 1, 'plan-declared media candidates must stay in the catalog for binding resolution');
  assert.strictEqual(context.file_candidates[0].file_id, 'file-current');
  assert.ok(context.multi_task_plan, 'the generated task list must be the primary evidence');
  assert.strictEqual(context.multi_task_plan.tasks[2].description, '讲一个笑话');
}

function testClarificationWireContextRetainsMultiTaskPlan() {
  const clarificationAnswer = require('../../shared/clarification-answer');
  const pending = clarificationAnswer.createPendingClarification({
    messages: [],
    clarificationText: '请回复要执行的编号',
    routeInfo: {
      multiTaskPlan: {
        schema_version: 'multi_task_plan.v1',
        tasks: [
          { key: 't1', operation: 'file_qa', description: '总结文件', goal: '总结文件', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ],
      },
    },
  });
  const context = clarificationAnswer.buildClarificationRouteContext({ baseContext: {}, pending });
  const wire = routeService.compactWireRouteContext(context, '做任务2', []);
  assert.ok(wire.clarification_context.multi_task_plan, 'the task list must reach intent recognition');
  assert.strictEqual(wire.clarification_context.multi_task_plan.tasks.length, 2);
  assert.strictEqual(wire.clarification_context.multi_task_plan.tasks[1].description, '画一只狗');
}

function testRoutePromptDeclaresModelPoweredTaskSelection() {
  const routePrompts = require('../../client/services/route-prompts');
  const prompt = routePrompts.createRoutePromptSet().ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /【任务选择优先】/);
  assert.match(prompt, /只输出multi_task_plan中对应编号任务的operation\/goal\/resource_refs/);
  assert.match(prompt, /task_shape=single/);
}

function testIsTaskSelectionInputRecognizesSelectors() {
  for (const selector of ['3', '做任务1', '任务2', '第2个任务', '选2号', '执行第1项', '2号', '任务二', '二', '第3个任务', '选二号']) {
    assert.strictEqual(routeService.isTaskSelectionInput(selector), true, `${selector} must be a task selector`);
  }
  for (const ordinary of ['做任务1后画一只狗', '请帮我写一份周报', '总结一下', '']) {
    assert.strictEqual(routeService.isTaskSelectionInput(ordinary), false, `${ordinary} must not be a task selector`);
  }
}

function testTaskSelectorUsesResolvedGoalAsProviderPromptWithoutPlan() {
  const input = '做任务1';
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'file_qa', relation: 'new', goal: '总结文件内容', goal_mode: 'replace',
    task_shape: 'single', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
  }), {
    input,
    attachments: [{
      index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current',
      name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true,
    }],
    context: { recent_messages: [], image_candidates: [], file_candidates: [] },
    currentMode: 'chat',
    autoMode: true,
  });
  assert.ok(inspected.route);
  assert.strictEqual(inspected.route.dispatchContract.arguments.prompt, '总结文件内容',
    'a later task-selection turn must execute the intent-resolved task goal, not the raw selector');
  assert.notStrictEqual(inspected.route.dispatchContract.arguments.prompt, input);
}

function testOrdinaryChatStillKeepsRawInputAsProviderPrompt() {
  const input = '请帮我写一份周报';
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat', relation: 'new', goal: '写一份周报', goal_mode: 'replace',
    task_shape: 'single', resource_refs: [],
  }), {
    input,
    attachments: [],
    context: { recent_messages: [], image_candidates: [], file_candidates: [] },
    currentMode: 'chat',
    autoMode: true,
  });
  assert.strictEqual(inspected.route.dispatchContract.arguments.prompt, input,
    'ordinary chat must keep the raw user wording verbatim');
}

async function testWorkflowRetainsPlanAndResolvesLaterSelector() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '一句话总结这个文件之后再画一只狗 画完之后再讲一个笑话';
  const attachments = [{
    index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current',
    name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true,
  }];
  const calls = [];
  const payloads = [];
  const session = { id: 'session-1', messages: [] };
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [session], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      payloads.push(payload);
      calls.push(String(options.requestPurpose || 'intent_recognition'));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', ordering: 'sequential', dependency: 'new', actions: [{"index":1,"kind":"file_read","verb":"读","target":"这个文件","resolved_refs":[{"candidate_key":"f1","text":"这个文件"}]},{"index":2,"kind":"image_generate","verb":"画","target":"一只狗","resolved_refs":[]},{"index":3,"kind":"plain_text","verb":"讲","target":"一个笑话","resolved_refs":[]}] }) };
      }
      if (options.requestPurpose === 'multi_task_planning') {
        return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
          { key: 't3', operation: 'plain_chat', description: '讲一个笑话', goal: '讲一个笑话', resource_refs: [] },
        ] }) };
      }
      return { output_text: JSON.stringify({ operation: 'file_qa', relation: 'new', goal: input, goal_mode: 'replace', task_shape: 'multi', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] }) };
    },
  });
  try {
    const planRoute = await workflow.getEffectiveRoute(input, attachments, 'session-1');
    assert.strictEqual(calls.length, 3, 'the workflow must run understanding, intent recognition, then the multi-task planner');
    assert.ok(planRoute.multiTaskPlan);
    assert.strictEqual(session.multiTaskPlan, planRoute.multiTaskPlan, 'the generated plan must be retained on the session for later selector turns');

    const selectorRoute = await workflow.getEffectiveRoute('做任务1', [], 'session-1', null, {
      recent_messages: [],
      image_candidates: [],
      file_candidates: [{
        index: 1, source: 'history', source_index: 1,
        file_id: 'file-current', name: 'plan.md', has_extracted_text: true, input_file_available: true,
      }],
      clarification_context: { multi_task_plan: session.multiTaskPlan },
    });
    assert.strictEqual(calls.length, 3, 'a task selector must resolve deterministically from the plan without an intent-model call');
    assert.ok(selectorRoute.dispatchContract);
    assert.strictEqual(selectorRoute.operationType, 'file_qa');
    assert.strictEqual(selectorRoute.dispatchContract.arguments.prompt, '总结这个文件的内容',
      'the later selector turn must execute the plan-resolved task goal, not the raw selector');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

function testSelectorTurnPreservesPlanTaskFileBindingWhenModelOmitsRefs() {
  const input = "1";
  const context = {
    recent_messages: [],
    image_candidates: [],
    file_candidates: [{
      index: 1, source: "history", source_index: 1,
      file_id: "file-current", name: "引言.docx",
      has_extracted_text: true, input_file_available: true,
    }],
    clarification_context: {
      multi_task_plan: {
        schema_version: "multi_task_plan.v1",
        tasks: [
          { key: "t1", operation: "file_qa", description: "总结这个文件", goal: "总结这个文件的内容", resource_refs: [{ candidate_key: "f1", role: "attachment" }] },
          { key: "t2", operation: "text_to_image", description: "画一只狗", goal: "画一只狗", resource_refs: [] },
        ],
      },
    },
  };
  // The selector route model resolves the task goal but omits the plan-declared
  // resource_refs (f1 -> attachment). The plan is authoritative for the binding.
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: "file_qa", relation: "new", goal: "总结这个文件的内容", goal_mode: "replace",
    task_shape: "single", resource_refs: [],
  }), { input, attachments: [], context, currentMode: "chat", autoMode: true });
  assert.ok(inspected.route, inspected.error || inspected.reason);
  assert.strictEqual(inspected.route.needClarification, false,
    "a selected file task must keep its plan-declared file binding and not re-prompt for a file");
  const files = inspected.route.executionResources?.files || [];
  assert.strictEqual(files.length, 1, "the plan-bound attachment must be restored");
  assert.strictEqual(stringValue(files[0].resource_id), "res:file:file-current");
}



function selectorPlanContext(planRefs) {
  return {
    recent_messages: [],
    image_candidates: [],
    file_candidates: [{
      index: 1, source: 'history', source_index: 1,
      file_id: 'file-current', name: '引言.md', has_extracted_text: true, input_file_available: true,
    }],
    clarification_context: {
      multi_task_plan: {
        schema_version: 'multi_task_plan.v1',
        tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: planRefs },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ],
      },
    },
  };
}

function testSelectorTurnCanonicalizesPlanFileRoleWhenModelOmitsRefs() {
  // The real planner model emits unstable roles for a file_qa file ("target"
  // in one run, "context" in another). The selected task's binding must be
  // canonicalized to the operation's requirement (attachment) instead of being
  // restored verbatim and rejected by the compiler.
  const context = selectorPlanContext([{ candidate_key: 'f1', role: 'target' }]);
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'file_qa', relation: 'new', goal: '总结这个文件的内容', goal_mode: 'replace',
    task_shape: 'single', resource_refs: [],
  }), { input: '1', attachments: [], context, currentMode: 'chat', autoMode: true });
  assert.ok(inspected.route, inspected.error || inspected.reason);
  assert.strictEqual(inspected.route.needClarification, false,
    'a selected file task must bind its plan-declared file as attachment, not re-prompt for a file');
  const files = inspected.route.executionResources?.files || [];
  assert.strictEqual(files.length, 1);
  assert.strictEqual(stringValue(files[0].role), 'attachment');
  assert.strictEqual(stringValue(files[0].resource_id), 'res:file:file-current');
}

function testSelectorTurnCanonicalizesModelProvidedFileRole() {
  // Even when the selector model emits the plan's unstable role verbatim
  // ("context"), file_qa must bind the file as attachment.
  const context = selectorPlanContext([{ candidate_key: 'f1', role: 'context' }]);
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'file_qa', relation: 'new', goal: '总结这个文件的内容', goal_mode: 'replace',
    task_shape: 'single', resource_refs: [{ candidate_key: 'f1', role: 'context' }],
  }), { input: '1', attachments: [], context, currentMode: 'chat', autoMode: true });
  assert.ok(inspected.route, inspected.error || inspected.reason);
  assert.strictEqual(inspected.route.needClarification, false);
  const files = inspected.route.executionResources?.files || [];
  assert.strictEqual(files.length, 1);
  assert.strictEqual(stringValue(files[0].role), 'attachment');
  assert.strictEqual(stringValue(files[0].resource_id), 'res:file:file-current');
}

function testSelectorTurnKeepsPlanFileBindingThroughRealClarificationContext() {
  const clarificationAnswer = require('../../shared/clarification-answer');
  const pending = clarificationAnswer.createPendingClarification({
    messages: [],
    clarificationText: '识别到 2 个独立任务：\n1. 总结这个文件\n2. 画一只狗\n请回复要执行的编号（一次只执行一个任务）。',
    routeInfo: {
      multiTaskPlan: {
        schema_version: 'multi_task_plan.v1',
        tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ],
      },
    },
  });
  const context = clarificationAnswer.buildClarificationRouteContext({
    baseContext: {
      recent_messages: [{ index: 1, role: 'user', content: '一句话总结这个文件 之后再画一只狗' }],
      image_candidates: [],
      file_candidates: [{
        index: 1, source_index: 1, source: 'history', file_id: 'file-current',
        name: 'plan.md', has_extracted_text: true, input_file_available: true,
      }],
    },
    pending,
  });
  assert.ok(context.multi_task_plan, 'the plan must be the primary evidence');
  assert.strictEqual(context.file_candidates.length, 1,
    'plan-declared media candidates must survive the selector context for binding resolution');
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'file_qa', relation: 'new', goal: '总结这个文件的内容', goal_mode: 'replace',
    task_shape: 'single', resource_refs: [],
  }), { input: '1', attachments: [], context, currentMode: 'chat', autoMode: true });
  assert.ok(inspected.route, inspected.error || inspected.reason);
  assert.strictEqual(inspected.route.needClarification, false,
    'a selected file task must keep its plan-declared file binding and dispatch directly, not re-prompt for a file');
  const files = inspected.route.executionResources?.files || [];
  assert.strictEqual(files.length, 1);
  assert.strictEqual(stringValue(files[0].resource_id), 'res:file:file-current');
}


function testSelectedMultiTaskIndexMapsArabicAndChineseNumerals() {
  for (const [input, expected] of [['2', 2], ['任务二', 2], ['二', 2], ['第3个任务', 3], ['选二号', 2], ['做任务1', 1], ['二十', 20]]) {
    assert.strictEqual(routeService.selectedMultiTaskIndex(input), expected, input);
  }
}

function testCompileSelectedPlanTaskCanonicalizesFileRole() {
  const plan = {
    schema_version: 'multi_task_plan.v1',
    tasks: [
      { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'target' }] },
      { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
    ],
  };
  const compiled = routeService.compileSelectedPlanTask(plan, 1, {
    input: '1',
    attachments: [],
    context: {
      recent_messages: [],
      image_candidates: [],
      file_candidates: [{ index: 1, source: 'history', source_index: 1, file_id: 'file-current', name: 'plan.md', has_extracted_text: true, input_file_available: true }],
    },
    routeCompilationOptions: { currentMode: 'chat', autoMode: true },
  });
  assert.strictEqual(compiled.ok, true, compiled.reason);
  assert.strictEqual(compiled.route.needClarification, false, 'the selected file task must bind without a file clarification');
  const files = compiled.route.executionResources?.files || [];
  assert.strictEqual(files.length, 1);
  assert.strictEqual(stringValue(files[0].role), 'attachment');
  assert.strictEqual(stringValue(files[0].resource_id), 'res:file:file-current');
}

async function testWorkflowSelectorResolvesTaskTwoWithoutModelCall() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '总结这个文件 同时 画一只狗';
  const session = { id: 'session-1', messages: [] };
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [session], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || 'intent_recognition'));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', ordering: 'independent', dependency: 'new', actions: [{"index":1,"kind":"file_read","verb":"总结","target":"这个文件","resolved_refs":[{"candidate_key":"f1","text":"这个文件"}]},{"index":2,"kind":"image_generate","verb":"画","target":"一只狗","resolved_refs":[]}] }) };
      }
      if (options.requestPurpose === 'multi_task_planning') {
        return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ] }) };
      }
      return { output_text: JSON.stringify({ operation: 'file_qa', relation: 'new', goal: '总结这个文件 同时 画一只狗', goal_mode: 'replace', task_shape: 'multi', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] }) };
    },
  });
  try {
    await workflow.getEffectiveRoute(input, [{
      index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current',
      name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true,
    }], 'session-1');
    const selectorRoute = await workflow.getEffectiveRoute('2', [], 'session-1', null, {
      recent_messages: [], image_candidates: [], file_candidates: [],
    });
    assert.strictEqual(calls.length, 3, 'task selection must not call the intent model');
    assert.strictEqual(selectorRoute.operationType, 'text_to_image', 'selecting task 2 must resolve to image generation');
    assert.strictEqual(selectorRoute.needClarification, false);
    assert.ok(selectorRoute.dispatchContract);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

async function testWorkflowInvalidSelectorClarifiesWithoutModelCall() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '总结这个文件 同时 画一只狗';
  const session = { id: 'session-1', messages: [] };
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [session], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || 'intent_recognition'));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', ordering: 'independent', dependency: 'new', actions: [{"index":1,"kind":"file_read","verb":"总结","target":"这个文件","resolved_refs":[{"candidate_key":"f1","text":"这个文件"}]},{"index":2,"kind":"image_generate","verb":"画","target":"一只狗","resolved_refs":[]}] }) };
      }
      if (options.requestPurpose === 'multi_task_planning') {
        return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ] }) };
      }
      return { output_text: JSON.stringify({ operation: 'file_qa', relation: 'new', goal: '总结这个文件 同时 画一只狗', goal_mode: 'replace', task_shape: 'multi', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] }) };
    },
  });
  try {
    await workflow.getEffectiveRoute(input, [{
      index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current',
      name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true,
    }], 'session-1');
    const selectorRoute = await workflow.getEffectiveRoute('5', [], 'session-1', null, {
      recent_messages: [], image_candidates: [], file_candidates: [],
    });
    assert.strictEqual(calls.length, 3, 'an out-of-range selector must not call the intent model');
    assert.strictEqual(selectorRoute.needClarification, true);
    assert.match(selectorRoute.clarificationQuestion, /1 到 2/);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


async function testWorkflowRepairsUnfaithfulMultiTaskPlan() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '总结这个文件 同时 画一只狗';
  const session = { id: 'session-1', messages: [] };
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [session], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || 'intent_recognition'));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({
          schema_version: 'intent_understanding.v1', ordering: 'independent', dependency: 'new',
          actions: [
            { index: 1, kind: 'file_read', verb: '总结', target: '这个文件', resolved_refs: [{ candidate_key: 'f1', text: '这个文件' }] },
            { index: 2, kind: 'image_generate', verb: '画', target: '一只狗', resolved_refs: [] },
          ],
        }) };
      }
      const planningCalls = calls.filter(call => call === 'multi_task_planning').length;
      if (planningCalls >= 2) {
        // The repair round returns a faithful plan.
        return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ] }) };
      }
      if (planningCalls >= 1) {
        // The first planner output is unfaithful (wrong second operation).
        return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'plain_chat', description: '讲一个笑话', goal: '讲一个笑话', resource_refs: [] },
        ] }) };
      }
      return { output_text: JSON.stringify({ operation: 'file_qa', relation: 'new', goal: input, goal_mode: 'replace', task_shape: 'multi', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] }) };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, [{ index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current', name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true }], 'session-1');
    assert.strictEqual(calls.length, 4, 'an unfaithful plan must trigger exactly one repair round before success');
    assert.ok(route.multiTaskPlan, 'the repaired plan must be accepted');
    assert.strictEqual(route.multiTaskPlan.tasks.length, 2);
    assert.strictEqual(route.multiTaskPlan.tasks[1].operation, 'text_to_image');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


async function testWorkflowInjectsUnderstandingAndUsesSlimRoutePrompt() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '总结这个文件 同时 画一只狗';
  const session = { id: 'session-1', messages: [] };
  const payloads = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [session], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      payloads.push({ purpose: options.requestPurpose || 'intent_recognition', payload });
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({
          schema_version: 'intent_understanding.v1', ordering: 'independent', dependency: 'new',
          actions: [
            { index: 1, kind: 'file_read', verb: '总结', target: '这个文件', resolved_refs: [{ candidate_key: 'f1', text: '这个文件' }] },
            { index: 2, kind: 'image_generate', verb: '画', target: '一只狗', resolved_refs: [] },
          ],
        }) };
      }
      if (options.requestPurpose === 'multi_task_planning') {
        return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ] }) };
      }
      return { output_text: JSON.stringify({ operation: 'file_qa', relation: 'new', goal: input, goal_mode: 'replace', task_shape: 'single', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] }) };
    },
  });
  try {
    await workflow.getEffectiveRoute(input, [{ index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current', name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true }], 'session-1');

    const understandingCall = payloads.find(entry => entry.purpose === 'intent_understanding');
    const routeCall = payloads.find(entry => entry.purpose === 'intent_recognition' && entry.payload.text?.format?.name === 'chatui_route_intent_v3');
    assert.ok(understandingCall, 'the understand node must run first');
    assert.ok(routeCall, 'the route node must run after understanding');

    const understandingSystem = understandingCall.payload.input.find(item => item.role === 'system').content;
    const routeSystem = routeCall.payload.input.find(item => item.role === 'system').content;
    assert.match(understandingSystem, /【优先级】/, 'the understand prompt owns the priority/anaphora rules');
    assert.doesNotMatch(routeSystem, /【优先级】/, 'the slim route prompt must not repeat the understand rules');
    assert.match(routeSystem, /【已解析证据】/, 'the slim route prompt must explain the injected understanding evidence');

    const routeUser = JSON.parse(routeCall.payload.input.find(item => item.role === 'user').content);
    assert.ok(routeUser.understanding, 'the route payload must carry the understanding evidence');
    assert.strictEqual(routeUser.understanding.actions.length, 2);
    assert.strictEqual(routeUser.understanding.actions[0].kind, 'file_read');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


async function testWorkflowRepairsInvalidRouteOutputOnce() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '画一只狗';
  const calls = [];
  const stages = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || 'intent_recognition'));
      if (options.requestPurpose === 'intent_recognition') return { output_text: 'not json' };
      if (options.requestPurpose === 'route_repair') {
        return { output_text: JSON.stringify({ operation: 'text_to_image', relation: 'new', goal: input, goal_mode: 'replace', task_shape: 'single', resource_refs: [] }) };
      }
      throw new Error('unexpected call');
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, [], 'session-1', null, null, { onStage: text => stages.push(text) });
    assert.strictEqual(calls.length, 2, 'one invalid route output must trigger exactly one bounded repair round');
    assert.strictEqual(route.operationType, 'text_to_image');
    assert.strictEqual(route.readiness, 'ready');
    assert.ok(stages.includes('正在修正任务识别结果'), 'the repair round must surface the waiting-message stage');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


async function testWorkflowPresentsOptionsWhenPlanRepairStillUnfaithful() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '总结这个文件 同时 画一只狗';
  const session = { id: 'session-1', messages: [] };
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [session], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || 'intent_recognition'));
      if (options.requestPurpose === 'intent_understanding') {
        return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', ordering: 'independent', dependency: 'new', actions: [
          { index: 1, kind: 'file_read', verb: '总结', target: '这个文件', resolved_refs: [{ candidate_key: 'f1', text: '这个文件' }] },
          { index: 2, kind: 'image_generate', verb: '画', target: '一只狗', resolved_refs: [] },
        ] }) };
      }
      if (options.requestPurpose === 'multi_task_planning') {
        return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'plain_chat', description: '讲一个笑话', goal: '讲一个笑话', resource_refs: [] },
        ] }) };
      }
      return { output_text: JSON.stringify({ operation: 'file_qa', relation: 'new', goal: input, goal_mode: 'replace', task_shape: 'multi', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] }) };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, [{ index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current', name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true }], 'session-1');
    assert.strictEqual(calls.length, 4, 'the repair round must still run before the option fallback');
    assert.strictEqual(route.readiness, 'needs_clarification', 'an unfaithful plan must present choices instead of failing closed');
    assert.strictEqual(route.needClarification, true);
    assert.ok(Array.isArray(route.multiTaskPlanCompiled), 'the best-effort plan must still be presented for selection');
    assert.match(route.clarificationQuestion, /识别到 2 个独立任务/);
    assert.match(route.clarificationQuestion, /未完全对齐|确认/);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


async function testWorkflowRepairsInvalidUnderstandingOutputOnce() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '总结这个文件 同时 画一只狗';
  const session = { id: 'session-1', messages: [] };
  const calls = [];
  const stages = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [session], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      calls.push(String(options.requestPurpose || 'intent_recognition'));
      if (options.requestPurpose === 'intent_understanding') {
        const understandingCalls = calls.filter(call => call === 'intent_understanding').length;
        if (understandingCalls === 1) return { output_text: 'not json' };
        return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', ordering: 'independent', dependency: 'new', actions: [
          { index: 1, kind: 'file_read', verb: '总结', target: '这个文件', resolved_refs: [{ candidate_key: 'f1', text: '这个文件' }] },
          { index: 2, kind: 'image_generate', verb: '画', target: '一只狗', resolved_refs: [] },
        ] }) };
      }
      if (options.requestPurpose === 'multi_task_planning') {
        return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ] }) };
      }
      return { output_text: JSON.stringify({ operation: 'file_qa', relation: 'new', goal: input, goal_mode: 'replace', task_shape: 'single', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] }) };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, [{ index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current', name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true }], 'session-1', null, null, { onStage: text => stages.push(text) });
    assert.strictEqual(calls.filter(call => call === 'intent_understanding').length, 2, 'an invalid understanding output must trigger exactly one repair round');
    assert.ok(route.multiTaskPlan, 'the repaired understanding must force the multi-task planner');
    assert.strictEqual(route.multiTaskPlan.tasks.length, 2);
    assert.ok(stages.includes('正在修正任务识别结果'), 'the understanding repair round must surface the waiting-message stage');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

module.exports = [
  testShouldRequestMultiTaskPlanOnlyForNonImageMulti,
  testCompiledMultiRouteExposesMultiTaskFlag,
  testMultiTaskPlanPromptAndInspect,
  testWorkflowInvokesMultiTaskPlannerAndListsTasks,
  testCompileMultiTaskPlanBuildsIndependentExecutableRoutes,
  testClarificationContextCarriesMultiTaskPlanForModelSelection,
  testRoutePromptDeclaresModelPoweredTaskSelection,
  testClarificationWireContextRetainsMultiTaskPlan,
  testTaskSelectionKeepsPlanBindingsAndStripsOriginalRequest,
  testSelectorTurnCanonicalizesPlanFileRoleWhenModelOmitsRefs,
  testSelectorTurnCanonicalizesModelProvidedFileRole,
  testSelectedMultiTaskIndexMapsArabicAndChineseNumerals,
  testCompileSelectedPlanTaskCanonicalizesFileRole,
  testWorkflowSelectorResolvesTaskTwoWithoutModelCall,
  testWorkflowInvalidSelectorClarifiesWithoutModelCall,
  testWorkflowRepairsInvalidUnderstandingOutputOnce,
  testWorkflowRepairsInvalidRouteOutputOnce,
  testWorkflowInjectsUnderstandingAndUsesSlimRoutePrompt,
  testWorkflowPresentsOptionsWhenPlanRepairStillUnfaithful,
  testWorkflowRepairsUnfaithfulMultiTaskPlan,
  testSelectorTurnKeepsPlanFileBindingThroughRealClarificationContext,
  testTaskSelectionUsesModelSelectedGoalAsProviderPrompt,
  testIsTaskSelectionInputRecognizesSelectors,
  testTaskSelectorUsesResolvedGoalAsProviderPromptWithoutPlan,
  testOrdinaryChatStillKeepsRawInputAsProviderPrompt,
  testWorkflowRetainsPlanAndResolvesLaterSelector,
  testSelectorTurnPreservesPlanTaskFileBindingWhenModelOmitsRefs,
];
