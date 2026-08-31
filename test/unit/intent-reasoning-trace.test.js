"use strict";

const assert = require("assert");
const reasoning = require("../../shared/intent-reasoning");

function testIntentReasoningTraceIsBoundedAndRedactsSecrets() {
  let trace = reasoning.createTrace({ requestId: "turn-1" });
  trace = reasoning.appendStep(trace, {
    id: "s1",
    stage: "understanding",
    status: "completed",
    summary: "确认请求使用 key-sk-1234567890123456 和当前图片",
    evidence: ["current_input", "i1", "i1"],
    decision: "image_edit",
  });
  assert.strictEqual(trace.schema_version, "intent_reasoning.v1");
  assert.strictEqual(trace.request_id, "turn-1");
  assert.ok(!trace.steps[0].summary.includes("key-sk-1234567890123456"));
  assert.deepStrictEqual(trace.steps[0].evidence, ["current_input", "i1"]);
  assert.strictEqual(reasoning.traceText(trace).includes("image_edit"), true);
}

function testIntentReasoningTraceSupportsTerminalCollapseState() {
  let trace = reasoning.createTrace();
  trace = reasoning.appendStep(trace, {
    id: "s1",
    stage: "routing",
    status: "completed",
    summary: "已生成最终意图路由",
  });
  const completed = reasoning.completeTrace(trace, {
    status: "ready",
    finalSummary: "可以安全执行",
    hidden: true,
  });
  assert.strictEqual(completed.status, "ready");
  assert.strictEqual(completed.hidden, true);
  assert.strictEqual(completed.final_summary, "可以安全执行");
}

function testIntentRiskUsesSemanticDifficultySignalsWithoutChoosingAnOperation() {
  const low = reasoning.assessIntentRisk({ input: "画一只猫" });
  assert.strictEqual(low.level, "low");
  assert.deepStrictEqual(low.signals, []);

  const high = reasoning.assessIntentRisk({
    input: "不是上一张图，保留第三段，如果没有结论就说明原因，然后分别生成两张图",
    attachments: [{ id: "a" }, { id: "b" }],
    context: {
      quoted_message: { content: "上一版要求" },
      previous_execution: { operation: "text_to_image" },
    },
  });
  assert.strictEqual(high.level, "high");
  assert.ok(high.signals.includes("negation_or_correction"));
  assert.ok(high.signals.includes("conditional"));
  assert.ok(high.signals.includes("multiple_actions"));
  assert.ok(!Object.prototype.hasOwnProperty.call(high, "operation"), "risk assessment must not classify the request");
}

function testIntentRiskDoesNotTreatASelfContainedCurrentTaskAsUndeliveredFollowup() {
  const risk = reasoning.assessIntentRisk({
    input: '这是我们低代码网页子表性能指标图，我需要你输出一个测试方案',
    attachments: [{ id: 'image-1' }],
    context: { previous_execution: { operation: 'text_to_image' }, recent_messages: [{ role: 'user', content: '生成一张网页效果图' }] },
  });
  assert.ok(!risk.signals.includes('undelivered_generation_followup'));
  assert.notStrictEqual(risk.level, 'high');
}

function testIntentReasoningSummaryExtractsOnlyReasoningSummaries() {
  const summary = reasoning.extractReasoningSummary({
    output: [
      { type: "reasoning", summary: [{ text: "先确认当前图片和历史图片的边界。" }], content: "私有详细推理不应展示" },
      { type: "message", content: [{ type: "output_text", text: "最终 JSON" }] },
    ],
  });
  assert.strictEqual(summary, "先确认当前图片和历史图片的边界。");
}

module.exports = [
  testIntentReasoningTraceIsBoundedAndRedactsSecrets,
  testIntentReasoningTraceSupportsTerminalCollapseState,
  testIntentRiskUsesSemanticDifficultySignalsWithoutChoosingAnOperation,
  testIntentRiskDoesNotTreatASelfContainedCurrentTaskAsUndeliveredFollowup,
  testIntentReasoningSummaryExtractsOnlyReasoningSummaries,
];
