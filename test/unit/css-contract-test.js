#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

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

// Layout anchors that must keep existing UI surfaces present.
for (const selector of [
  '.message',
  '.bubble-wrap',
  '.bubble',
  '.msg-actions',
  '.composer',
  '.composer-actions',
  '.session-sidebar',
  '.session-rail',
  '.config-dialog',
  '.prompt-config-layout',
]) {
  assertContains(selector, `critical selector exists: ${selector}`);
}

// Composer layout must keep the input stack, action row, and mobile safe-area placement stable.
assertContains('.composer-actions{position:absolute!important', 'composer actions should keep absolute positioning');
assertContains('.input-stack{margin:0 auto!important;display:grid!important', 'input stack should stay grid-based');
assertContains('env(safe-area-inset-bottom)', 'composer mobile safe-area bottom is preserved');

// Timing metadata must float above bubbles and must not reintroduce normal-flow padding regressions.
assertContains('Timing meta: float above the bubble without changing message/avatar/button layout.', 'timing meta contract comment exists');
assertRuleIncludes('Timing meta: float above the bubble without changing message/avatar/button layout. */\n.message-meta', [
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
