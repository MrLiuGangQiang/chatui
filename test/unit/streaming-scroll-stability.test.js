'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { createScrollFocusWorkflow } = require('../../client/app/scroll-focus-workflow');

function defineMetric(element, name, value) {
  Object.defineProperty(element, name, { configurable: true, get: () => value, set: next => { value = Number(next) || 0; } });
}

function createScrollFixture({ outputRect = { top: 120, bottom: 300 }, later = false, omitDependencyGetComputedStyle = false } = {}) {
  const laterMarkup = later ? '<article class="message assistant"><div class="content"></div></article>' : '';
  const dom = new JSDOM(`
    <main>
      <section id="messages"><article class="message assistant" data-streaming="1" data-session-id="session-a"><div class="content"></div></article>${laterMarkup}</section>
      <form class="composer"></form>
      <button id="resumeStreamBtn" type="button"></button>
    </main>
  `);
  const { document } = dom.window;
  const messages = document.getElementById('messages');
  const output = messages.querySelector('.message');
  const composer = document.querySelector('.composer');
  const mutationObservers = [];
  const rafCallbacks = new Map();
  let nextRafId = 0;

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      mutationObservers.push(this);
    }
    observe() {}
    disconnect() {}
  }

  const fakeWindow = {
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame(callback) {
      const id = ++nextRafId;
      rafCallbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { rafCallbacks.delete(id); },
    innerHeight: 600,
    getComputedStyle: () => ({ overflowY: 'auto', getPropertyValue: () => '168px' }),
  };

  let scrollTop = 0;
  defineMetric(messages, 'scrollTop', scrollTop);
  Object.defineProperty(messages, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: value => { scrollTop = Number(value) || 0; },
  });
  defineMetric(messages, 'scrollHeight', 2_000);
  defineMetric(messages, 'clientHeight', 500);
  messages.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 900, width: 900, height: 500 });
  output.getBoundingClientRect = () => ({ ...outputRect, left: 80, right: 820, width: 740, height: outputRect.bottom - outputRect.top });
  composer.getBoundingClientRect = () => ({ top: 500, bottom: 580, left: 80, right: 820, width: 740, height: 80 });

  const state = {
    activeSessionId: 'session-a',
    activeOutputSessions: new Map(),
    busySessions: new Set(['session-a']),
    activeOutputNode: null,
    autoScrollLocked: false,
    bottomScrollLocked: false,
    userScrollLocked: false,
    streamFocusLocked: false,
    userScrolledAway: false,
    programmaticScrollUntil: 0,
    lastMessageScrollTop: 0,
    resumeButtonSuppressUntil: 0,
    outputPinSuppressUntil: 0,
    scrollVersion: 0,
  };
  const workflow = createScrollFocusWorkflow({
    state,
    window: fakeWindow,
    document,
    innerHeight: 600,
    ...(omitDependencyGetComputedStyle ? {} : { getComputedStyle: () => ({ overflowY: 'auto', getPropertyValue: () => '168px' }) }),
    getActiveRun: () => ({ token: 'run-a' }),
    $: id => document.getElementById(id),
  });

  const flushRafs = () => {
    const callbacks = [...rafCallbacks.values()];
    rafCallbacks.clear();
    callbacks.forEach(callback => callback());
  };

  return { dom, document, state, workflow, messages, output, mutationObservers, rafCallbacks, flushRafs };
}

function testHistoricalStreamDoesNotRaceTheSessionTailLock() {
  const { document, state, workflow, messages, output, mutationObservers } = createScrollFixture();
  workflow.activateBottomScrollLock();
  assert.strictEqual(mutationObservers.length, 1, 'the normal tail lock must have installed its mutation observer');

  messages.scrollTop = 220;
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: false });
  assert.strictEqual(state.streamFocusLocked, true);
  assert.strictEqual(state.bottomScrollLocked, false, 'a historical replacement must not retain a competing session-tail lock');
  assert.strictEqual(output.dataset.streamTailLock, '0');

  mutationObservers[0].callback([{ type: 'childList', addedNodes: [document.createElement('span')], removedNodes: [] }]);
  assert.strictEqual(messages.scrollTop, 220,
    'stream growth in a historical replacement must not snap the viewport to the unrelated session tail');
}

function testNormalStreamingOutputDoesNotRaceTheSessionTailLock() {
  const { document, state, workflow, messages, output, mutationObservers } = createScrollFixture();
  workflow.activateBottomScrollLock();
  messages.scrollTop = 220;

  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true });

  assert.strictEqual(state.bottomScrollLocked, false,
    'a normal streaming response must use the live-output anchor as its only scroll writer');
  assert.strictEqual(output.dataset.streamTailLock, '0');
  mutationObservers[0].callback([{ type: 'childList', addedNodes: [document.createElement('span')], removedNodes: [] }]);
  assert.strictEqual(messages.scrollTop, 220,
    'a tail stream must not let the session-tail observer pull every visible message after a token update');
}

function testRecoveredHistoricalStreamInfersItsNonTailPlacement() {
  const { state, workflow, output } = createScrollFixture({ later: true });
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true });
  assert.strictEqual(state.bottomScrollLocked, false,
    'recovered streams with later message nodes must infer historical placement instead of restoring a conflicting tail lock');
  assert.strictEqual(output.dataset.streamTailLock, '0');
}

function testResumeOutputAnchorsToHistoricalStreamingMessage() {
  const { state, workflow, messages, output } = createScrollFixture({ outputRect: { top: 900, bottom: 1_100 }, later: true });
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: false });
  state.userScrollLocked = true;
  messages.scrollTop = 200;

  workflow.resumeActiveOutputFocus();

  assert.strictEqual(messages.scrollTop, 1_064,
    'continue output must first align the historical streaming message itself instead of jumping to the session tail or a fixed viewport target');
  assert.strictEqual(state.bottomScrollLocked, false, 'resuming a historical stream must preserve its no-tail-lock policy');
  assert.strictEqual(state.userScrollLocked, false);
}

function testResumeOutputAnchorsPartiallyVisibleStreamingMessageOnFirstClick() {
  const { state, workflow, messages, output } = createScrollFixture({ later: true });
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: false });
  output.getBoundingClientRect = () => {
    const top = 80 - messages.scrollTop;
    return { top, bottom: top + 380, left: 80, right: 820, width: 740, height: 380 };
  };
  state.userScrollLocked = true;
  messages.scrollTop = 200;

  workflow.resumeActiveOutputFocus();

  assert.strictEqual(messages.scrollTop, 44,
    'continue output must anchor a partially visible historical stream on the first click rather than treating overlap as already focused');
}

function testResumeUsesWindowComputedStyleWhenNoDependencyIsInjected() {
  const previousGetComputedStyle = global.getComputedStyle;
  global.getComputedStyle = () => ({ overflowY: 'auto', getPropertyValue: () => '168px' });
  try {
    const { state, workflow, messages, output } = createScrollFixture({ later: true, omitDependencyGetComputedStyle: true });
    workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: false });
    output.getBoundingClientRect = () => {
      const top = 80 - messages.scrollTop;
      return { top, bottom: top + 380, left: 80, right: 820, width: 740, height: 380 };
    };
    state.userScrollLocked = true;
    messages.scrollTop = 200;

    assert.doesNotThrow(() => workflow.resumeActiveOutputFocus(),
      'the resume path must use the browser getComputedStyle API when the workflow dependency is not injected');
    assert.strictEqual(messages.scrollTop, 44);
  } finally {
    if (previousGetComputedStyle === undefined) delete global.getComputedStyle;
    else global.getComputedStyle = previousGetComputedStyle;
  }
}

function testResumeCancelsQueuedTokenPinBeforeAnchoring() {
  const { state, workflow, messages, output, flushRafs } = createScrollFixture({ later: true });
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: false });
  output.getBoundingClientRect = () => {
    const top = 80 - messages.scrollTop;
    return { top, bottom: top + 600, left: 80, right: 820, width: 740, height: 600 };
  };
  workflow.scrollToActiveOutput(output, { force: true, active: true, tailLock: false });
  state.userScrollLocked = true;
  messages.scrollTop = 200;

  workflow.resumeActiveOutputFocus();
  assert.strictEqual(messages.scrollTop, 44, 'the first click must place the historical message anchor');
  flushRafs();
  assert.strictEqual(messages.scrollTop, 44,
    'a token pin queued before the click must be cancelled instead of undoing the first-click anchor');
}

function testHistoricalStreamingKeepsItsTopAnchorAcrossTokenGrowth() {
  const { workflow, messages, output, flushRafs } = createScrollFixture({ later: true });
  let height = 600;
  output.getBoundingClientRect = () => {
    const top = 400 - messages.scrollTop;
    return { top, bottom: top + height, left: 80, right: 820, width: 740, height };
  };
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: false });
  messages.scrollTop = 364;

  workflow.scrollToActiveOutput(output, { force: true, active: true, tailLock: false });
  flushRafs();
  assert.strictEqual(messages.scrollTop, 364,
    'a historical stream with later messages must retain the live message top instead of bottom-pinning the list on every token');

  height += 160;
  workflow.scrollToActiveOutput(output, { force: true, active: true, tailLock: false });
  flushRafs();
  assert.strictEqual(messages.scrollTop, 364,
    'stream growth must not repeatedly move lower history messages by rewriting the scroller position');
}

function testHistoricalResumeAnchorSurvivesTheNextToken() {
  const { state, workflow, messages, output, flushRafs } = createScrollFixture({ later: true });
  output.getBoundingClientRect = () => {
    const top = 80 - messages.scrollTop;
    return { top, bottom: top + 600, left: 80, right: 820, width: 740, height: 600 };
  };
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: false });
  state.userScrollLocked = true;
  messages.scrollTop = 200;

  workflow.resumeActiveOutputFocus();
  assert.strictEqual(messages.scrollTop, 44,
    'the first continue-output click must place the historical live message at its top anchor');

  workflow.scrollToActiveOutput(output, { force: true, active: true, tailLock: false });
  flushRafs();
  assert.strictEqual(messages.scrollTop, 44,
    'the next token must preserve the first-click historical top anchor instead of replacing it with a bottom anchor');
}

function testHistoricalTopAnchorKeepsContinueButtonFocused() {
  const { workflow, messages, output } = createScrollFixture({ later: true });
  output.getBoundingClientRect = () => {
    const top = 400 - messages.scrollTop;
    return { top, bottom: top + 600, left: 80, right: 820, width: 740, height: 600 };
  };
  messages.scrollTop = 364;

  assert.strictEqual(workflow.isNodeAwayFromOutputFocus(output), false,
    'a historical live message whose top is at the focus target is already in focus even when its growing bottom extends below the composer');
}

function testTailStreamingStillPinsTheOutputBottom() {
  const { workflow, messages, output, flushRafs } = createScrollFixture();
  output.getBoundingClientRect = () => {
    const top = 80 - messages.scrollTop;
    return { top, bottom: top + 600, left: 80, right: 820, width: 740, height: 600 };
  };
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: false });
  messages.scrollTop = 44;

  workflow.scrollToActiveOutput(output, { force: true, active: true, tailLock: false });
  flushRafs();

  assert.strictEqual(messages.scrollTop, 252,
    'a normal tail stream must continue to follow its latest output at the bottom target');
}

function testProgrammaticStreamScrollNeverRearmsTailLock() {
  const { state, workflow, messages, output } = createScrollFixture();
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: false });
  workflow.setMessagesProgrammaticScroll(1_000);
  messages.scrollTop = 1_500;

  workflow.markManualMessageScroll({ type: 'scroll', target: messages, currentTarget: messages });

  assert.strictEqual(state.bottomScrollLocked, false,
    'a programmatic stream scroll at the physical bottom must not resurrect the competing tail observer');
}

function testStreamingHoverKeepsScrollerWidthStable() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.match(css, /\.messages\{[\s\S]{0,500}scrollbar-gutter:stable!important;[\s\S]{0,500}overflow-anchor:none!important;/,
    'the streaming message scroller must reserve its scrollbar gutter so hover-revealed scrollbars cannot rewrap live text and cause a render/scroll flicker loop');
}

function testChatStreamingUsesTheLiveOutputAnchorInsteadOfTailLock() {
  const chatSource = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  const messageSource = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const resumeSource = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  assert.ok(chatSource.includes('streamTailLock=!1'),
    'chat streams must opt out of the competing session-tail lock from their first frame');
  assert.ok(chatSource.includes('tailLock:streamTailLock'),
    'the chat workflow must pass the live-output scroll policy into the shared scroll focus workflow');
  assert.ok(messageSource.includes('tailLock: s.tailLock === true'),
    'stream updates without an explicit tail-lock opt-in must keep the live output as the only scroll writer');
  assert.strictEqual((messageSource.match(/pinActiveOutputToAnchor\(e, \{ margin: 72 \}\)/g) || []).length, 4,
    'stream completion must preserve the placement-aware anchor instead of reintroducing a bottom pin');
  assert.ok(appSource.includes('function pinActiveOutputToAnchor(e,t={}){return getScrollFocusWorkflow().pinActiveOutputToAnchor(e,t)}'),
    'the browser entry point must inject the placement-aware output anchor into message finalization');
  assert.strictEqual((resumeSource.match(/tailLock: !1/g) || []).length, 3,
    'recovered image and chat streams must also disable the competing session-tail lock');
}

module.exports = [
  testHistoricalStreamDoesNotRaceTheSessionTailLock,
  testNormalStreamingOutputDoesNotRaceTheSessionTailLock,
  testRecoveredHistoricalStreamInfersItsNonTailPlacement,
  testResumeOutputAnchorsToHistoricalStreamingMessage,
  testResumeOutputAnchorsPartiallyVisibleStreamingMessageOnFirstClick,
  testResumeUsesWindowComputedStyleWhenNoDependencyIsInjected,
  testResumeCancelsQueuedTokenPinBeforeAnchoring,
  testHistoricalStreamingKeepsItsTopAnchorAcrossTokenGrowth,
  testHistoricalResumeAnchorSurvivesTheNextToken,
  testHistoricalTopAnchorKeepsContinueButtonFocused,
  testTailStreamingStillPinsTheOutputBottom,
  testProgrammaticStreamScrollNeverRearmsTailLock,
  testStreamingHoverKeepsScrollerWidthStable,
  testChatStreamingUsesTheLiveOutputAnchorInsteadOfTailLock,
];
