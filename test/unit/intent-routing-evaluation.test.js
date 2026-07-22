'use strict';

const assert = require('assert');
const path = require('path');
const routeService = require('../../client/services/route-service');
const evaluation = require('../../scripts/lib/intent-routing-evaluation');
const evaluationCli = require('../../scripts/evaluate-intent-routing');

const FIXTURE_PATH = path.join(__dirname, '../fixtures/intent-routing-eval.v1.json');

function imageQaContract(operation = 'image_qa') {
  return {
    schema_version: 'task_contract.v3',
    operation,
    relation: 'new',
    resources: [{ key: 'r1', type: 'image', source: 'current', role: 'source', index: 1, id: 'img-current-product', reference_id: 'imgref-current-product', missing: false }],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', missing_resource_keys: [] },
    confidence: 0.98,
    review_reasons: [],
    rationale: 'The request asks to understand the attached image.',
  };
}

function plainChatContract(rationale = 'The request is an independent text task.') {
  return {
    schema_version: 'task_contract.v3',
    operation: 'plain_chat',
    relation: 'new',
    resources: [],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', missing_resource_keys: [] },
    confidence: 0.98,
    review_reasons: [],
    rationale,
  };
}

function caseById(suite, id) {
  const fixture = suite.cases.find(item => item.id === id);
  assert.ok(fixture, `missing fixture case ${id}`);
  return fixture;
}

function testIntentRoutingEvaluationFixtureCoversEverySupportedOperation() {
  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);
  assert.ok(suite.cases.length >= 12, 'the starter benchmark must cover a meaningful set of customer requests');
  const operations = new Set(suite.cases.map(item => item.expected.operation));
  for (const operation of ['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image', 'clarify']) {
    assert.ok(operations.has(operation), `benchmark must cover ${operation}`);
  }
  assert.ok(suite.cases.some(item => item.category === 'context-boundary'), 'benchmark must retain context-boundary regressions');
  assert.ok(suite.cases.some(item => item.category === 'clarification'), 'benchmark must measure appropriate clarification');
}

function testIntentRoutingEvaluationScoresAValidRouteEndToEnd() {
  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);
  const fixture = caseById(suite, 'current-image-question-uses-current-image');
  const result = evaluation.evaluateRouteText(fixture, JSON.stringify(imageQaContract()));

  assert.strictEqual(result.score, 100);
  assert.strictEqual(result.perfect, true);
  assert.deepStrictEqual(result.failure_reasons, []);
}

function testIntentRoutingEvaluationSeparatesOperationAndResourceFailures() {
  const { suite } = evaluation.loadFixtureSuite(FIXTURE_PATH);
  const fixture = caseById(suite, 'current-image-question-uses-current-image');
  const wrongOperation = evaluation.evaluateRouteText(fixture, JSON.stringify(imageQaContract('ocr')));
  assert.strictEqual(wrongOperation.checks.valid_contract, true, 'a different but valid route contract must remain distinguishable from parser failure');
  assert.strictEqual(wrongOperation.checks.operation, false);
  assert.strictEqual(wrongOperation.score, 75, 'operation mismatch must lower only its weighted dimension');

  const wrongResource = imageQaContract();
  wrongResource.resources[0].id = 'img-not-in-fixture';
  const invalid = evaluation.evaluateRouteText(fixture, JSON.stringify(wrongResource));
  assert.strictEqual(invalid.checks.valid_contract, false, 'a hallucinated resource identity must fail before scoring execution semantics');
  assert.strictEqual(invalid.score, 0);

  assert.strictEqual(evaluation.resourcesMatchExpectation({ mode: 'media_exact', items: [] }, [{ type: 'message', source: 'current' }]), true, 'non-executing message annotations must not count as media binding');
  assert.strictEqual(evaluation.resourcesMatchExpectation({ mode: 'media_exact', items: [] }, [{ type: 'image', source: 'history' }]), false, 'an inherited image must still fail a no-media expectation');
}

function testIntentRoutingEvaluationSummarizesScoresAndQualityGates() {
  const perfect = { id: 'a', category: 'chat', score: 100, perfect: true, checks: { valid_contract: true, operation: true, relation: true, resources: true, clarification: true, directive: true } };
  const partial = { id: 'b', category: 'chat', score: 75, perfect: false, checks: { valid_contract: true, operation: false, relation: true, resources: true, clarification: true, directive: true } };
  const summary = evaluation.summarizeCaseScores([perfect, partial]);
  assert.strictEqual(summary.average_score, 87.5);
  assert.strictEqual(summary.dimension_accuracy.operation, 50);
  assert.strictEqual(summary.dimension_accuracy.valid_contract, 100);
  assert.strictEqual(summary.by_category.chat.perfect_case_rate, 50);

  assert.strictEqual(evaluationCli.qualityGate(summary, { minScore: 85, minValidContract: 100 }).passed, true);
  assert.strictEqual(evaluationCli.qualityGate(summary, { minScore: 90, minValidContract: 100 }).passed, false);
}

function testIntentRoutingEvaluationCliUsesExplicitCredentialsAndSafeDefaults() {
  const options = evaluationCli.parseArgs([
    '--base-url', 'https://example.test/v1',
    '--api-key', 'test-key',
    '--model', 'router-model',
    '--limit', '3',
    '--min-score', '88',
    '--min-valid-contract', '95',
    '--no-write',
  ], {});
  assert.strictEqual(options.model, 'router-model');
  assert.strictEqual(options.limit, 3);
  assert.strictEqual(options.minScore, 88);
  assert.strictEqual(options.minValidContract, 95);
  assert.strictEqual(options.noWrite, true);
  assert.strictEqual(evaluationCli.endpointFor(options.baseUrl), 'https://example.test/v1/chat/completions');
  assert.throws(() => evaluationCli.parseArgs(['--model', 'router-model'], {}), /credentials are required/);
  assert.deepStrictEqual(evaluationCli.parseArgs(['--help'], {}), { help: true });
}

async function testIntentRoutingEvaluationRunnerUsesProductionPayloadWithoutPersistingRawOutput() {
  let request = null;
  const rawMarker = 'raw-model-response-must-not-be-reported';
  const report = await evaluationCli.runEvaluation({
    baseUrl: 'https://example.test/v1',
    apiKey: 'eval-test-key',
    model: 'router-model',
    fixture: FIXTURE_PATH,
    timeoutMs: 1000,
    limit: 1,
    minScore: 90,
    minValidContract: 100,
    noWrite: true,
  }, {
    requestRoute: async options => {
      request = options;
      return JSON.stringify(plainChatContract(rawMarker));
    },
    log() {},
  });

  assert.strictEqual(request.endpoint, 'https://example.test/v1/chat/completions');
  assert.strictEqual(request.payload.model, 'router-model');
  assert.strictEqual(report.summary.average_score, 100);
  assert.strictEqual(report.quality_gate.passed, true);
  const serializedReport = JSON.stringify(report);
  assert.ok(!serializedReport.includes('eval-test-key'), 'reports must never retain API keys');
  assert.ok(!serializedReport.includes(rawMarker), 'reports must not retain raw model responses');
}

async function testIntentRoutingEvaluationRunnerRedactsCredentialsFromTransportErrors() {
  const apiKey = 'sensitive-eval-key';
  const report = await evaluationCli.runEvaluation({
    baseUrl: 'https://example.test/v1',
    apiKey,
    model: 'router-model',
    fixture: FIXTURE_PATH,
    timeoutMs: 1000,
    limit: 1,
    minScore: 90,
    minValidContract: 100,
    noWrite: true,
  }, {
    requestRoute: async () => { throw new Error(`upstream rejected ${apiKey} at https://user:password@example.test/v1`); },
    log() {},
  });

  const serializedReport = JSON.stringify(report);
  assert.ok(!serializedReport.includes(apiKey));
  assert.ok(!serializedReport.includes('user:password'));
  assert.ok(serializedReport.includes('[redacted]'));
}

module.exports = [
  testIntentRoutingEvaluationFixtureCoversEverySupportedOperation,
  testIntentRoutingEvaluationScoresAValidRouteEndToEnd,
  testIntentRoutingEvaluationSeparatesOperationAndResourceFailures,
  testIntentRoutingEvaluationSummarizesScoresAndQualityGates,
  testIntentRoutingEvaluationCliUsesExplicitCredentialsAndSafeDefaults,
  testIntentRoutingEvaluationRunnerUsesProductionPayloadWithoutPersistingRawOutput,
  testIntentRoutingEvaluationRunnerRedactsCredentialsFromTransportErrors,
];
