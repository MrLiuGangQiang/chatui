'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const executionStatus = require('../../client/app/execution-status');
const formatting = require('../../client/app/formatting');

const root = path.join(__dirname, '../..');

function testPendingStatusRendersOneEscapedAtomicLine() {
  const html = formatting.pendingFeedbackHtml('<img src=x onerror=alert(1)>');

  assert.strictEqual((html.match(/class="pending-feedback"/g) || []).length, 1);
  assert.ok(html.includes('data-live-status="true"'));
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(html.includes('aria-atomic="true"'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('data-execution-map'));
  assert.ok(!html.includes('pending-map'));
  const multiline = formatting.pendingFeedbackHtml('任务 1/2：正在生成\n任务 2/2：等待开始');
  assert.ok(multiline.includes('pending-feedback-multiline'), 'multi-task progress must opt into multiline presentation');
  assert.ok(multiline.includes('任务 1/2：正在生成<br>任务 2/2：等待开始'), 'multi-task progress must preserve task boundaries as HTML line breaks');
  assert.ok(!html.includes('接收任务'));
}

function testExecutionStatusUsesOperationSpecificLatestState() {
  assert.strictEqual(executionStatus.operationStatusText('plain_chat', 'execute'), '正在等待模型生成回答');
  assert.strictEqual(executionStatus.operationStatusText('ocr', 'execute'), '正在提取图片文字');
  assert.strictEqual(executionStatus.operationStatusText('image_compare', 'execute'), '正在比较所选图片');
  assert.strictEqual(executionStatus.operationStatusText('multimodal_qa', 'execute'), '正在结合图片和文件分析');
  assert.strictEqual(executionStatus.operationStatusText('image_reference_gen', 'execute'), '正在基于参考图生成图片');
  assert.strictEqual(executionStatus.operationStatusText('edit_image', 'execute'), '正在修改图片');
  assert.strictEqual(executionStatus.routeStageText('route_ready', { operation: 'file_qa' }), '正在准备文件内容');
  assert.ok(formatting.isChatStatusText('正在比较所选图片'));
  assert.ok(formatting.isChatStatusText('正在基于参考图生成图片… 已等待 12 秒'));
}

function testPendingStatusAssetsShipWithoutFixedExecutionMap() {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const flatTheme = fs.readFileSync(path.join(root, 'styles/flat-theme.css'), 'utf8');
  const submitWorkflow = fs.readFileSync(path.join(root, 'client/app/submit-workflow.js'), 'utf8');
  const chatWorkflow = fs.readFileSync(path.join(root, 'client/app/chat-workflow.js'), 'utf8');
  const imageWorkflow = fs.readFileSync(path.join(root, 'client/app/image-workflow.js'), 'utf8');
  const regenerateWorkflow = fs.readFileSync(path.join(root, 'client/app/regenerate-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  assert.ok(!styles.includes('[data-execution-map]'));
  assert.ok(!styles.includes('.pending-map-step'));
  assert.ok(flatTheme.includes('.pending-text{'));
  assert.ok(flatTheme.includes('text-overflow:ellipsis!important'));
  assert.ok(flatTheme.includes('white-space:nowrap!important'));
  assert.ok(flatTheme.includes('.pending-feedback.pending-feedback-multiline .pending-text{'));
  assert.ok(flatTheme.includes('white-space:normal!important'));
  assert.ok(flatTheme.includes('background:transparent!important'));
  assert.ok(!submitWorkflow.includes('正在执行：路由预检'));
  assert.ok(!chatWorkflow.includes('正在处理中 请稍后'));
  assert.ok(!chatWorkflow.includes(String.raw`\u6b63\u5728\u5904\u7406\u4e2d \u8bf7\u7a0d\u540e`));
  assert.ok(!imageWorkflow.includes('正在处理中 请稍后'));
  assert.ok(!regenerateWorkflow.includes('正在处理中 请稍后'));
  assert.ok(!regenerateWorkflow.includes('正在执行：路由预检'));
  assert.ok(chatWorkflow.includes("operationStatusText?.(executionAuthorization.plan, 'execute')"));
  assert.ok(imageWorkflow.includes("operationStatusText?.(executionContract, 'execute')"));
  assert.ok(app.includes('onStage:l'), 'route events must update the current live status in place');
  assert.ok(!app.includes('setTimeout(()=>l(ROUTE_SLOW_TEXT),10000)'), 'pending status must not be driven by a fixed timer fallback');
  assert.ok(index.includes('styles.css?v=1.3.5-live-status'));
  assert.ok(index.includes('flat-theme.css?v=2.2.4-live-status'));
  assert.ok(index.includes('execution-status.js?v=1.0.0'));
  assert.ok(index.includes('formatting.js?v=1.2.70-live-status'));
  assert.ok(index.includes('regenerate-workflow.js?v=1.2.4-live-status'));
}

module.exports = [
  testPendingStatusRendersOneEscapedAtomicLine,
  testExecutionStatusUsesOperationSpecificLatestState,
  testPendingStatusAssetsShipWithoutFixedExecutionMap,
];
