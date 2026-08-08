'use strict';

const assert = require('assert');
const sessions = require('../../client/app/sessions');

function testCustomSessionTitleAlwaysWins() {
  assert.strictEqual(sessions.deriveSessionTitle({
    customTitle: ' 手动标题 ',
    title: '你好',
    messages: [{ role: 'user', content: '实际主题' }],
  }), '手动标题');
}

function testGenericGreetingIsReplacedByFirstRealTopic() {
  assert.strictEqual(sessions.deriveSessionTitle({
    title: '你好',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么我可以帮你的吗？' },
      { role: 'user', content: '你是什么模型' },
    ],
  }), '你是什么模型');
}

function testEstablishedDescriptiveTitleRemainsStable() {
  assert.strictEqual(sessions.deriveSessionTitle({
    title: '已有会话标题',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'user', content: '后续换了一个问题' },
    ],
  }), '已有会话标题');
}

function testOnlyGreetingStillProducesGreetingTitle() {
  assert.strictEqual(sessions.deriveSessionTitle({
    title: '新对话',
    messages: [{ role: 'user', content: 'Hello!' }],
  }), 'Hello!');
}

function testSubstantiveGreetingSentenceIsNotDiscarded() {
  assert.strictEqual(sessions.deriveSessionTitle({
    title: '新对话',
    messages: [{ role: 'user', content: '你好，请帮我优化这份公告' }],
  }), '你好，请帮我优化这份公告');
}

function testRichUserContentCanProvideTitleText() {
  assert.strictEqual(sessions.deriveSessionTitle({
    title: '你好',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'user', content: [{ type: 'input_text', text: '分析这份需求文档' }] },
    ],
  }), '分析这份需求文档');
}

module.exports = [
  testCustomSessionTitleAlwaysWins,
  testGenericGreetingIsReplacedByFirstRealTopic,
  testEstablishedDescriptiveTitleRemainsStable,
  testOnlyGreetingStillProducesGreetingTitle,
  testSubstantiveGreetingSentenceIsNotDiscarded,
  testRichUserContentCanProvideTitleText,
];
