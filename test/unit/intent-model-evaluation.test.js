"use strict";

const assert = require("assert");
const evaluator = require("../../scripts/evaluate-intent-models");
const evaluation = require("../../scripts/lib/intent-routing-evaluation");

function testIntentModelEvaluatorDefaultsToTheThreeRequestedModels() {
  const parsed = evaluator.parseArgs([], { CHATUI_EVAL_BASE_URL: "https://example.test/v1", CHATUI_EVAL_API_KEY: "secret" });
  assert.deepStrictEqual(parsed.models, ["deepseek-v4-flash", "gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.strictEqual(parsed.chatModel, "gpt-5.6-luna");
  assert.strictEqual(parsed.imageModel, "gpt-image-2");
}

function testIntentModelEvaluatorRequiresACompleteModelListAndSafeEndpoint() {
  assert.throws(() => evaluator.parseArgs([], {}), /Base URL, API key/);
  assert.strictEqual(evaluator.normalizedEndpoint("https://gateway.example/v1"), "https://gateway.example/v1/responses");
  assert.throws(() => evaluator.normalizedEndpoint("https://user:pass@gateway.example/v1"), /credentials/);
}

function testIntentModelEvaluatorAttachmentProjectionDoesNotCarryBinaryData() {
  const projected = evaluator.makeAttachmentMetadata([
    { name: "a.png", type: "image/png", dataUrl: "data:image/png;base64,SECRET", id: "img-1" },
    { name: "a.pdf", type: "application/pdf", fileData: "data:application/pdf;base64,SECRET", id: "file-1" },
  ]);
  assert.strictEqual(projected[0].type, "image");
  assert.strictEqual(projected[1].type, "file");
  const unavailable = evaluator.makeAttachmentMetadata([{ name: "scan.pdf", type: "application/pdf", unsupported_reason: "未提取正文", has_extracted_text: false }]);
  assert.strictEqual(unavailable[0].availability, "unavailable");
  assert.ok(!Object.keys(projected[0]).some(key => /data|base64|fileData/i.test(key)));
  assert.ok(!Object.keys(projected[1]).some(key => /data|base64|fileData/i.test(key)));
}

function testLunaQualityGateRequiresEveryDimensionToBePerfect() {
  const passing = evaluator.summarizeModelResults("gpt-5.6-luna", [
    { id: "a", category: "x", safety_critical: true, evaluation: { score: 100, perfect: true, checks: { valid_route: true } } },
  ]);
  assert.strictEqual(passing.gate.passed, true);
  const failing = evaluator.summarizeModelResults("gpt-5.6-luna", [
    { id: "a", category: "x", safety_critical: true, evaluation: { score: 85, perfect: false, checks: { valid_route: true } } },
  ]);
  assert.strictEqual(failing.gate.passed, false);
}

function testIntentEvaluatorAcceptsAValidatedImageBatchParent() {
  const routeService = require('../../client/services/route-service');
  const child = {
    dispatchContract: routeService.compileDispatchContract({ operation: 'plain_chat', relation: 'new', input: 'x', prompt: 'x', bindings: [], constraints: [] }),
    dispatchAuthorized: true,
    readiness: 'ready',
  };
  const route = {
    operationType: 'plain_chat', taskShape: 'multi', relation: 'new', goalMode: 'replace',
    userGoal: '分别编辑两张图', readiness: 'ready', dispatchAuthorized: true,
    dispatchContract: null, resources: [], imagePlanCompiled: { kind: 'batch', items: [{ route: child }, { route: child }] },
  };
  assert.strictEqual(evaluation.executableImageBatch(route), true);
}

module.exports = [
  testIntentEvaluatorAcceptsAValidatedImageBatchParent,
  testIntentModelEvaluatorDefaultsToTheThreeRequestedModels,
  testIntentModelEvaluatorRequiresACompleteModelListAndSafeEndpoint,
  testIntentModelEvaluatorAttachmentProjectionDoesNotCarryBinaryData,
  testLunaQualityGateRequiresEveryDimensionToBePerfect,
];
