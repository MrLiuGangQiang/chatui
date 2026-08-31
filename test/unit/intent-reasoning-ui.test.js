"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const formatting = require("../../client/app/formatting");
const reasoning = require("../../shared/intent-reasoning");

function trace(status = "running") {
  let value = reasoning.createTrace({ requestId: "turn-1" });
  value = reasoning.appendStep(value, {
    stage: "understanding",
    status: "completed",
    summary: "确认 <当前图片> 和第二张图",
    decision: "image_edit",
    evidence: ["current_input", "i2"],
  });
  return status === "running" ? value : reasoning.completeTrace(value, { status, finalSummary: "已确认可以执行" });
}

function testIntentReasoningHtmlShowsEveryStepAndEscapesWhileRunning() {
  const rendered = formatting.intentReasoningHtml(trace("running"));
  assert.ok(rendered.html.includes("<details"));
  assert.ok(rendered.html.includes(" open>"));
  assert.ok(rendered.html.includes("is-running"));
  assert.ok(rendered.html.includes("intent-waiting-surface"));
  assert.ok(rendered.html.includes("intent-reasoning-steps"));
  assert.ok(rendered.html.includes("intent-reasoning-step"));
  assert.ok(rendered.html.includes("is-current"), "the latest running step must be marked as current");
  assert.ok(rendered.html.includes("正在理解你的请求"));
  assert.ok(rendered.html.includes("&lt;当前图片&gt;"));
  assert.ok(rendered.html.includes("修改图片"));
  assert.ok(rendered.html.includes("当前消息"));
  assert.ok(!rendered.html.includes("intent-reasoning-narrative"), "structured steps must not render a legacy narrative block");
  assert.ok(rendered.text.includes("确认"));
}

function testIntentReasoningHtmlIsCollapsedAfterTerminalState() {
  const rendered = formatting.intentReasoningHtml(trace("ready"), { collapsed: true });
  assert.ok(rendered.html.includes("已理解你的请求"));
  assert.ok(rendered.html.includes("is-terminal"));
  assert.ok(!rendered.html.includes(" open>"));
}

function testRouteRecognitionUiWiresTraceAndAssets() {
  const root = path.join(__dirname, "../..");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "styles/calm-theme.css"), "utf8");
  assert.ok(app.includes("showReasoningTrace"));
  assert.ok(app.includes('c=()=>l("正在处理你的请求")'), "routing should start with one simple waiting line");
  assert.ok(app.includes("onReasoningTrace"));
  assert.ok(app.includes(".intent-reasoning-trace") && app.includes("pending-feedback"), "execution status updates must preserve the unified intent trace surface");
  assert.ok(app.includes("intent-reasoning-title"), "current route status must stay in the unified waiting surface");
  assert.ok(app.includes("pendingFeedbackHtml"), "status updates must replace the previous waiting line");
  assert.ok(app.includes(".reasoning-panel, .intent-reasoning-trace, .pending-feedback"), "output text extraction must ignore intent trace markup");
  assert.ok(index.includes("shared/intent-reasoning.js"));
  assert.ok(index.includes("shared/intent-claims.js"));
  assert.ok(index.includes("shared/intent-critic.js"));
  assert.ok(css.includes(".intent-reasoning-trace"));
  assert.ok(css.includes("intentReasoningEllipsis"));
  assert.ok(css.includes(".intent-reasoning-steps"));
  assert.ok(css.includes(".intent-reasoning-title.is-current-status::after"));
  assert.ok(css.includes("prefers-reduced-motion"));
}

function testIntentReasoningHtmlKeepsEveryStepIncludingAdjacentDuplicates() {
  let value = reasoning.createTrace({ requestId: "turn-duplicate" });
  value = reasoning.appendStep(value, { stage: "understanding", status: "completed", summary: "正在拆解用户动作" });
  value = reasoning.appendStep(value, { stage: "understanding", status: "completed", summary: "正在拆解用户动作" });
  const rendered = formatting.intentReasoningHtml(value);
  assert.strictEqual((rendered.html.match(/正在拆解用户动作/g) || []).length, 2,
    "each chain-of-thought step must stay visible");
}

function testIntentReasoningHtmlUsesActualStepSummaryDecisionAndEvidence() {
  let value = reasoning.createTrace({ requestId: "turn-friendly" });
  value = reasoning.appendStep(value, { stage: "checking", status: "completed", summary: "正在检查要求覆盖和语义一致性 · primary", decision: "review", evidence: ["route_intent.v3"] });
  const rendered = formatting.intentReasoningHtml(value);
  assert.ok(rendered.html.includes("正在检查要求覆盖和语义一致性"));
  assert.ok(!rendered.html.includes("primary"));
  assert.ok(rendered.html.includes("检查任务内容"));
  assert.ok(rendered.html.includes("请求理解结果"));
}

function testPendingFeedbackUsesTheUnifiedIntentSurface() {
  const rendered = formatting.pendingFeedbackHtml("姝ｅ湪绛夊緟妯″瀷鐢熸垚鍥炵瓟");
  assert.ok(rendered.includes("pending-feedback"));
  assert.ok(rendered.includes("姝ｅ湪绛夊緟妯″瀷鐢熸垚鍥炵瓟"));
  assert.ok(rendered.includes("pending-feedback-row"));
}


function testIntentReasoningTitleEscapesCurrentStatus() {
  const rendered = formatting.intentReasoningHtml(reasoning.createTrace({ requestId: "turn-title" }), { currentStatus: "<img src=x onerror=alert(1)>" });
  assert.ok(rendered.html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the visible title must escape HTML in the current status");
  assert.ok(!rendered.html.includes("<img src=x onerror=alert(1)>"), "the raw status must never be injected as markup");
}

module.exports = [
  testIntentReasoningHtmlShowsEveryStepAndEscapesWhileRunning,
  testIntentReasoningHtmlIsCollapsedAfterTerminalState,
  testRouteRecognitionUiWiresTraceAndAssets,
  testIntentReasoningHtmlKeepsEveryStepIncludingAdjacentDuplicates,
  testIntentReasoningHtmlUsesActualStepSummaryDecisionAndEvidence,
  testIntentReasoningTitleEscapesCurrentStatus,
  testPendingFeedbackUsesTheUnifiedIntentSurface,
];






