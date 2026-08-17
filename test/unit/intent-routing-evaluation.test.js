"use strict";

const assert = require("assert");
const path = require("path");
const evaluation = require("../../scripts/lib/intent-routing-evaluation");
const evaluationCli = require("../../scripts/evaluate-intent-routing");
const routeService = require("../../client/services/route-service");

const FIXTURE_PATH = path.join(__dirname, "../fixtures/intent-routing-eval.v3.json");

function plan(operation, _prompt = "") {
  return JSON.stringify({
    operation,
    relation: "new",
    goal: _prompt || operation,
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [],
  });
}

function caseById(suite, id) {
  const fixture = suite.cases.find(item => item.id === id);
  assert.ok(fixture, `missing fixture case ${id}`);
  return fixture;
}

function testIntentRoutingEvaluationLoadsAndValidatesTheStrictFixture() {
  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);
  assert.strictEqual(suite.schema_version, "intent-routing-eval.v3");
  assert.strictEqual(suite.cases.length, 53);
  const operations = new Set(suite.cases.map(item => item.expected.operation));
  for (const operation of evaluation.VALID_OPERATIONS) assert.ok(operations.has(operation), `fixture must cover ${operation}`);
  assert.ok(suite.cases.every(item => item.expected.goal && item.expected.clarification && item.expected.resources));
  assert.ok(suite.cases.every(item => evaluation.VALID_TASK_SHAPES.has(item.expected.task_shape)));
  assert.ok(suite.cases.every(item => evaluation.VALID_GOAL_MODES.has(item.expected.goal_mode)));
  for (const id of [
    'partial-redesign-amends-task-state-without-old-image',
    'multi-text-to-image-amendment-keeps-shared-prior-specification',
  ]) {
    assert.deepStrictEqual(caseById(suite, id).expected.goal.intent_forbidden, [
      'L形交通走廊',
      '餐厅与卫生间相邻',
    ]);
  }
  assert.strictEqual(Object.values(evaluation.SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0), 100);
  assert.ok(suite.cases.every(item => !Object.hasOwn(item.expected, "directive")));
}

function testIntentRoutingEvaluationRequiresExplicitCurrentTurnForDuplicatedInput() {
  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);
  const duplicateCases = suite.cases.filter(item => (
    (item.context?.recent_messages || []).some(message => message?.role === 'user' && message?.content === item.input)
  ));
  assert.deepStrictEqual(duplicateCases.map(item => item.id), [
    'current-image-question-uses-current-image',
    'current-image-ocr-uses-current-image',
    'current-file-question-uses-current-file',
    'current-image-and-file-need-multimodal-answer',
    'reference-generate-from-current-image',
    'missing-image-target-requires-clarification',
  ]);
  assert.ok(duplicateCases.every(item => item.current_turn?.messageIndex === 1));

  const invalidSuite = JSON.parse(JSON.stringify(suite));
  delete invalidSuite.cases.find(item => item.id === 'missing-image-target-requires-clarification').current_turn;
  assert.throws(() => evaluation.validateFixtureSuite(invalidSuite), /current_turn is required/,
    'a live evaluator fixture must never send the current user input back as history implicitly');
}

function testIntentRoutingEvaluationBuildsProductionEquivalentCurrentTurnBoundary() {
  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);
  const fixture = caseById(suite, 'missing-image-target-requires-clarification');
  const payload = evaluationCli.buildRoutePayloadForCase(fixture, 'router-model');
  const userPayload = JSON.parse(payload.input.find(item => item.role === 'user').content);

  assert.deepStrictEqual(userPayload.current_turn, { messageIndex: 1 });
  assert.deepStrictEqual(userPayload.context?.recent_messages || [], [],
    'the evaluator must filter the current user turn exactly as the production submit workflow does');
  assert.deepStrictEqual(userPayload.resource_candidates, []);
}

function modelIntentForScenario(fixture) {
  const catalog = routeService.buildRouteResourceCandidates({
    attachments: fixture.attachments || [],
    context: fixture.context || {},
    input: fixture.input,
    currentTurn: fixture.current_turn || null,
  });
  const resourceRefs = [];

  for (const expected of fixture.expected.resources.items || []) {
    const matches = catalog.filter(candidate => (
      candidate.type === expected.type
      && candidate.source === expected.source
      && (!expected.id || candidate.id === expected.id)
      && (!expected.reference_id || candidate.reference_id === expected.reference_id)
      && (!expected.index || Number(candidate.index) === Number(expected.index))
    ));
    assert.strictEqual(matches.length, 1, `${fixture.id}: expected one catalog match for ${JSON.stringify(expected)}`);
    resourceRefs.push({ candidate_key: matches[0].candidate_key, role: expected.role });
  }

  return {
    operation: fixture.expected.operation,
    relation: Array.isArray(fixture.expected.relation) ? fixture.expected.relation[0] : fixture.expected.relation,
    goal: fixture.expected.goal.concepts.map(alternatives => alternatives[0]).join('，'),
    goal_mode: fixture.expected.goal_mode,
    task_shape: fixture.expected.task_shape,
    resource_refs: resourceRefs,
  };
}

function scenarioTestName(id = "") {
  return `testIntentScenario${String(id).split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1)).join("")}`;
}

function createScenarioTest(fixture) {
  const runScenario = function runIntentScenario() {
    const intent = modelIntentForScenario(fixture);
    const result = evaluation.evaluateRouteText(fixture, JSON.stringify(intent));
    assert.strictEqual(
      result.perfect,
      true,
      `${fixture.id}: ${result.failure_reasons.join(", ")}\nintent=${JSON.stringify(intent)}\ncompiled=${JSON.stringify(result.compiled)}`,
    );
    assert.strictEqual(result.score, 100);
    assert.deepStrictEqual(result.failure_reasons, []);
    assert.strictEqual(result.compiled.operation, fixture.expected.operation);
    assert.ok(evaluation.relationMatchesExpectation(fixture.expected.relation, result.compiled.relation), `${fixture.id}: relation mismatch: expected ${JSON.stringify(fixture.expected.relation)}, got ${result.compiled.relation}`);
    assert.strictEqual(result.compiled.goal_mode, fixture.expected.goal_mode);
    assert.strictEqual(result.compiled.readiness, fixture.expected.clarification.required ? "needs_clarification" : "ready");
    const expectsImagePlanning = fixture.expected.task_shape === 'multi'
      && !fixture.expected.clarification.required;
    assert.strictEqual(Boolean(result.compiled.dispatch_contract),
      !fixture.expected.clarification.required && !expectsImagePlanning);
  };
  Object.defineProperty(runScenario, "name", { value: scenarioTestName(fixture.id) });
  return runScenario;
}

const { suite: REAL_ROUTING_SCENARIOS } = evaluation.loadFixtureSuite(FIXTURE_PATH);
const REAL_ROUTING_SCENARIO_TESTS = REAL_ROUTING_SCENARIOS.cases.map(createScenarioTest);

function testIntentRoutingEvaluationRejectsAnIntentThatSelectsAnUnknownResource() {
  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);
  const fixture = caseById(suite, "current-image-question-uses-current-image");
  const result = evaluation.evaluateRouteText(fixture, JSON.stringify({
    operation: "image_qa",
    relation: "new",
    goal: fixture.input,
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [{ candidate_key: "i2", role: "source" }],
  }));
  assert.strictEqual(result.checks.valid_route, true, "the local compiler must return a structurally valid clarification route");
  assert.strictEqual(result.checks.resources, false);
  assert.strictEqual(result.checks.dispatch_contract, false);
  assert.strictEqual(result.compiled.dispatch_contract, null);
  assert.strictEqual(result.perfect, false);
}

function testIntentRoutingEvaluationChecksGoalConceptsAndForbiddenControlText() {
  assert.strictEqual(evaluation.goalMatchesExpectation({
    concepts: [['耳朵'], ['红色', '蓝色']],
    forbidden: ['选错了', 'candidate_key'],
  }, '把目标图片的耳朵换成红色'), true);
  assert.strictEqual(evaluation.goalMatchesExpectation({
    concepts: [['耳朵'], ['红色', '蓝色']],
    forbidden: ['选错了', 'candidate_key'],
  }, '选错了，请继续处理上一项任务'), false);
  const amendmentExpectation = {
    concepts: [['入口'], ['无遮挡']],
    forbidden: ['candidate_key'],
    intent_forbidden: ['旧方案采用L形交通走廊'],
  };
  assert.strictEqual(evaluation.goalMatchesExpectation(
    amendmentExpectation,
    '入口保持无遮挡；旧方案采用L形交通走廊。',
  ), true, 'compiled task state may legitimately include the previous base');
  assert.strictEqual(evaluation.goalMatchesExpectation(
    amendmentExpectation,
    '入口保持无遮挡；旧方案采用L形交通走廊。',
    { intentOnly: true },
  ), false, 'raw amend goal must not duplicate the previous base');

  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);
  const targetOnlyEdit = caseById(suite, 'explicit-second-current-image-edit');
  assert.strictEqual(evaluation.goalMatchesExpectation(
    targetOnlyEdit.expected.goal,
    '只把目标图的背景改为浅灰色，其他内容保持不变。',
  ), true, 'an equivalent target-only constraint must retain the first-image exclusion semantics');
  assert.strictEqual(evaluation.goalMatchesExpectation(
    targetOnlyEdit.expected.goal,
    targetOnlyEdit.input,
  ), true, 'the faithful original wording must not fail because the evaluator demands an unstated preservation phrase');

  assert.strictEqual(evaluation.goalMatchesExpectation(
    targetOnlyEdit.expected.goal,
    '将第二张图的背景改成浅灰色，第一张保持原样。',
  ), true, 'a faithful keep-the-other-image-unchanged wording must not be rejected lexically');

  const attachmentOnlyFile = caseById(suite, 'attachment-only-current-file-uses-model-goal');
  assert.strictEqual(evaluation.goalMatchesExpectation(
    attachmentOnlyFile.expected.goal,
    '概述该文件的内容。',
  ), true, 'the attachment-only default goal must accept the prompt-defined 概述 wording');


  const multiRoleReference = caseById(suite, 'content-and-style-references-keep-separate-roles');
  assert.strictEqual(evaluation.goalMatchesExpectation(
    multiRoleReference.expected.goal,
    '以第一张图的主体构图和第二张图的水彩质感为参考，生成一张产品海报。',
  ), true, 'natural-language image ordinals remain valid when resource roles are evaluated separately');
  assert.strictEqual(evaluation.goalMatchesExpectation(
    multiRoleReference.expected.goal,
    '使用候选 i1 和 i2 生成产品海报。',
  ), false, 'internal candidate keys must remain forbidden in goal text');
}

function testIntentRoutingEvaluationExtractsRouteResolutionWithoutIgnoringRawExecutionContext() {
  const rawInput = `完整用户要求：${'保留项'.repeat(600)}`;
  const resolvedGoal = '分析所选合同中的违约责任。';
  const executionPrompt = [
    '[execution_semantic_context.v1]',
    '用户原始本轮要求（完整保留，优先遵循）：',
    rawInput,
    '路由消解（仅用于识别指代、上下文和已选资源；不得新增、删除或覆盖用户原始要求）：',
    resolvedGoal,
  ].join('\n\n');
  assert.ok(executionPrompt.includes(rawInput));
  assert.strictEqual(evaluation.executionGoalForEvaluation(executionPrompt), resolvedGoal);
}

function testIntentRoutingEvaluationRejectsSemanticMutations() {
  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);

  const plainChat = caseById(suite, 'plain-chat-does-not-inherit-history-image');
  const lostFacts = evaluation.evaluateRouteText(plainChat, JSON.stringify({
    operation: 'plain_chat',
    relation: 'new',
    goal: '把登录页写得更专业。',
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [],
  }));
  assert.strictEqual(lostFacts.checks.goal, false, 'dropping required task facts must fail even when operation is correct');

  const comparison = caseById(suite, 'compare-two-numbered-history-images');
  const comparisonCatalog = routeService.buildRouteResourceCandidates({
    attachments: comparison.attachments,
    context: comparison.context,
    input: comparison.input,
  });
  const first = comparisonCatalog.find(candidate => candidate.type === 'image' && Number(candidate.index) === 1);
  const second = comparisonCatalog.find(candidate => candidate.type === 'image' && Number(candidate.index) === 2);
  const swapped = evaluation.evaluateRouteText(comparison, JSON.stringify({
    operation: 'image_compare',
    relation: 'followup',
    goal: '比较两张历史产品图的构图与色调差异。',
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [
      { candidate_key: second.candidate_key, role: 'compare_a' },
      { candidate_key: first.candidate_key, role: 'compare_b' },
    ],
  }));
  assert.strictEqual(swapped.checks.resources, false, 'swapping ordered comparison roles must fail');
  assert.strictEqual(swapped.model_resources_match, false, 'raw model refs are checked independently from compilation');

  const multiRole = caseById(suite, 'content-and-style-references-keep-separate-roles');
  const roleCatalog = routeService.buildRouteResourceCandidates({
    attachments: multiRole.attachments,
    context: multiRole.context,
    input: multiRole.input,
  });
  const roleMutated = evaluation.evaluateRouteText(multiRole, JSON.stringify({
    operation: 'image_reference_gen',
    relation: 'new',
    goal: '用主体参考图的构图和风格参考图的水彩质感生成产品海报。',
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [
      { candidate_key: roleCatalog[0].candidate_key, role: 'style_reference' },
      { candidate_key: roleCatalog[1].candidate_key, role: 'reference' },
    ],
  }));
  assert.strictEqual(roleMutated.checks.resources, false, 'content and style roles are not interchangeable');
  assert.strictEqual(roleMutated.model_resources_match, false);

  const multiTask = caseById(suite, 'cross-api-multi-task-requires-clarification');
  const multiTaskResult = evaluation.evaluateRouteText(multiTask, JSON.stringify(modelIntentForScenario(multiTask)));
  assert.strictEqual(multiTaskResult.compiled.readiness, 'needs_clarification');
  assert.strictEqual(multiTaskResult.compiled.dispatch_contract, null, 'an unrepresentable cross-API task must never dispatch');
}

function testIntentRoutingEvaluationDoesNotLetTheCompilerHideModelSemanticMutations() {
  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);
  const fixture = caseById(suite, 'plain-chat-does-not-inherit-history-image');
  const intent = modelIntentForScenario(fixture);
  const inspected = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input: fixture.input,
    attachments: fixture.attachments,
    context: fixture.context,
    currentMode: fixture.current_mode || 'chat',
    autoMode: fixture.auto_mode !== false,
  });
  assert.strictEqual(Boolean(inspected.route), true);
  const mutatedModelIntent = { ...intent, operation: 'file_qa' };
  const operationResult = evaluation.scoreRouteCase(fixture, inspected.route, {
    model_intent: mutatedModelIntent,
  });
  assert.strictEqual(operationResult.checks.valid_route, true, 'the compiled route remains structurally valid');
  assert.strictEqual(operationResult.checks.operation, false, 'the independent model oracle must reject the mutated operation');
  assert.strictEqual(operationResult.model_semantics_match.operation, false);

  const relationResult = evaluation.scoreRouteCase(fixture, inspected.route, {
    model_intent: { ...intent, relation: 'followup' },
  });
  assert.strictEqual(relationResult.checks.relation, false, 'the compiler result cannot hide a mutated model relation');
  assert.strictEqual(relationResult.model_semantics_match.relation, false);

  const goalResult = evaluation.scoreRouteCase(fixture, inspected.route, {
    model_intent: { ...intent, goal: '把登录页写得更专业。' },
  });
  assert.strictEqual(goalResult.checks.goal, false, 'the compiler result cannot restore facts omitted by the model goal');
  assert.strictEqual(goalResult.model_semantics_match.goal, false);

  const redesign = caseById(suite, 'complete-redesign-replaces-task-state-without-old-image');
  const redesignIntent = modelIntentForScenario(redesign);
  const redesignInspection = routeService.inspectModelRouteResult(JSON.stringify(redesignIntent), {
    input: redesign.input,
    attachments: redesign.attachments,
    context: redesign.context,
  });
  assert.ok(redesignInspection.route, redesignInspection.reason || redesignInspection.error);
  const goalModeResult = evaluation.scoreRouteCase(redesign, redesignInspection.route, {
    model_intent: { ...redesignIntent, goal_mode: 'amend' },
  });
  assert.strictEqual(goalModeResult.checks.valid_route, true, 'the compiled replacement route remains structurally valid');
  assert.strictEqual(goalModeResult.checks.goal_mode, false, 'the independent model oracle must reject a mutated goal_mode');
  assert.strictEqual(goalModeResult.model_semantics_match.goal_mode, false);
}

function testIntentRoutingEvaluationUsesStrictAggregateAndSafetyGates() {
  const summary = evaluation.summarizeCaseScores([
    { id: "safe-pass", category: "x", safety_critical: true, score: 100, perfect: true, checks: Object.fromEntries(Object.keys(evaluation.SCORE_WEIGHTS).map(key => [key, true])) },
    { id: "ordinary-fail", category: "x", safety_critical: false, score: 80, perfect: false, checks: { ...Object.fromEntries(Object.keys(evaluation.SCORE_WEIGHTS).map(key => [key, true])), operation: false } },
  ]);
  assert.strictEqual(summary.average_score, 90);
  assert.strictEqual(evaluationCli.qualityGate(summary, { minScore: 100, minValidRoute: 100 }).passed, false, "strict default-quality gate must not accept a partial case");
  assert.strictEqual(evaluationCli.qualityGate(summary, { minScore: 80, minValidRoute: 100 }).passed, true, "explicitly relaxed aggregate threshold may pass when safety-critical cases remain perfect");
  assert.deepStrictEqual(summary.safety_critical.failed_case_ids, []);
}

function testIntentRoutingEvaluationRedactsSecretsAndBinaryFromReportValues() {
  const secret = "sk-test-12345678901234567890";
  const redacted = evaluation.redactModelOutput(JSON.stringify({ authorization: `Bearer ${secret}`, image: "data:image/png;base64,AAAA" }), secret);
  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes("AAAA"));
  assert.ok(serialized.includes("[redacted]"));
}

function testIntentRoutingEvaluationCliParsesZeroThresholdAndAuditsPayloadBoundary() {
  const options = evaluationCli.parseArgs([
    "--base-url", "https://example.test/v1",
    "--api-key", "test-key",
    "--model", "router-model",
    "--min-score", "0",
    "--min-valid-route", "0",
    "--no-write",
  ], {});
  assert.strictEqual(options.minScore, 0);
  assert.strictEqual(options.minValidRoute, 0);
  const audit = evaluationCli.auditRoutePayload({
    model: "router-model",
    input: [{ role: "user", content: JSON.stringify({ resource_candidates: [{ type: "image", candidate_key: "i1" }] }) }],
  }, "test-key");
  assert.strictEqual(audit.contains_api_key, false);
  assert.strictEqual(audit.contains_data_url, false);
  assert.strictEqual(audit.embedded_execution_protocol_field, "");
  assert.strictEqual(audit.transport, "responses");
}

async function testIntentRoutingEvaluationExtractsProviderResponsesEnvelopeWithTextFormatMetadata() {
  const routeJson = plan('plain_chat', '保持原意');
  const fetchImpl = async () => new Response(JSON.stringify({
    id: 'resp-provider-envelope',
    object: 'response',
    status: 'completed',
    text: {
      format: {
        type: 'json_schema',
        name: 'chatui_route_intent_v3',
        schema: { type: 'object' },
        strict: true,
      },
      verbosity: 'low',
    },
    output: [
      {
        type: 'reasoning',
        content: [],
        encrypted_content: 'must-not-be-selected',
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: routeJson }],
      },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const payload = routeService.buildRoutePayload({
    model: 'router-model',
    input: '保持原意',
    context: {},
  });

  const text = await evaluationCli.requestRouteModel({
    endpoint: 'https://example.test/v1/responses',
    apiKey: 'test-key',
    payload,
    timeoutMs: 1000,
    fetchImpl,
  });

  assert.strictEqual(text, routeJson,
    'the evaluator must read final output content rather than the top-level Responses text-format configuration');
}

async function testIntentRoutingEvaluationUsesProductionToolChoiceFallback() {
  const calls = [];
  const fetchImpl = async (_url, options = {}) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        error: { code: 'unsupported_parameter', message: 'The tool_choice parameter is not supported.' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      output_text: plan('plain_chat', '保持原意'),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const payload = routeService.buildRoutePayload({
    model: 'router-model',
    input: '保持原意',
    context: {},
  });
  const original = JSON.parse(JSON.stringify(payload));

  const text = await evaluationCli.requestRouteModel({
    endpoint: 'https://example.test/v1/responses',
    apiKey: 'test-key',
    payload,
    timeoutMs: 1000,
    fetchImpl,
  });

  assert.strictEqual(text, plan('plain_chat', '保持原意'));
  assert.strictEqual(calls.length, 2, 'the live evaluator must retry once without an unsupported tool_choice parameter');
  assert.strictEqual(calls[0].tool_choice, 'none');
  assert.strictEqual(Object.hasOwn(calls[1], 'tool_choice'), false);
  assert.deepStrictEqual(payload, original, 'evaluation compatibility must not mutate the production route payload');
}

async function testIntentRoutingEvaluationUsesProductionStructuredOutputFallbacks() {
  const calls = [];
  const fetchImpl = async (_url, options = {}) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        error: { code: 'invalid_request_error', message: 'This text.format type is unavailable now' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    if (calls.length === 2) {
      return new Response(JSON.stringify({
        error: { code: 'invalid_request_error', message: "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'." },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      output_text: plan('plain_chat', '保持原意'),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const payload = routeService.buildRoutePayload({
    model: 'router-model',
    input: '保持原意',
    context: {},
  });
  const original = JSON.parse(JSON.stringify(payload));

  const text = await evaluationCli.requestRouteModel({
    endpoint: 'https://example.test/v1/responses',
    apiKey: 'test-key',
    payload,
    timeoutMs: 1000,
    fetchImpl,
  });

  assert.strictEqual(text, plan('plain_chat', '保持原意'));
  assert.strictEqual(calls.length, 3, 'json_schema, json_object and instructed plain JSON must each be attempted once');
  assert.strictEqual(calls[0].text.format.type, 'json_schema');
  assert.strictEqual(calls[1].text.format.type, 'json_object');
  assert.strictEqual(calls[2].text, undefined);
  assert.ok(calls[2].input.at(-1).content.includes('JSON Schema'));
  assert.deepStrictEqual(payload, original, 'evaluation compatibility must not mutate the production route payload');
}

async function testIntentRoutingEvaluationRunnerRetainsRedactedInputOutputAndCompilationEvidence() {
  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);
  const fixture = caseById(suite, "plain-chat-does-not-inherit-history-image");
  const secret = "sensitive-eval-key";
  const report = await evaluationCli.runEvaluation({
    baseUrl: "https://example.test/v1",
    apiKey: secret,
    model: "router-model",
    fixture: FIXTURE_PATH,
    timeoutMs: 1000,
    limit: 1,
    minScore: 100,
    minValidRoute: 100,
    noWrite: true,
  }, {
    requestRoute: async ({ payload }) => {
      assert.strictEqual(payload.model, "router-model");
      return plan("plain_chat", fixture.input);
    },
    log() {},
  });
  assert.strictEqual(report.quality_gate.passed, true);
  assert.strictEqual(report.cases[0].evaluation.perfect, true);
  assert.ok(report.cases[0].compiled_result);
  assert.ok(report.cases[0].model_output.text.includes('"operation":"plain_chat"'));
  assert.ok(!report.cases[0].model_output.text.includes('schema_version'));
  assert.ok(!JSON.stringify(report).includes(secret));
}

module.exports = [
  testIntentRoutingEvaluationLoadsAndValidatesTheStrictFixture,
  testIntentRoutingEvaluationRequiresExplicitCurrentTurnForDuplicatedInput,
  testIntentRoutingEvaluationBuildsProductionEquivalentCurrentTurnBoundary,
  ...REAL_ROUTING_SCENARIO_TESTS,
  testIntentRoutingEvaluationRejectsAnIntentThatSelectsAnUnknownResource,
  testIntentRoutingEvaluationChecksGoalConceptsAndForbiddenControlText,
  testIntentRoutingEvaluationExtractsRouteResolutionWithoutIgnoringRawExecutionContext,
  testIntentRoutingEvaluationRejectsSemanticMutations,
  testIntentRoutingEvaluationDoesNotLetTheCompilerHideModelSemanticMutations,
  testIntentRoutingEvaluationUsesStrictAggregateAndSafetyGates,
  testIntentRoutingEvaluationRedactsSecretsAndBinaryFromReportValues,
  testIntentRoutingEvaluationCliParsesZeroThresholdAndAuditsPayloadBoundary,
  testIntentRoutingEvaluationExtractsProviderResponsesEnvelopeWithTextFormatMetadata,
  testIntentRoutingEvaluationUsesProductionToolChoiceFallback,
  testIntentRoutingEvaluationUsesProductionStructuredOutputFallbacks,
  testIntentRoutingEvaluationRunnerRetainsRedactedInputOutputAndCompilationEvidence,
];
