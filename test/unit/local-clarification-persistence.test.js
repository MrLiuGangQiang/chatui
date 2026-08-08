'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const clarification = require('../../shared/clarification-answer');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '../../' + relative), 'utf8');
}

function testLocalClarificationsPersistLikeModelClarifications() {
  const submit = read('client/app/submit-workflow.js');
  assert.ok(submit.includes('const clarificationId=createdPending?String(createdPending?.id||"")'),
    'local clarifications must carry a clarification id so the message survives refresh');
  assert.ok(!submit.includes('createdPending&&!routeInfo.localClarification'),
    'the pending clarification must be saved regardless of the localClarification flag');
  const regen = read('client/app/regenerate-workflow.js');
  assert.ok(!regen.includes('!p.localClarification&&clarificationApi'),
    'replaying a clarification must not exclude local clarifications');
}

function testLocalClarificationPendingRoundTripKeepsChoiceSlots() {
  const routeInfo = {
    needClarification: true,
    localClarification: true,
    clarificationQuestion: '检测到多个相关描述，请选择要基于哪一条生成图片：',
    clarificationSlots: [{
      key: 'r1', type: 'text', role: 'source', reason: 'ambiguous',
      choices: [
        { key: 'c1', label: '一位年轻优雅的中国女性，精致自然的五官。' },
        { key: 'c2', label: '一位成年美国女性的时尚肖像，纽约街头背景。' },
      ],
    }],
  };
  const pending = clarification.createPendingClarification({
    messages: [{ role: 'user', content: '根据历史内容中跟人相关的描述的提示词生成一张图片' }],
    clarificationText: routeInfo.clarificationQuestion,
    routeInfo,
  });
  const restored = clarification.pendingClarificationRouteInfo(JSON.parse(JSON.stringify(pending)));
  assert.strictEqual(restored.needClarification, true);
  assert.strictEqual(restored.clarificationSlots.length, 1);
  assert.strictEqual(restored.clarificationSlots[0].choices.length, 2);
  assert.strictEqual(restored.clarificationQuestion, routeInfo.clarificationQuestion);
}

module.exports = [
  testLocalClarificationsPersistLikeModelClarifications,
  testLocalClarificationPendingRoundTripKeepsChoiceSlots,
];
