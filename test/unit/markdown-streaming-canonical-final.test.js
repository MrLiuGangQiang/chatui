'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const markdownEngine = require('../../client/app/markdown/markdown-engine');
const streaming = require('../../client/app/markdown/browser-streaming-renderer');
const liveStreaming = require('../../client/features/messages/markdown-live-stream');

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

function testLargeUnclosedStreamingTailUsesBoundedPreview() {
  withDom(container => {
    const source = '```text\n' + 'x'.repeat(180000);
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });

    renderer.append(source, container);

    const preview = container.textContent;
    assert.ok(preview.includes('流式预览仅显示最后'), 'an oversized unfinished tail should disclose that its preview is bounded');
    assert.ok(preview.length < 70000, 'the live DOM preview must stay bounded even when the raw stream is much larger');
    assert.strictEqual(renderer.getRaw(), source, 'bounding the preview must not discard canonical source text');
  });
}

function testDocumentSizedLiveStreamUsesAdaptiveRenderBudget() {
  let now = 0;
  let setCount = 0;
  let previewCount = 0;
  const live = liveStreaming.createMarkdownLiveStream({
    now: () => now,
    createStreamingRenderer: () => ({
      set: value => { setCount += 1; return { raw: value, consumed: 0, tail: '' }; },
      preview: value => { previewCount += 1; return { raw: value, consumed: 0, tail: '' }; },
      final: () => ({}),
    }),
  });
  const large = 'x'.repeat(70000);

  live.append(null, large, { force: true });
  now = 100;
  const deferred = live.append(null, large + 'y');
  now = 120;
  live.append(null, large + 'yz');

  assert.strictEqual(deferred.deferredPreview, true, 'document-sized output should not repaint inside its adaptive budget');
  assert.strictEqual(previewCount, 0, 'deferred document-sized output should avoid preview work entirely');
  assert.strictEqual(setCount, 2, 'the next adaptive cadence boundary should still repaint the latest content');
}

function testStreamingFinalFallsBackWhenReplaceChildrenIsUnavailable() {
  withDom(container => {
    const source = 'Thinking **Markdown**';
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    const originalReplaceChildren = container.replaceChildren;
    Object.defineProperty(container, 'replaceChildren', { configurable: true, value: undefined });
    try {
      renderer.final(container, source);
      assert.ok(container.querySelector('strong'), 'final Markdown should render even in webviews without Element.replaceChildren');
      assert.strictEqual(container.textContent.trim(), 'Thinking Markdown');
    } finally {
      Object.defineProperty(container, 'replaceChildren', { configurable: true, value: originalReplaceChildren });
    }
  });
}

module.exports = [
  testStreamingCompletionMatchesCanonicalRefreshMarkup,
  testCanonicalFinalAvoidsUnneededDomReplacement,
  testLargeUnclosedStreamingTailUsesBoundedPreview,
  testDocumentSizedLiveStreamUsesAdaptiveRenderBudget,
  testStreamingFinalFallsBackWhenReplaceChildrenIsUnavailable,
];
