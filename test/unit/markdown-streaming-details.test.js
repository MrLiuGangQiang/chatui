'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const markdownEngine = require('../../client/app/markdown/markdown-engine');
const streaming = require('../../client/app/markdown/browser-streaming-renderer');
const stableBoundary = require('../../client/app/markdown/stable-boundary');

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

function testNativeDetailsStaysAtomicDuringStreaming() {
  withDom(container => {
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    renderer.append('Before\n\n---\n\n', container);
    assert.strictEqual(container.querySelectorAll('hr').length, 1, 'a divider before details should render normally');

    renderer.append('<details>\n<summary>More information</summary>\n\nHidden body\n\n- **Bold** item\n\n```js\nconst value = 1;\n```\n', container);
    assert.ok(!container.querySelector('details'), 'an unfinished details block must not be committed as an auto-closed fragment');
    assert.ok(!container.textContent.includes('<details>') && !container.textContent.includes('<summary>'), 'details control tags must not be exposed to users');
    assert.ok(!container.textContent.includes('```') && !container.textContent.includes('**'), 'nested Markdown control markers must stay hidden in the readable tail');
    assert.ok(container.textContent.includes('More information') && container.textContent.includes('Hidden body'), 'readable details content should remain visible while it streams');

    renderer.append('</details>\n', container);
    const details = container.querySelector('details');
    assert.ok(details, 'the complete details block should render after its closing tag arrives');
    assert.strictEqual(details.querySelector('summary')?.textContent, 'More information');
    assert.ok(details.querySelector('ul strong'), 'Markdown content must stay inside the completed details element');
    assert.ok(details.querySelector('.code-block pre code'), 'a fenced code block inside details must not break the atomic boundary');
    assert.strictEqual(container.querySelectorAll('hr').length, 1, 'the preceding divider should remain intact');
  });
}

function testDetailsShorthandStaysAtomicDuringStreaming() {
  withDom(container => {
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    renderer.append('::: details Read more\n\nHidden **Markdown** body\n', container);

    assert.ok(!container.querySelector('details'), 'an unfinished details shorthand must stay in the replaceable tail');
    assert.ok(!container.textContent.includes(':::') && !container.textContent.includes('**'), 'container and emphasis markers must not be visible');
    assert.ok(container.textContent.includes('Read more') && container.textContent.includes('Hidden Markdown body'));

    renderer.append(':::\n', container);
    const details = container.querySelector('details');
    assert.ok(details, 'the shorthand should become native details when its closing marker arrives');
    assert.strictEqual(details.querySelector('summary')?.textContent, 'Read more');
    assert.ok(details.querySelector('strong'), 'inline Markdown should render inside shorthand details');
  });
}

function testStreamingTailUsesReadableTextInsteadOfMarkdownControls() {
  const projected = streaming.readableStreamingText('## **Result**: [OpenAI](https://example.test)\n- [x] Finished\n---\n<summary>More</summary>');
  assert.ok(projected.includes('Result: OpenAI'));
  assert.ok(projected.includes('☑ Finished'));
  assert.ok(projected.includes('More'));
  assert.ok(!/[#*\[\]<>]/.test(projected), 'headings, emphasis, links, dividers, and HTML tags should not leak control characters');

  withDom(container => {
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    for (const chunk of ['`', '`', '`json']) {
      renderer.append(chunk, container);
      assert.ok(!container.textContent.includes('`'), 'partial code-fence markers must not flash before the opening line completes');
    }
    renderer.append('\n{"ok": true}', container);
    assert.ok(container.querySelector('[data-markdown-streaming-code]'), 'the completed opening fence should switch to the live code block');
    assert.ok(!container.textContent.includes('```'));
    assert.strictEqual(container.querySelector('code')?.textContent, '{"ok": true}');
  });
}

function testSharedStableBoundaryKeepsDetailsBlocksWhole() {
  const prefix = 'Before\n\n';
  const nativeOpen = `${prefix}<details>\n<summary>More</summary>\n\nText\n\n\`\`\`js\nconst value = 1;\n\`\`\`\n`;
  const nativePending = stableBoundary.splitStableTail(nativeOpen);
  assert.strictEqual(nativePending.stable, prefix, 'code and blank lines inside native details must not advance the shared stable boundary');
  assert.ok(nativePending.tail.startsWith('<details>'));
  const nativeClosed = `${nativeOpen}</details>\n`;
  assert.strictEqual(stableBoundary.findStableBoundary(nativeClosed), nativeClosed.length);

  const shorthandOpen = `${prefix}::: details More\n\nText\n`;
  assert.strictEqual(stableBoundary.splitStableTail(shorthandOpen).stable, prefix);
  const shorthandClosed = `${shorthandOpen}:::\n`;
  assert.strictEqual(stableBoundary.findStableBoundary(shorthandClosed), shorthandClosed.length);
}

module.exports = [
  testNativeDetailsStaysAtomicDuringStreaming,
  testDetailsShorthandStaysAtomicDuringStreaming,
  testStreamingTailUsesReadableTextInsteadOfMarkdownControls,
  testSharedStableBoundaryKeepsDetailsBlocksWhole,
];
