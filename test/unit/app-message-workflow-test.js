const assert = require('assert');
const workflow = require('../../client/app/message-workflow');

(function run() {
  const message = workflow.createMessageWorkflow({ state: {} });
  assert.strictEqual(typeof message.updateMessage, 'function');
  assert.strictEqual(typeof message.updateMessageContentLight, 'function');
  assert.strictEqual(typeof message.addMessage, 'function');
  console.log('app message workflow ok');
})();
