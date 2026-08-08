'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const markdownEngine = require('../../client/app/markdown/markdown-engine');
const markdownPreview = require('../../client/features/messages/markdown-preview');
const streamingRenderer = require('../../client/app/markdown/browser-streaming-renderer');

function streamFixture() {
  return [
    ...Array.from({ length: 20 }, (_, index) => `第 ${String(index + 1).padStart(2, '0')} 行：CHATUI-STREAM-TEST`),
    'GLOBAL-CHAT-OK',
  ].join('\n');
}

function parseHtml(html = '') {
  return new JSDOM(`<!doctype html><body>${String(html || '')}</body>`).window.document;
}

function assertLineOrder(container, source) {
  let previous = -1;
  for (const line of source.split('\n')) {
    const current = container.textContent.indexOf(line);
    assert.ok(current > previous, `line must remain visible in order: ${line}`);
    previous = current;
  }
}

function testCanonicalAndLargePreviewPreserveEverySingleLineBreak() {
  const source = streamFixture();
  const canonicalDocument = parseHtml(markdownEngine.renderMarkdown(source));
  const canonicalParagraph = canonicalDocument.querySelector('p');
  assert.ok(canonicalParagraph);
  assert.strictEqual(canonicalParagraph.querySelectorAll('br').length, 20,
    'the canonical Markdown renderer must keep all 20 single newlines as visible breaks');
  assertLineOrder(canonicalParagraph, source);

  const previewDocument = parseHtml(markdownPreview.renderMarkdownPreview(source));
  const previewParagraph = previewDocument.querySelector('.markdown-preview-lite p');
  assert.ok(previewParagraph);
  assert.strictEqual(previewParagraph.querySelectorAll('br').length, 20,
    'the lightweight large-message preview must not join streamed lines with spaces');
  assertLineOrder(previewParagraph, source);

  assert.ok(canonicalParagraph.innerHTML.includes('<br>\nGLOBAL-CHAT-OK'));
  assert.ok(previewParagraph.innerHTML.includes('<br>GLOBAL-CHAT-OK'));
}

function testStreamingCompletionKeepsTheSameLineBreaksAsCanonicalRendering() {
  const source = streamFixture();
  const dom = new JSDOM('<!doctype html><div id="content" class="markdown-body"></div>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const container = dom.window.document.getElementById('content');
    const renderer = streamingRenderer.createStreamingRenderer({
      renderMarkdown: markdownEngine.renderMarkdown,
      enhance: () => {},
    });

    for (const chunk of source.match(/.{1,17}/gs) || []) renderer.append(chunk, container);
    const result = renderer.final(container, source);

    assert.match(result.mode, /^canonical-final/);
    assert.strictEqual(container.querySelectorAll('br').length, 20);
    assertLineOrder(container, source);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}

function testUnfinishedStreamingTailKeepsNewlinesVisibleBeforeFinalMarkdownRender() {
  const dom = new JSDOM('<!doctype html><div id="content" class="markdown-body"></div>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const container = dom.window.document.getElementById('content');
    const renderer = streamingRenderer.createStreamingRenderer({
      renderMarkdown: markdownEngine.renderMarkdown,
      enhance: () => {},
    });
    renderer.append('第 01 行：CHATUI-STREAM-TEST\n第 02 行：CHATUI-STREAM-TEST', container);
    const tail = container.querySelector('.markdown-stream-tail');
    assert.ok(tail, 'unfinished stream text must have a dedicated tail node');
    assert.strictEqual(tail.style.whiteSpace, 'pre-wrap');
    assert.ok(tail.textContent.includes('第 01 行：CHATUI-STREAM-TEST\n第 02 行：CHATUI-STREAM-TEST'));
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}

function testLineBreakSupportDoesNotInsertBreakTagsInsideCodeBlocks() {
  const source = [
    '第一行 **加粗**',
    '第二行 `inline`',
    '',
    '```js',
    'const first = 1;',
    'const second = 2;',
    '```',
  ].join('\n');

  for (const html of [markdownEngine.renderMarkdown(source), markdownPreview.renderMarkdownPreview(source)]) {
    const document = parseHtml(html);
    const paragraph = document.querySelector('p');
    const code = document.querySelector('pre code');
    assert.ok(paragraph.querySelector('strong'));
    assert.ok(paragraph.querySelector('code'));
    assert.strictEqual(paragraph.querySelectorAll('br').length, 1);
    assert.ok(code.textContent.includes('const first = 1;\nconst second = 2;'));
    assert.strictEqual(code.querySelectorAll('br').length, 0,
      'fenced code newlines must remain code text rather than HTML break elements');
  }
}

function testBlankLinesListsAndTablesKeepTheirBlockSemantics() {
  const source = [
    '段落第一行',
    '段落第二行',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '| Name | Status |',
    '| --- | --- |',
    '| ChatUI | Ready |',
  ].join('\n');

  for (const html of [markdownEngine.renderMarkdown(source), markdownPreview.renderMarkdownPreview(source)]) {
    const document = parseHtml(html);
    assert.strictEqual(document.querySelectorAll('p').length, 1);
    assert.strictEqual(document.querySelectorAll('p br').length, 1);
    assert.strictEqual(document.querySelectorAll('ul > li').length, 2);
    assert.strictEqual(document.querySelectorAll('table').length, 1);
    assert.strictEqual(document.querySelectorAll('table br').length, 0);
  }
}

function testBrowserMarkdownEngineUsesTheSameBreakPolicy() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/markdown/browser-engine.js'), 'utf8');
  assert.match(source, /MarkdownIt\(\{ html: true, breaks: true,/);
  assert.doesNotMatch(source, /MarkdownIt\(\{ html: true, breaks: false,/);
}

module.exports = [
  testCanonicalAndLargePreviewPreserveEverySingleLineBreak,
  testStreamingCompletionKeepsTheSameLineBreaksAsCanonicalRendering,
  testUnfinishedStreamingTailKeepsNewlinesVisibleBeforeFinalMarkdownRender,
  testLineBreakSupportDoesNotInsertBreakTagsInsideCodeBlocks,
  testBlankLinesListsAndTablesKeepTheirBlockSemantics,
  testBrowserMarkdownEngineUsesTheSameBreakPolicy,
];