'use strict';

const assert = require('assert');
const markdownEngine = require('../../client/app/markdown/markdown-engine');

function testCompactCjkPunctuationBoldRendersWithoutLiteralAsterisks() {
  const source = [
    '成都温江今天（2026年9月3日，星期四）：',
    '**当前天气：**多云，约 22℃',
    '**明日（9月4日）：**晴间多云',
  ].join('\n');
  const html = markdownEngine.renderMarkdown(source);

  assert.match(html, /<strong>当前天气：<\/strong>/);
  assert.match(html, /<strong>明日（9月4日）：<\/strong>/);
  assert.strictEqual(html.includes('**当前天气：**'), false, 'compact CJK bold must not stay as literal markdown stars');
  assert.strictEqual(html.includes('**明日（9月4日）：**'), false, 'compact CJK bold with full-width punctuation must not stay literal');
}

function testCompactCjkPunctuationItalicRendersWithSingleAsterisk() {
  const html = markdownEngine.renderMarkdown('*天气趋势：*偏热');
  assert.match(html, /<em>天气趋势：<\/em>/);
  assert.strictEqual(html.includes('*天气趋势：*'), false);
}

function testCompactEmphasisDoesNotRewriteParsedCodeOrNormalBold() {
  const source = [
    '`**当前天气：**b` unchanged',
    '普通 **正常加粗** 继续',
    '```js',
    '// **当前天气：**b',
    '```',
  ].join('\n');
  const html = markdownEngine.renderMarkdown(source);

  assert.match(html, /<code>\*\*当前天气：\*\*b<\/code>/);
  assert.match(html, /<strong>正常加粗<\/strong>/);
  assert.ok(html.includes('// **当前天气：**b'), 'fenced code must keep its raw asterisks');
}

module.exports = [
  testCompactCjkPunctuationBoldRendersWithoutLiteralAsterisks,
  testCompactCjkPunctuationItalicRendersWithSingleAsterisk,
  testCompactEmphasisDoesNotRewriteParsedCodeOrNormalBold,
];
