'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const messageWorkflow = require('../../client/app/message-workflow');

function lastRuleBody(css, selector) {
  let start = css.lastIndexOf(selector);
  assert.ok(start >= 0, `missing CSS rule: ${selector}`);
  const bodyStart = css.indexOf('{', start);
  const bodyEnd = css.indexOf('}', bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, `invalid CSS rule: ${selector}`);
  return css.slice(bodyStart + 1, bodyEnd);
}

// A message that was streaming and then reaches a terminal state (completed,
// manually stopped, or failed) must leave both the streaming guard and the
// transient persist guard, so the action controls are visible exactly like any
// other finished message. Stopping previously deleted `data-streaming` but kept
// `data-persist="0"`, leaving the action row permanently hidden.
function testTerminalReconcileClearsStreamingAndTransientGuards() {
  const dom = new JSDOM('<article class="message assistant" data-streaming="1" data-stream-kind="chat" data-stream-run-token="run" data-pending-feedback="1" data-job-id="chatjob-a" data-persist="0" data-session-id="session-a"><div class="msg-actions" hidden aria-hidden="true"></div></article>');
  const node = dom.window.document.querySelector('.message');
  node.__displayItem = { id: 'stale-display', pending: '1', jobId: 'chatjob-a' };
  let resetCalls = 0;
  messageWorkflow.reconcileCompletedMessageUi(node, () => { resetCalls += 1; });

  assert.strictEqual(node.dataset.streaming, undefined, 'streaming guard must be cleared on terminal state');
  assert.strictEqual(node.dataset.streamKind, undefined);
  assert.strictEqual(node.dataset.streamRunToken, undefined);
  assert.strictEqual(node.dataset.pendingFeedback, undefined);
  assert.strictEqual(node.dataset.jobId, undefined);
  assert.strictEqual(node.dataset.persist, undefined, 'transient persist guard must be cleared so the action row becomes visible');
  assert.strictEqual(node.dataset.sessionId, undefined);
  assert.strictEqual(node.__displayItem.pending, '', 'stale projection ownership must be cleared');
  assert.strictEqual(node.__displayItem.jobId, '', 'stale job ownership must be cleared');
  assert.strictEqual(node.querySelector('.msg-actions').hidden, false);
  assert.strictEqual(node.querySelector('.msg-actions').hasAttribute('aria-hidden'), false);
  assert.strictEqual(resetCalls, 1);
}

// The stop path must match a live streaming message (not only one that still has
// pending feedback / a durable job id / a reasoning panel), and must delegate the
// terminal cleanup to the shared reconciler that also clears the persist guard.
function testStopFinalizationTargetsStreamingMessagesAndClearsPersist() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const stopping = app.slice(app.indexOf('function markStoppingTask'), app.indexOf('function finalizeStoppedTask'));
  assert.ok(
    stopping.includes('.message.assistant[data-streaming="1"]'),
    'markStoppingTask must match a live streaming assistant message',
  );
  const stopped = app.slice(app.indexOf('function markMessageStopped'), app.indexOf('function removeGeneratedImageInlineActions'));
  assert.ok(
    stopped.includes('reconcileCompletedMessageUi'),
    'markMessageStopped must delegate terminal cleanup to the shared reconciler',
  );
  assert.ok(
    stopped.includes('delete e.dataset.persist'),
    'markMessageStopped must clear the transient persist guard so stopped messages show actions',
  );
}

// CSS visibility must be a deterministic function of message state:
// hidden while streaming or while the transient placeholder is pending, and fully
// visible once terminal or once a user message has been sent.
function testActionVisibilityIsDeterministicByMessageState() {
  const flatThemeCss = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');

  const streaming = lastRuleBody(flatThemeCss, '.message[data-streaming="1"] .msg-actions');
  assert.match(streaming, /visibility:hidden!important/, 'streaming action row must be hidden');
  assert.match(streaming, /opacity:0!important/, 'streaming action row must be invisible');

  const pending = lastRuleBody(flatThemeCss, '.message.assistant[data-persist="0"] .msg-actions');
  assert.match(pending, /visibility:hidden!important/, 'pending placeholder action row must be hidden');
  assert.match(pending, /opacity:0!important/, 'pending placeholder action row must be invisible');

  const terminal = lastRuleBody(flatThemeCss, '.message.assistant:not([data-streaming="1"]):not([data-persist="0"]) .msg-actions');
  assert.match(terminal, /opacity:1!important/, 'terminal assistant action row must be fully visible');
  assert.match(terminal, /pointer-events:auto!important/, 'terminal assistant actions must be interactive');

  const user = lastRuleBody(flatThemeCss, '.message.user .msg-actions');
  assert.match(user, /opacity:1!important/, 'sent user action row must be fully visible');
  assert.match(user, /pointer-events:auto!important/, 'sent user actions must be interactive');
  assert.doesNotMatch(user, /position:absolute!important/, 'sent user actions must not overlay the following message');
}

module.exports = [
  testTerminalReconcileClearsStreamingAndTransientGuards,
  testStopFinalizationTargetsStreamingMessagesAndClearsPersist,
  testActionVisibilityIsDeterministicByMessageState,
];
