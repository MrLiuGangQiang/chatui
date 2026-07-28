const assert = require('assert');

const {
  isSessionActionTarget,
  shouldSwitchSessionOnPointerDown,
} = require('../../client/app/session-ui-workflow');

function targetMatching(selector = '') {
  return { closest: query => query.split(',').map(value => value.trim()).includes(selector) ? {} : null };
}

function testMouseAndPenSwitchBeforeConcurrentSessionListRefreshDropsClick() {
  assert.strictEqual(shouldSwitchSessionOnPointerDown({ button: 0, pointerType: 'mouse', target: targetMatching() }), true);
  assert.strictEqual(shouldSwitchSessionOnPointerDown({ button: 0, pointerType: 'pen', target: targetMatching() }), true);
}

function testTouchSecondaryButtonsAndSessionActionsStayOnTheirOriginalPaths() {
  assert.strictEqual(shouldSwitchSessionOnPointerDown({ button: 0, pointerType: 'touch', target: targetMatching() }), false);
  assert.strictEqual(shouldSwitchSessionOnPointerDown({ button: 2, pointerType: 'mouse', target: targetMatching() }), false);
  assert.strictEqual(shouldSwitchSessionOnPointerDown({ button: 0, pointerType: 'mouse', target: targetMatching('.session-delete-btn') }), false);
  assert.strictEqual(isSessionActionTarget(targetMatching('.session-title-input')), true);
}

module.exports = [
  testMouseAndPenSwitchBeforeConcurrentSessionListRefreshDropsClick,
  testTouchSecondaryButtonsAndSessionActionsStayOnTheirOriginalPaths,
];
