#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const baseCss = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const composerCss = fs.readFileSync(path.join(root, 'styles/composer.css'), 'utf8');
const messageCss = fs.readFileSync(path.join(root, 'styles/messages.css'), 'utf8');
const css = `${baseCss}\n${composerCss}\n${messageCss}`;

function assertContains(snippet, message, source = css) {
  assert.ok(source.includes(snippet), message || `css contains ${snippet}`);
}

function assertNotContains(snippet, message, source = css) {
  assert.ok(!source.includes(snippet), message || `css does not contain ${snippet}`);
}

function assertRuleIncludes(selectorSnippet, requiredSnippets, { last = false, source = css } = {}) {
  const selectorIndex = last ? source.lastIndexOf(selectorSnippet) : source.indexOf(selectorSnippet);
  assert.ok(selectorIndex >= 0, `selector exists: ${selectorSnippet}`);
  const blockStart = source.indexOf('{', selectorIndex);
  assert.ok(blockStart >= 0, `rule block starts: ${selectorSnippet}`);
  const blockEnd = source.indexOf('}', blockStart);
  assert.ok(blockEnd > blockStart, `rule block ends: ${selectorSnippet}`);
  const block = source.slice(blockStart + 1, blockEnd);
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
  '.session-rail',
  '.config-dialog',
  '.prompt-config-layout',
]) {
  assertContains(selector, `critical selector exists: ${selector}`);
}

// Split CSS scope contract: composer.css must not style dialogs, messages, markdown, or global layout.
for (const forbidden of [
  '#configModal',
  '.config-dialog',
  '.prompt-config-layout',
  '.session-prompt-panel',
  '.message.',
  '.message{',
  '.messages{',
  '.markdown-body',
  '.main{',
  ':root{',
]) {
  assertNotContains(forbidden, `composer CSS must stay scoped and not include ${forbidden}`, composerCss);
}
assertContains('Composer layout contract overrides.', 'composer CSS contract comment exists', composerCss);
assertContains('.composer-actions{', 'composer CSS contains action row rules', composerCss);
assertContains('.input-stack{', 'composer CSS contains input stack rules', composerCss);
assertContains('env(safe-area-inset-bottom)', 'composer mobile safe-area bottom is preserved', composerCss);

// Timing metadata must float above bubbles and must not reintroduce normal-flow padding regressions.
assertContains('Message layout contract overrides.', 'message CSS contract comment exists', messageCss);
assertContains('Keep timing metadata floating above bubbles without changing message/avatar/action layout.', 'timing meta contract comment exists', messageCss);
assertRuleIncludes('.message-meta', [
  'position:absolute!important',
  'top:-18px!important',
  'bottom:auto!important',
  'pointer-events:none!important',
  'white-space:nowrap!important',
], { source: messageCss });
assertRuleIncludes('.bubble-wrap:has(.message-meta)', [
  'padding-bottom:0!important',
], { last: true, source: messageCss });
assertRuleIncludes('Message action buttons live in normal flow below the bubble; never overlay content. */\n.bubble-wrap', [
  'position:relative!important',
], { source: messageCss });
assertContains('.msg-actions,\n.message.assistant.has-meta .msg-actions,\n.message.error.has-meta .msg-actions,\n.message.user.has-meta .msg-actions{\n  position:static!important;\n  order:2!important;\n  top:auto!important;\n  bottom:auto!important;', 'message actions must be normal flow and never overlay content', messageCss);
assertContains('margin:2px 0 0!important;', 'message actions keep a tight gap below the bubble', messageCss);
const template = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const templateBubbleIndex = template.indexOf('<div class="bubble">');
const templateActionsIndex = template.indexOf('<div class="msg-actions">');
assert(templateBubbleIndex >= 0 && templateActionsIndex >= 0 && templateBubbleIndex < templateActionsIndex, 'message template must put bubble before action buttons so actions cannot appear inside/over content when CSS order is stale');

assertContains('.message:has(.msg-actions){\n  margin-bottom:18px!important;', 'messages with actions keep original row spacing', messageCss);

console.log('css contract ok');
