const assert = require('assert');
const workflow = require('../../client/app/image-workflow');

(function run() {
  const image = workflow.createImageWorkflow({ state: { attachments: [], activeSessionId: 's1' } });
  assert.strictEqual(typeof image.sendImage, 'function');
  console.log('app image workflow ok');
})();
