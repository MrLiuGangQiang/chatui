'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
require('../../client/app/app-context');
require('../../client/features/messages/message-model');
require('../../client/features/messages/message-domain');
require('../../client/features/messages/quote-preview');
const messageWorkflow = require('../../client/app/message-workflow');

function testQuoteJumpCancelsCompetingTailFocusBeforeScrolling() {
  const dom = new JSDOM('<div id="messages"><article class="message assistant" data-response-index="1" data-raw-text="quoted answer"></article></div>');
  const document = dom.window.document;
  const messages = document.getElementById('messages');
  const target = messages.querySelector('.message');
  let manualMarks = 0;
  let tailCancels = 0;
  let timerCancels = 0;
  let releases = 0;

  Object.defineProperty(messages, 'scrollTop', { value: 500, writable: true, configurable: true });
  messages.getBoundingClientRect = () => ({ top: 100 });
  target.getBoundingClientRect = () => ({ top: 240 });

  const previous = {
    cancelSessionTailFocusAfterLayout: global.cancelSessionTailFocusAfterLayout,
    ChatUIScrollDebug: global.ChatUIScrollDebug,
    requestAnimationFrame: global.requestAnimationFrame,
  };
  global.cancelSessionTailFocusAfterLayout = () => { tailCancels += 1; };
  global.ChatUIScrollDebug = {
    releaseBottomScrollLock: () => { releases += 1; },
    cleanupBottomScrollLock: () => {},
  };
  global.requestAnimationFrame = () => 0;

  try {
    const workflow = messageWorkflow.createMessageWorkflow({
      state: { activeSessionId: 'session-a' },
      document,
      $: id => id === 'messages' ? messages : null,
      markManualMessageScroll: () => { manualMarks += 1; },
      cancelScrollTimer: () => { timerCancels += 1; },
    });
    assert.strictEqual(workflow.jumpToQuotedMessage({
      sessionId: 'session-a', role: 'assistant', responseIndex: '1', content: 'quoted answer',
    }), true);
    assert.strictEqual(manualMarks, 1, 'quote navigation must mark the scroll as manual');
    assert.strictEqual(tailCancels, 1, 'quote navigation must cancel pending tail-focus layout work');
    assert.strictEqual(timerCancels, 1, 'quote navigation must cancel queued scroll timers');
    assert.strictEqual(releases, 1, 'quote navigation must release the bottom-scroll lock');
    assert.strictEqual(messages.scrollTop, 622, 'the quoted message must be aligned below the top margin');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
    dom.window.close();
  }
}

module.exports = [testQuoteJumpCancelsCompetingTailFocusBeforeScrolling];

