const assert = require('assert');
const workflow = require('../../client/app/display-history-workflow');

(function run() {
  const display = workflow.createDisplayHistoryWorkflow({ state: { sessions: [] } });
  assert.strictEqual(typeof display.saveDisplayHistory, 'function');
  assert.strictEqual(typeof display.restorePendingDisplayItems, 'function');
  assert.strictEqual(typeof display.renderMessageFromCanonical, 'function');
  console.log('app display history workflow ok');
})();
