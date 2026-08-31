'use strict';

const assert = require('assert');
const chatWorkflow = require('../../client/app/chat-workflow');

function testHistoryProjectionStripsMediaPayloadsAndKeepsMetadata() {
  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const history = [
    {
      role: 'assistant',
      id: 'image-message',
      resource_id: 'res:message:image-message',
      content: '[图片生成完成] 一张图',
      html: '<img src="data:image/png;base64,AAAA">',
      imageContext: JSON.stringify({ attachments: [{ src: 'data:image/png;base64,AAAA', name: 'img.png' }] }),
      dataUrl: 'data:image/png;base64,AAAA',
    },
    {
      role: 'user',
      id: 'text-message',
      content: '普通文字消息',
    },
  ];
  const projected = workflow.requestBaseMessagesForSend({ requestBaseMessages: history }, history);
  assert.deepStrictEqual(Object.keys(projected[0]).sort(), ['content', 'id', 'resource_id', 'role'],
    'history must carry role/content plus message identity metadata only');
  assert.ok(!JSON.stringify(projected).includes('base64'),
    'image/file content must never ride along in the history context');
  assert.strictEqual(projected[0].id, 'image-message');
  assert.strictEqual(projected[0].content, '[图片生成完成] 一张图');
  assert.deepStrictEqual(projected[1], { role: 'user', content: '普通文字消息', id: 'text-message' });
}

function testHistoryProjectionStillAppendsHistoricalAttachmentText() {
  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const history = [
    {
      role: 'user',
      id: 'file-message',
      content: '这是合同',
      attachmentContext: JSON.stringify({ attachments: [{ name: 'contract.txt', type: 'text/plain', text: '合同正文内容' }] }),
      dataUrl: 'data:text/plain;base64,AAAA',
    },
  ];
  const projected = workflow.requestBaseMessagesForSend({ requestBaseMessages: history }, history);
  assert.strictEqual(projected[0].content.includes('合同正文内容'), true,
    'historical attachment text remains available as context metadata');
  assert.strictEqual(projected[0].dataUrl, undefined, 'the raw attachment data must be dropped');
}

module.exports = [
  testHistoryProjectionStripsMediaPayloadsAndKeepsMetadata,
  testHistoryProjectionStillAppendsHistoricalAttachmentText,
];
