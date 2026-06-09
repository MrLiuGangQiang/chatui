#!/usr/bin/env node
const assert = require('assert');
const markdownUtils = require('../../client/app/markdown-utils');

assert.strictEqual(markdownUtils.slugifyHeading(' Hello, ChatUI! 你好 '), 'hello-chatui-你好');
assert.strictEqual(markdownUtils.slugifyHeading('A--- B'), 'a-b');

for (const removed of [
  'GFM_EMOJI_SHORTCODES',
  'replaceGfmEmojiShortcodes',
  'normalizeExtendedMarkdown',
  'prepareMarkdownSource',
  'extractMathSegments',
  'restoreMathSegments',
  'restoreRawMathSegments',
  'repairMarkdownPunctuation',
  'repairCollapsedMarkdownBlocks',
  'preserveCodeSpans',
  'restoreCodeSpans',
  'normalizeMathExpression',
  'repairLooseMathHtml',
  'normalizeLooseMath',
  'splitTableRow',
]) {
  assert.strictEqual(markdownUtils[removed], undefined, `${removed} should be handled by markdown-it/plugins, not app markdown utils`);
}

console.log('app markdown utils ok');
