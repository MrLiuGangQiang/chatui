const assert = require('assert');
const workflow = require('../../client/app/route-decision-workflow');

(function run() {
  const route = workflow.createRouteDecisionWorkflow({ state: { sessions: [], activeSessionId: 's1', autoMode: false } });
  assert.strictEqual(typeof route.buildRouteContext, 'function');
  assert.strictEqual(typeof route.getEffectiveRoute, 'function');
  console.log('app route decision workflow ok');
})();
