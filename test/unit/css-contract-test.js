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


assertContains('.copy-btn.icon-action-btn,\n.copy-btn.icon-action-btn.copied,\n.copy-btn.icon-action-btn.copied:hover{\n  display:inline-grid!important;\n  place-items:center!important;', 'copy buttons use grid centering for success state', baseCss);
assertContains('.copy-btn.icon-action-btn.copied{\n  width:30px!important;\n  min-width:30px!important;\n  height:26px!important;\n  min-height:26px!important;\n  max-height:26px!important;\n  padding:0!important;\n  overflow:hidden!important;', 'copy success state keeps fixed icon-button size without inherited tall copied layout', baseCss);
assertContains('.copy-btn.icon-action-btn.copied svg,\n.copy-btn.icon-action-btn.copied .copy-success-icon{\n  display:block!important;\n  width:15px!important;\n  height:15px!important;\n  margin:auto!important;', 'copy success icon is centered inside the button', baseCss);


assertContains('/* Final copy success visual centering: center the checkmark stroke itself, not only the SVG box. */', 'final copy-success centering override exists', baseCss);
assertContains(`.copy-btn.icon-action-btn.copied .copy-success-icon path,
.markdown-body .code-block .code-copy-icon.copied .copy-success-icon path,
.reasoning-copy-btn.copied .copy-success-icon path{
  transform-box:fill-box!important;
  transform-origin:center center!important;
  transform:translate(2px,-1px)!important;`, 'copy success checkmark path is optically centered inside its svg box', baseCss);

assertContains('.image-preview-copy{right:122px!important}', 'image preview copy button sits between download and close controls', baseCss);
assertContains('.image-preview-action svg path,\n.image-preview-action svg rect{fill:none!important;stroke:currentColor!important;', 'image preview action icons use stroke rendering for copy/download svgs', baseCss);
console.log('css contract ok');

assertContains('id="imagePreviewCopy"', 'image preview keeps copy button in preview overlay only', template);
assertNotContains('generated-image-actions', 'generated image cards must not add extra per-image button row', baseCss);
assertNotContains('imageActionButtonsHtml(a,s)', 'generated image cards must not render extra per-image button row', fs.readFileSync(path.join(root, 'app.js'), 'utf8'));

assertContains('function removeGeneratedImageInlineActions', 'runtime cleanup removes previously cached generated image inline action rows', fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
assertContains('.content .generated-image-actions', 'runtime cleanup targets stale generated-image-actions saved in old messages', fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
assertContains('[data-copy-image]', 'runtime cleanup removes stale per-image copy buttons from generated image cards', fs.readFileSync(path.join(root, 'app.js'), 'utf8'));

assertContains('function canWriteImageClipboard(){return window.isSecureContext&&!!navigator.clipboard?.write&&"function"==typeof ClipboardItem}', 'image clipboard write requires secure context and ClipboardItem support', fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
assertContains('复制图片需要 HTTPS 或 localhost，当前局域网 HTTP 地址不支持', 'image preview copy explains HTTP LAN clipboard limitation', fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
assertContains(`.image-preview-action.is-disabled,
.image-preview-action:disabled{`, 'disabled image preview copy button has visible disabled state', baseCss);
