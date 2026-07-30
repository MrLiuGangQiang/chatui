const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const {
  createSessionTouchGesture,
  createSessionUiWorkflow,
  isSessionActionTarget,
  shouldSwitchSessionOnPointerDown,
  shouldSwitchSessionOnTouchPointerUp,
  updateSessionTouchGesture,
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

function touchEvent(dom, type, overrides = {}) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({
    pointerType: 'touch', pointerId: 7, button: 0, isPrimary: true, clientX: 20, clientY: 30, ...overrides,
  })) Object.defineProperty(event, key, { configurable: true, value });
  return event;
}

function testTouchTapSwitchesOnPointerUpButScrollMovementDoesNot() {
  const target = targetMatching();
  const start = createSessionTouchGesture({ pointerType: 'touch', pointerId: 3, button: 0, isPrimary: true, clientX: 10, clientY: 10, target });
  assert.ok(start);
  assert.strictEqual(shouldSwitchSessionOnTouchPointerUp({ pointerType: 'touch', pointerId: 3, clientX: 15, clientY: 14, target }, start), true);

  const moved = createSessionTouchGesture({ pointerType: 'touch', pointerId: 4, button: 0, isPrimary: true, clientX: 10, clientY: 10, target });
  updateSessionTouchGesture(moved, { pointerType: 'touch', pointerId: 4, clientX: 34, clientY: 10 });
  assert.strictEqual(shouldSwitchSessionOnTouchPointerUp({ pointerType: 'touch', pointerId: 4, clientX: 34, clientY: 10, target }, moved), false);
}

function testTouchPointerUpSwitchesEvenAfterTheSessionListRerenders() {
  const dom = new JSDOM('<nav id="sessionList"></nav>');
  const state = {
    sessions: [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }],
    activeSessionId: 'first',
  };
  const switched = [];
  const workflow = createSessionUiWorkflow({
    getState: () => state,
    getElement: id => dom.window.document.getElementById(id),
    document: dom.window.document,
    sessionTitleHtml: session => session.title,
    getSessionReturnCount: () => 0,
    isSessionBusy: () => false,
    switchSession: id => switched.push(id),
  });

  workflow.renderSessionList();
  const detachedTab = dom.window.document.querySelector('[data-session-id="second"]');
  detachedTab.dispatchEvent(touchEvent(dom, 'pointerdown'));
  workflow.renderSessionList();
  assert.strictEqual(detachedTab.isConnected, false, 'the regression requires a list refresh to detach the touched tab');
  const replacementTab = dom.window.document.querySelector('[data-session-id="second"]');
  replacementTab.dispatchEvent(touchEvent(dom, 'pointerup'));
  replacementTab.dispatchEvent(touchEvent(dom, 'click'));
  assert.deepStrictEqual(switched, ['second'], 'the stable list must finish the original touch exactly once on the replacement tab');
}

function testMobileSessionTouchFixHasACacheVersion() {
  const index = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  assert.ok(index.includes('session-ui-workflow.js?v=1.3.16-mode-isolation-mobile-touch-switch'));
}

module.exports = [
  testMouseAndPenSwitchBeforeConcurrentSessionListRefreshDropsClick,
  testTouchSecondaryButtonsAndSessionActionsStayOnTheirOriginalPaths,
  testTouchTapSwitchesOnPointerUpButScrollMovementDoesNot,
  testTouchPointerUpSwitchesEvenAfterTheSessionListRerenders,
  testMobileSessionTouchFixHasACacheVersion,
];
