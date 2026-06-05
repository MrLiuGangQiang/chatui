const assert = require('assert');
const workflow = require('../../client/app/chat-workflow');

(function run() {
  const chat = workflow.createChatWorkflow({ state: { attachments: [], activeSessionId: 's1' } });
  assert.strictEqual(typeof chat.sendChat, 'function');
  console.log('app chat workflow ok');
})();
