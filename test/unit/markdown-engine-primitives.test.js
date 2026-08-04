'use strict';

const assert = require('assert');
const primitives = require('../../client/app/markdown/engine-primitives');
const markdownEngine = require('../../client/app/markdown/markdown-engine');

function createToken(attributes = {}) {
  return {
    attrs: Object.entries(attributes),
    attrGet(name) {
      const entry = this.attrs.find(([key]) => key === name);
      return entry ? entry[1] : null;
    },
    attrSet(name, value) {
      const index = this.attrIndex(name);
      if (index >= 0) this.attrs[index][1] = value;
      else this.attrs.push([name, value]);
    },
    attrIndex(name) {
      return this.attrs.findIndex(([key]) => key === name);
    },
  };
}

function testSharedMarkdownEnginePrimitivesAreImmutableAndReusedByNodeEngine() {
  assert.strictEqual(Object.isFrozen(primitives), true);
  assert.strictEqual(markdownEngine.MERMAID_LANGS, primitives.MERMAID_LANGS);
  assert.strictEqual(markdownEngine.normalizeBlockquoteFencedCodeContent, primitives.normalizeBlockquoteFencedCodeContent);
  assert.strictEqual(markdownEngine.decodeHtmlEntities, primitives.decodeHtmlEntities);
  assert.strictEqual(markdownEngine.highlightedTextMatchesSource, primitives.highlightedTextMatchesSource);
}

function testTaskListFallbackAddsSemanticClassesWithoutChangingExistingMarkup() {
  assert.strictEqual(
    primitives.applyTaskListFallback('<ul><li>[x] done</li><li>[ ] todo</li></ul>'),
    '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled checked> done</li><li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled> todo</li></ul>'
  );
  const existing = '<ul class="contains-task-list"><li class="task-list-item">done</li></ul>';
  assert.strictEqual(primitives.applyTaskListFallback(existing), existing);
}

function testTableAlignmentMovesAllowedAlignmentToClassAndPreservesOtherStyle() {
  const token = createToken({ style: 'color: red; text-align: CENTER;', class: 'existing' });
  primitives.normalizeTableAlignToken(token);
  assert.strictEqual(token.attrGet('style'), 'color: red');
  assert.strictEqual(token.attrGet('class'), 'existing md-align-center');

  primitives.normalizeTableAlignToken(token);
  assert.strictEqual(token.attrGet('class'), 'existing md-align-center', 'normalization must be idempotent');

  const defaultToken = createToken();
  primitives.normalizeTableAlignToken(defaultToken);
  assert.strictEqual(defaultToken.attrGet('class'), 'md-align-left');
}

function testBlockquoteFenceNormalizationPreservesMixedAndReplContent() {
  assert.strictEqual(
    primitives.normalizeBlockquoteFencedCodeContent('> const a = 1;\n> console.log(a);\n'),
    'const a = 1;\nconsole.log(a);\n'
  );
  assert.strictEqual(primitives.normalizeBlockquoteFencedCodeContent('> quoted\nplain\n'), '> quoted\nplain\n');
  assert.strictEqual(primitives.normalizeBlockquoteFencedCodeContent('>>> prompt\n>>> next\n'), '>>> prompt\n>>> next\n');
}

function testHighlightValidationDecodesOnlyRenderedTextEntities() {
  assert.strictEqual(primitives.decodeHtmlEntities('&lt;a&gt;&#x1F600;&#39;'), "<a>😀'");
  assert.strictEqual(primitives.highlightedTextMatchesSource('<span>&lt;a&gt;</span>', '<a>'), true);
  assert.strictEqual(primitives.highlightedTextMatchesSource('<span>changed</span>', '<a>'), false);
}

module.exports = [
  testSharedMarkdownEnginePrimitivesAreImmutableAndReusedByNodeEngine,
  testTaskListFallbackAddsSemanticClassesWithoutChangingExistingMarkup,
  testTableAlignmentMovesAllowedAlignmentToClassAndPreservesOtherStyle,
  testBlockquoteFenceNormalizationPreservesMixedAndReplContent,
  testHighlightValidationDecodesOnlyRenderedTextEntities,
];
