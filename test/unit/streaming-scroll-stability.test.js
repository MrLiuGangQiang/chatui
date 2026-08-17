'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { createScrollFocusWorkflow } = require('../../client/app/scroll-focus-workflow');

function defineMetric(element, name, value) {
  Object.defineProperty(element, name, { configurable: true, get: () => value, set: next => { value = Number(next) || 0; } });
}

function createScrollFixture({ outputRect = { top: 120, bottom: 300 }, later = false } = {}) {
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
  const rafCallbacks = [];

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
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    },
    cancelAnimationFrame() {},
    innerHeight: 600,
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
    getComputedStyle: () => ({ overflowY: 'auto', getPropertyValue: () => '168px' }),
    getActiveRun: () => ({ token: 'run-a' }),
    $: id => document.getElementById(id),
  });

  return { dom, document, state, workflow, messages, output, mutationObservers, rafCallbacks };
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

function testNormalTailStreamKeepsTailLock() {
  const { state, workflow, output } = createScrollFixture();
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: true });
  assert.strictEqual(state.bottomScrollLocked, true, 'a new tail response must keep tail compensation enabled');
  assert.strictEqual(output.dataset.streamTailLock, '1');
}


function testRecoveredHistoricalStreamInfersItsNonTailPlacement() {
  const { state, workflow, output } = createScrollFixture({ later: true });
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true });
  assert.strictEqual(state.bottomScrollLocked, false,
    'recovered streams with later message nodes must infer historical placement instead of restoring a conflicting tail lock');
  assert.strictEqual(output.dataset.streamTailLock, '0');
}

function testResumeOutputAnchorsToHistoricalStreamingMessage() {
  const { state, workflow, messages, output } = createScrollFixture({ outputRect: { top: 900, bottom: 1_100 } });
  workflow.armStreamingOutputFocus('session-a', output, { clearStaleFocus: true, tailLock: false });
  state.userScrollLocked = true;
  messages.scrollTop = 200;

  workflow.resumeActiveOutputFocus();

  assert.strictEqual(messages.scrollTop, 1_064,
    'continue output must first align the historical streaming message itself instead of jumping to the session tail or a fixed viewport target');
  assert.strictEqual(state.bottomScrollLocked, false, 'resuming a historical stream must preserve its no-tail-lock policy');
  assert.strictEqual(state.userScrollLocked, false);
}

function testStreamingHoverKeepsScrollerWidthStable() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.match(css, /\.messages\{[\s\S]{0,500}scrollbar-gutter:stable!important;[\s\S]{0,500}overflow-anchor:none!important;/,
    'the streaming message scroller must reserve its scrollbar gutter so hover-revealed scrollbars cannot rewrap live text and cause a render/scroll flicker loop');
}

function testChatWorkflowMarksReplacementsAsNonTailStreams() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  assert.ok(source.includes('streamTailLock=!Number.isFinite(n.replaceAssistantIndex)'),
    'the chat workflow must classify regenerated responses as historical/non-tail streams');
  assert.ok(source.includes('tailLock:streamTailLock'),
    'the chat workflow must pass the stream placement policy into the shared scroll focus workflow');
}

module.exports = [
  testHistoricalStreamDoesNotRaceTheSessionTailLock,
  testNormalTailStreamKeepsTailLock,
  testRecoveredHistoricalStreamInfersItsNonTailPlacement,
  testResumeOutputAnchorsToHistoricalStreamingMessage,
  testStreamingHoverKeepsScrollerWidthStable,
  testChatWorkflowMarksReplacementsAsNonTailStreams,
];
