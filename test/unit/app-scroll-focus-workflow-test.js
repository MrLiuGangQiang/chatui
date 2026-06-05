const assert = require('assert');
const workflow = require('../../client/app/scroll-focus-workflow');

(function run() {
  const scroll = workflow.createScrollFocusWorkflow({ state: { activeSessionId: 's1', activeOutputSessions: new Map(), busySessions: new Set(), streamFocusLocked: false, userScrollLocked: false, autoScrollLocked: false } });
  assert.strictEqual(typeof scroll.focusSessionTail, 'function');
  assert.strictEqual(typeof scroll.scrollToActiveOutput, 'function');
  assert.strictEqual(typeof scroll.markManualMessageScroll, 'function');
  assert.strictEqual(scroll.shouldFollowScroll(), false);
  scroll.cancelScrollTimer();
  console.log('app scroll focus workflow ok');
})();
