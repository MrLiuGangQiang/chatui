'use strict';

const assert = require('assert');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const formatting = require('../../client/app/formatting');
const reasoning = require('../../client/app/reasoning-workflow');
const staticBundle = require('../../server/services/static-bundle.service');

const ROOT = path.join(__dirname, '../..');

function buildCssBundle() {
  const entries = staticBundle.parseAssetManifest(ROOT, ROOT + path.sep, 'css');
  return staticBundle.buildBundleBody(entries, 'css').toString('utf8');
}

function createReasoningFixture(markup = '<div class="content"></div>') {
  const dom = new JSDOM(
    '<style>' + buildCssBundle() + '</style><div class="message assistant"><div class="bubble">' + markup + '</div></div>',
    { virtualConsole: new VirtualConsole() },
  );
  const message = dom.window.document.querySelector('.message');
  const workflow = reasoning.createReasoningWorkflow({
    state: { reasoningMode: true, reasoningType: 'high', activeSessionId: 'session-1' },
    document: dom.window.document,
    renderMarkdown: value => '<p>' + String(value || '') + '</p>',
    scrollToActiveOutput: () => {},
  });
  return { dom, message, workflow };
}

function testLiveReasoningPanelUsesADistinctTintedSurface() {
  const fixture = createReasoningFixture();
  fixture.workflow.updateReasoning(fixture.message, 'thinking', { done: false });
  const panel = fixture.message.querySelector('.reasoning-panel');
  const panelStyle = fixture.dom.window.getComputedStyle(panel);
  const headStyle = fixture.dom.window.getComputedStyle(panel.querySelector('.reasoning-head'));

  assert.strictEqual(panelStyle.backgroundColor, 'rgb(236, 238, 241)',
    'the live thought area must use a restrained neutral-gray surface');
  assert.strictEqual(panelStyle.borderLeftWidth, '0px',
    'the thought area must stay flat without decorative borders');
  assert.strictEqual(panelStyle.borderRadius, '8px');
  assert.strictEqual(panelStyle.backdropFilter, 'none',
    'the thought surface must not keep a glass blur');
  assert.strictEqual(headStyle.backgroundColor, 'rgba(0, 0, 0, 0)',
    'the thought header must remain visually quiet');
  assert.strictEqual(fixture.dom.window.getComputedStyle(panel.querySelector('.reasoning-content')).color, 'rgb(85, 91, 100)',
    'thought text must remain distinguishable from the final-answer text color');
  fixture.dom.window.close();
}

function testCompletedReasoningCollapsesAndCanBeReopened() {
  const fixture = createReasoningFixture();
  fixture.workflow.updateReasoning(fixture.message, 'step one', { done: false });
  let panel = fixture.message.querySelector('.reasoning-panel');
  assert.strictEqual(panel.dataset.collapsed, '0', 'reasoning must remain open while it is streaming');

  fixture.workflow.updateReasoning(fixture.message, 'step one', { done: true });
  panel = fixture.message.querySelector('.reasoning-panel');
  assert.strictEqual(panel.dataset.collapsed, '1', 'completed reasoning must collapse by default');
  assert.strictEqual(panel.querySelector('.reasoning-toggle').getAttribute('aria-expanded'), 'false');
  assert.strictEqual(fixture.dom.window.getComputedStyle(panel.querySelector('.reasoning-content')).display, 'none');
  assert.match(panel.querySelector('.reasoning-content').textContent, /step one/,
    'collapsing must retain the reasoning content for later inspection');

  panel.querySelector('.reasoning-toggle').click();
  assert.strictEqual(panel.dataset.collapsed, '0', 'the user must be able to reopen completed reasoning');
  assert.strictEqual(panel.querySelector('.reasoning-toggle').getAttribute('aria-expanded'), 'true');
  fixture.dom.window.close();
}

function testDismissingIntentTraceRemovesTheWaitingSurfaceState() {
  const fixture = createReasoningFixture(
    '<details class="intent-reasoning-trace intent-waiting-surface is-running" open><summary><span class="intent-reasoning-title is-current-status">正在处理 已等待 122 秒</span></summary><div class="intent-reasoning-steps"></div></details>',
  );
  const trace = fixture.message.querySelector('.intent-reasoning-trace');

  assert.strictEqual(formatting.dismissIntentReasoningTrace(fixture.message), true);
  assert.strictEqual(fixture.message.querySelector('.intent-reasoning-trace'), null,
    'the waiting surface must disappear when upstream output starts');
  fixture.dom.window.close();
}

function testStreamingReasoningKeepsFullTextOffDomAttributesUntilDone() {
  const fixture = createReasoningFixture();
  const partial = 'reasoning '.repeat(20000);

  fixture.workflow.updateReasoning(fixture.message, partial, { done: false });
  assert.strictEqual(fixture.message.dataset.reasoningText, undefined,
    'streaming reasoning must not rewrite the complete text into a DOM attribute for every token');
  assert.strictEqual(fixture.message.__chatuiReasoningText, partial,
    'the full live reasoning must remain available in memory');

  fixture.workflow.updateReasoning(fixture.message, partial, { done: true });
  assert.strictEqual(fixture.message.dataset.reasoningText, partial,
    'completed reasoning must publish the final text for durability consumers');
  fixture.dom.window.close();
}

function testUnchangedStreamingReasoningDoesNotRerender() {
  const fixture = createReasoningFixture();
  fixture.workflow.updateReasoning(fixture.message, 'thinking', { done: false });
  const body = fixture.message.querySelector('.reasoning-content');
  const renderer = body.__reasoningStreamingRenderer;
  assert.ok(renderer?.set, "streaming reasoning must retain its renderer");
  let renders = 0;
  const originalSet = renderer.set.bind(renderer);
  renderer.set = (...args) => { renders += 1; return originalSet(...args); };

  fixture.workflow.updateReasoning(fixture.message, 'thinking', { done: false });
  assert.strictEqual(renders, 0,
    "unchanged reasoning must not rerender on every unrelated content token");
  fixture.workflow.updateReasoning(fixture.message, 'thinking more', { done: false });
  assert.strictEqual(renders, 1, "changed reasoning must still render");
  fixture.dom.window.close();
}

function testEmptyReasoningUpdateRemovesAnExistingPanel() {
  const fixture = createReasoningFixture();
  fixture.workflow.updateReasoning(fixture.message, 'thinking', { done: false });
  assert.ok(fixture.message.querySelector('.reasoning-panel'));

  fixture.workflow.updateReasoning(fixture.message, '', {
    forceDisplay: true,
    keepEmpty: true,
  });

  assert.strictEqual(fixture.message.querySelector('.reasoning-panel'), null,
    'an empty reasoning update must remove an already rendered thinking panel');
  assert.strictEqual(fixture.message.dataset.reasoningText, undefined,
    'empty reasoning must clear the stale reasoning text marker');
  fixture.dom.window.close();
}

function testEmptyReasoningUpdateDoesNotCreateAPanel() {
  const fixture = createReasoningFixture();
  fixture.workflow.updateReasoning(fixture.message, '', {
    forceDisplay: true,
    keepEmpty: true,
  });
  assert.strictEqual(fixture.message.querySelector('.reasoning-panel'), null,
    'an empty reasoning update must not synthesize a thinking panel');
  fixture.dom.window.close();
}

module.exports = [
  testLiveReasoningPanelUsesADistinctTintedSurface,
  testCompletedReasoningCollapsesAndCanBeReopened,
  testDismissingIntentTraceRemovesTheWaitingSurfaceState,
  testEmptyReasoningUpdateDoesNotCreateAPanel,
  testStreamingReasoningKeepsFullTextOffDomAttributesUntilDone,
  testUnchangedStreamingReasoningDoesNotRerender,
  testEmptyReasoningUpdateRemovesAnExistingPanel,
];
