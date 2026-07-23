'use strict';

const assert = require('assert');
const preview = require('../../client/features/messages/markdown-preview');

function testLargeMarkdownPreviewKeepsTableAlignmentSemantics() {
  const html = preview.renderMarkdownPreview('| Left | Center | Right |\n| :--- | :---: | ---: |\n| A | B | C |');
  assert.ok(html.includes('<th class="md-align-left">Left</th>'));
  assert.ok(html.includes('<th class="md-align-center">Center</th>'));
  assert.ok(html.includes('<th class="md-align-right">Right</th>'));
  assert.ok(html.includes('<td class="md-align-center">B</td>'));
  assert.ok(html.includes('<td class="md-align-right">C</td>'));
}

module.exports = [testLargeMarkdownPreviewKeepsTableAlignmentSemantics];
