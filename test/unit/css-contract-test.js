#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const baseCss = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const composerCss = fs.readFileSync(path.join(root, 'styles/composer.css'), 'utf8');
const messageCss = fs.readFileSync(path.join(root, 'styles/messages.css'), 'utf8');
const css = `${baseCss}\n${composerCss}\n${messageCss}`;

function assertContains(snippet, message) {
  assert.ok(css.includes(snippet), message || `styles.css contains ${snippet}`);
}

function assertRuleIncludes(selectorSnippet, requiredSnippets, { last = false } = {}) {
  const selectorIndex = last ? css.lastIndexOf(selectorSnippet) : css.indexOf(selectorSnippet);
  assert.ok(selectorIndex >= 0, `selector exists: ${selectorSnippet}`);
  const blockStart = css.indexOf('{', selectorIndex);
  assert.ok(blockStart >= 0, `rule block starts: ${selectorSnippet}`);
  const blockEnd = css.indexOf('}', blockStart);
  assert.ok(blockEnd > blockStart, `rule block ends: ${selectorSnippet}`);
  const block = css.slice(blockStart + 1, blockEnd);
  for (const item of requiredSnippets) {
    assert.ok(block.includes(item), `${selectorSnippet} includes ${item}`);
  }
}

// Layout anchors that must keep existing UI surfaces present before CSS is split.
for (const selector of [
  '.message',
  '.bubble-wrap',
  '.bubble',
  '.msg-actions',
  '.composer',
  '.composer-actions',
  '.session-sidebar',
  '.session-rail',
]) {
  assertContains(selector, `critical selector exists: ${selector}`);
}

// Composer layout must keep the input stack, action row, and mobile safe-area placement stable.
assert.ok(composerCss.includes('Composer layout contract overrides'), 'composer CSS contract file is loaded by test');
assertRuleIncludes('Composer layout contract overrides.\n * Keep input stack, composer actions, and mobile safe-area placement stable while root CSS is split.\n */\n.composer-actions', [
  'position:absolute!important',
  'left:12px!important',
  'right:12px!important',
  'bottom:12px!important',
  'justify-content:space-between!important',
]);
assertRuleIncludes('.input-stack{margin:0 auto', [
  'display:grid!important',
  'grid-template-rows:auto 1fr auto!important',
]);
assert.ok(composerCss.includes('bottom:calc(8px + env(safe-area-inset-bottom))!important'), 'composer mobile safe-area bottom is preserved');

// Timing metadata must float above bubbles and must not reintroduce normal-flow padding regressions.
assert.ok(messageCss.includes('Message layout contract overrides'), 'message CSS contract file is loaded by test');
assertContains('Keep timing metadata floating above bubbles without changing message/avatar/action layout.', 'timing meta contract comment exists');
assertRuleIncludes('Message layout contract overrides.\n * Keep timing metadata floating above bubbles without changing message/avatar/action layout.\n */\n.message-meta', [
  'position:absolute!important',
  'top:-18px!important',
  'bottom:auto!important',
  'pointer-events:none!important',
  'white-space:nowrap!important',
]);
assertRuleIncludes('.bubble-wrap:has(.message-meta)', [
  'padding-bottom:0!important',
], { last: true });

console.log('css contract ok');
