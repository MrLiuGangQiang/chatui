'use strict';

const assert = require('assert');
const reasoning = require('../../shared/intent-reasoning');

function testIntentStatusDoesNotExposeInternalModelRole() {
  assert.strictEqual(reasoning.stageSummary('routing', { modelRole: 'primary' }), '正在确认你的请求');
  assert.ok(!reasoning.stageSummary('checking', { modelRole: 'fallback', reasonCode: 'intent_critic' }).includes('fallback'));
}

function testIntentStatusMapsInternalTermsToHumanLanguage() {
  const text = reasoning.stageSummary('checking', { operation: 'image_edit', reasonCode: 'route_repair' });
  assert.ok(text.includes('修改图片'));
  assert.ok(text.includes('任务内容修正'));
  assert.ok(!text.includes('image_edit'));
  assert.ok(!text.includes('route_repair'));
}

module.exports = [
  testIntentStatusDoesNotExposeInternalModelRole,
  testIntentStatusMapsInternalTermsToHumanLanguage,
];
