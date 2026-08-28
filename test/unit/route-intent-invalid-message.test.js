'use strict';

// Regression: the route_intent_invalid failure message used internal
// diagnostics language ("意图模型返回了无效的任务结构") that users cannot act
// on. The user-facing copy must be plain language: ask to retry first, then
// suggest switching to a stronger model.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', '..', 'client', 'app', 'route-intent-workflow.js');

function testInvalidRouteIntentFailureMessageIsPlainLanguage() {
  const source = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const marker = "route_intent_invalid:";
  const index = source.indexOf(marker);
  assert.ok(index >= 0, 'route_intent_invalid message entry must exist');
  const lineEnd = source.indexOf('\n', index);
  const entry = source.slice(index, lineEnd);

  assert.match(entry, /AI 没理解这条请求/, 'message must lead with plain-language cause');
  assert.match(entry, /请重试/, 'message must ask the user to retry first');
  assert.match(entry, /如果还无法理解[，,]?请切换更强模型/, 'message must point to switching to a stronger model as the escalation');
  assert.ok(!entry.includes('意图模型返回了无效的任务结构'), 'internal diagnostics wording must be removed');
  assert.ok(!entry.includes('本次未执行'), 'the message must not start with the internal "本次未执行" framing');
}

module.exports = [
  testInvalidRouteIntentFailureMessageIsPlainLanguage,
];
