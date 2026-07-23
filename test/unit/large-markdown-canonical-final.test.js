'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const markdownEngine = require('../../client/app/markdown/markdown-engine');
const finalRendererFeature = require('../../client/features/messages/markdown-final-renderer');

async function drainScheduled(queue) {
  let guard = 0;
  while (queue.length || guard < 3) {
    while (queue.length) {
      const callback = queue.shift();
      callback({ timeRemaining: () => 50 });
      await Promise.resolve();
    }
    await Promise.resolve();
    guard += 1;
  }
}

function parsedInnerHtml(document, html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  return template.innerHTML;
}

async function testLargeMarkdownUsesOneCanonicalParseAndOffscreenMount() {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><body><main id="messages"><article class="message assistant"><div class="content"><div data-live-preview="1">Streaming preview</div></div></article></main></body>');
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const document = dom.window.document;
    const message = document.querySelector('.message');
    const content = message.querySelector('.content');
    const preview = content.firstElementChild;
    const scheduled = [];
    const rows = Array.from({ length: 220 }, (_, index) => `| Row ${index + 1} | **${index + 1}** |`).join('\n');
    const source = `Intro line one\nIntro line two\n\n| Name | Value |\n| --- | ---: |\n${rows}\n\nAfter line one\nAfter line two`;
    let renderCount = 0;
    let renderedSource = '';
    const renderer = finalRendererFeature.createMarkdownFinalRenderer({
      state: { userScrollLocked: true },
      document,
      requestIdleCallback: callback => { scheduled.push(callback); return scheduled.length; },
      setTimeout: callback => { scheduled.push(callback); return scheduled.length; },
      renderMarkdown: value => { renderCount += 1; renderedSource = value; return markdownEngine.renderMarkdown(value); },
      enhanceRenderedMarkdown: () => Promise.resolve([]),
      resetMessageActionStates: () => {},
      bindInlineCopyButtons: () => {},
      hydrateMessageMedia: () => {},
      cleanupGeneratedImageNumberArtifacts: () => {},
      getMessagesRoot: () => document.getElementById('messages'),
    });

    assert.strictEqual(renderer.renderProgressively(message, source, 'large-hash'), true);
    assert.strictEqual(content.firstElementChild, preview, 'the visible streaming preview should remain until the canonical offscreen tree is ready');
    assert.strictEqual(renderCount, 0, 'large canonical parsing should begin on the scheduled path rather than block stream completion');

    await drainScheduled(scheduled);

    const canonical = parsedInnerHtml(document, markdownEngine.renderMarkdown(source));
    assert.strictEqual(renderCount, 1, 'the complete large Markdown source must be parsed exactly once');
    assert.strictEqual(renderedSource, source);
    assert.strictEqual(content.innerHTML, canonical, 'the progressively mounted result must equal a refresh-time canonical render');
    assert.strictEqual(message.dataset.renderedHash, 'large-hash');
    assert.ok(!message.dataset.progressiveRendering);
    assert.ok(!document.querySelector('[data-progressive-stage]'), 'the offscreen stage should be removed after the atomic swap');
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}

function testLargeMarkdownParserUnitIsNeverSplitBySourceBoundaries() {
  const source = 'Paragraph one\nparagraph continuation\n\n- item one\n- item two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
  assert.deepStrictEqual(finalRendererFeature.splitMarkdownRenderChunks(source), [source], 'source chunks must not be parsed independently because Markdown context crosses line and block boundaries');
}

module.exports = [
  testLargeMarkdownUsesOneCanonicalParseAndOffscreenMount,
  testLargeMarkdownParserUnitIsNeverSplitBySourceBoundaries,
];
