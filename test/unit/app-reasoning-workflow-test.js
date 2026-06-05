const assert = require('assert');
const workflow = require('../../client/app/reasoning-workflow');

(function run() {
  const reasoning = workflow.createReasoningWorkflow({ state: { reasoningMode: false, reasoningType: 'medium', reasoningProvider: 'auto', sessions: [] } });
  assert.strictEqual(typeof reasoning.updateReasoning, 'function');
  assert.strictEqual(typeof reasoning.reasoningPayloadOptions, 'function');
  assert.deepStrictEqual(reasoning.reasoningPayloadOptions({ reasoning: false }), {});
  assert.strictEqual(typeof reasoning.extractStreamDelta, 'function');
  console.log('app reasoning workflow ok');
})();
