'use strict';

const assert = require('assert');
const preview = require('../../client/features/messages/markdown-preview');
const markdownEngine = require('../../client/app/markdown/markdown-engine');

function testLargeMarkdownPreviewKeepsTableAlignmentSemantics() {
  const html = preview.renderMarkdownPreview('| Left | Center | Right |\n| :--- | :---: | ---: |\n| A | B | C |');
  assert.ok(html.includes('<th class="md-align-left">Left</th>'));
  assert.ok(html.includes('<th class="md-align-center">Center</th>'));
  assert.ok(html.includes('<th class="md-align-right">Right</th>'));
  assert.ok(html.includes('<td class="md-align-center">B</td>'));
  assert.ok(html.includes('<td class="md-align-right">C</td>'));
}

function testDefaultTableColumnsUseExplicitLeftAlignment() {
  const source = '| Name | Status |\n| --- | --- |\n| ChatUI | Ready |';
  const previewHtml = preview.renderMarkdownPreview(source);
  const finalHtml = markdownEngine.renderMarkdown(source);
  assert.ok(previewHtml.includes('<th class="md-align-left">Name</th>'));
  assert.ok(previewHtml.includes('<td class="md-align-left">Ready</td>'));
  assert.ok(finalHtml.includes('<th class="md-align-left">Name</th>'));
  assert.ok(finalHtml.includes('<td class="md-align-left">Ready</td>'));
}

module.exports = [testLargeMarkdownPreviewKeepsTableAlignmentSemantics, testDefaultTableColumnsUseExplicitLeftAlignment];
