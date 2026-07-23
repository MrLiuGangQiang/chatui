'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const markdownEngine = require('../../client/app/markdown/markdown-engine');
const streaming = require('../../client/app/markdown/browser-streaming-renderer');

function withDom(run) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content" class="markdown-body"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    return run(dom.window.document.getElementById('content'));
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}

function parsedInnerHtml(document, html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  return template.innerHTML;
}

function testStreamingCompletionMatchesCanonicalRefreshMarkup() {
  withDom(container => {
    const chunks = [
      'Intro line one\n',
      'Intro line two\n\n',
      '| Name | Value |\n',
      '| --- | --- |\n',
      '| **A** | [Docs](https://example.test) |\n\n',
      '- First item\n',
      '- Second item\n\n',
      'After line one\n',
      'After line two',
    ];
    const source = chunks.join('');
    let finalSourceRenderCount = 0;
    let renderCallCount = 0;
    const render = value => {
      renderCallCount += 1;
      if (value === source) finalSourceRenderCount += 1;
      return markdownEngine.renderMarkdown(value);
    };
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: render, enhance: () => {} });
    for (const chunk of chunks) renderer.append(chunk, container);

    const callsBeforeFinal = renderCallCount;
    const result = renderer.final(container, source);
    const canonical = parsedInnerHtml(container.ownerDocument, markdownEngine.renderMarkdown(source));

    assert.strictEqual(result.mode, 'canonical-final');
    assert.strictEqual(container.innerHTML, canonical, 'stream completion must produce the same canonical DOM as rendering the persisted source after refresh');
    assert.strictEqual(finalSourceRenderCount, 1, 'the complete source should be parsed exactly once at completion');
    assert.strictEqual(renderCallCount - callsBeforeFinal, 1, 'canonical reconciliation must use one final render call rather than a compare-then-rerender cycle');
    assert.strictEqual(container.querySelectorAll('p').length, 2, 'multiline paragraphs should not remain split by streaming chunk boundaries');
    assert.strictEqual(container.querySelectorAll('ul').length, 1, 'adjacent streamed list items should share the canonical list container');
    assert.ok(container.querySelector('table strong') && container.querySelector('table a'), 'table inline Markdown should match the canonical renderer');
  });
}

function testCanonicalFinalAvoidsUnneededDomReplacement() {
  withDom(container => {
    const source = 'Already canonical\n';
    let renderCallCount = 0;
    const renderer = streaming.createStreamingRenderer({
      renderMarkdown: value => { renderCallCount += 1; return markdownEngine.renderMarkdown(value); },
      enhance: () => {},
    });
    renderer.append(source, container);
    const paragraph = container.querySelector('p');
    const callsBeforeFinal = renderCallCount;

    const result = renderer.final(container, source);

    assert.strictEqual(result.mode, 'canonical-final-unchanged');
    assert.strictEqual(container.querySelector('p'), paragraph, 'already-canonical DOM should retain node identity and avoid layout replacement');
    assert.strictEqual(renderCallCount - callsBeforeFinal, 1, 'completion should perform only the cacheable canonical lookup/render call');
  });
}

module.exports = [
  testStreamingCompletionMatchesCanonicalRefreshMarkup,
  testCanonicalFinalAvoidsUnneededDomReplacement,
];
