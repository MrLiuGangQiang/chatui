'use strict';

const assert = require('assert');
const helpers = require('../../client/app/submit-workflow.helpers');

function parse(value) {
  if (!value) return null;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function userImageContext() {
  return {
    attachments: [{ imageId: 'img-source-1', name: 'phone-front.png' }],
    prompt: '分析这两张手机图片',
  };
}

function testInheritQuotedImageContextUsesOriginalUserMessage() {
  const sourceUser = {
    id: 'user-1',
    turnId: 'turn-1',
    role: 'user',
    imageContext: JSON.stringify(userImageContext()),
  };
  const quotedAssistant = {
    id: 'assistant-1',
    role: 'assistant',
    replyToMessageId: 'user-1',
    turnId: 'turn-1',
    imageContext: '',
  };
  const inherited = helpers.inheritQuotedImageContext({
    quotedMessage: quotedAssistant,
    sessionMessages: [sourceUser, quotedAssistant],
    parseContextValue: parse,
  });
  assert.strictEqual(inherited.attachments.length, 1);
  assert.strictEqual(inherited.attachments[0].imageId, 'img-source-1');
}

function testInheritQuotedImageContextKeepsOwnImageContext() {
  const own = { attachments: [{ imageId: 'img-own-1' }], prompt: 'own' };
  const quotedAssistant = {
    id: 'assistant-1',
    role: 'assistant',
    imageContext: JSON.stringify(own),
  };
  const inherited = helpers.inheritQuotedImageContext({
    quotedMessage: quotedAssistant,
    sessionMessages: [],
    parseContextValue: parse,
  });
  assert.strictEqual(inherited.attachments[0].imageId, 'img-own-1');
}

function testInheritQuotedImageContextReturnsNullWithoutSource() {
  const inherited = helpers.inheritQuotedImageContext({
    quotedMessage: { id: 'assistant-1', role: 'assistant', imageContext: '' },
    sessionMessages: [],
    parseContextValue: parse,
  });
  assert.strictEqual(inherited, null);
}

module.exports = [
  testInheritQuotedImageContextUsesOriginalUserMessage,
  testInheritQuotedImageContextKeepsOwnImageContext,
  testInheritQuotedImageContextReturnsNullWithoutSource,
];
