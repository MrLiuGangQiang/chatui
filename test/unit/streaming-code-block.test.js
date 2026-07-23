'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

function testOpenFenceRendersAsLiveCodeBlock() {
  withDom(container => {
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    renderer.append('下面是实现：\n```javascript\nconst value = 1;', container);

    const block = container.querySelector('[data-markdown-streaming-code="1"]');
    assert.ok(block, 'an open fenced block should immediately create a live code block');
    assert.ok(block.classList.contains('code-block'), 'the live block should reuse the final code block styling');
    assert.strictEqual(block.querySelector('.code-lang').textContent, 'javascript · 输出中');
    assert.strictEqual(block.querySelector('code').textContent, 'const value = 1;');
    assert.ok(container.textContent.includes('下面是实现：'), 'text before the fence should remain visible');
    assert.ok(!container.textContent.includes('```'), 'raw fence markers should not be exposed while code streams');
  });
}

function testLiveCodeBlockAppendsTextWithoutReplacingCodeNode() {
  withDom(container => {
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    renderer.append('```js\nconst a = 1;', container);
    const code = container.querySelector('[data-markdown-streaming-code="1"] code');
    const textNode = code.firstChild;
    let appended = '';
    const originalAppendData = textNode.appendData.bind(textNode);
    textNode.appendData = value => { appended += value; return originalAppendData(value); };

    renderer.append('\nconsole.log(a);', container);

    assert.strictEqual(container.querySelector('[data-markdown-streaming-code="1"] code'), code, 'streaming should preserve the existing code element');
    assert.strictEqual(code.firstChild, textNode, 'streaming should preserve the existing code text node');
    assert.strictEqual(appended, '\nconsole.log(a);', 'only the new code delta should be appended');
    assert.strictEqual(code.textContent, 'const a = 1;\nconsole.log(a);');
  });
}

function testClosingFenceFinalizesThroughMarkdownRenderer() {
  withDom(container => {
    const phases = [];
    const renderer = streaming.createStreamingRenderer({
      renderMarkdown: markdownEngine.renderMarkdown,
      enhance: (_root, phase) => phases.push(phase),
    });
    renderer.append('```js\nconst html = "<img onerror=alert(1)>";', container);
    assert.strictEqual(container.querySelectorAll('img').length, 0, 'streamed code must be written as text rather than HTML');

    renderer.append('\n```\n', container);
    assert.ok(!container.querySelector('[data-markdown-streaming-code]'), 'the temporary live block should be removed when the fence closes');
    assert.ok(container.querySelector('.code-block > pre'), 'a closed fence should keep the code-block shell while the response continues streaming');
    assert.strictEqual(container.querySelector('pre code').textContent, 'const html = "<img onerror=alert(1)>";\n');

    const result = renderer.final(container);
    assert.strictEqual(result.mode, 'canonical-final');
    assert.ok(phases.some(phase => phase.final), 'finalization should still invoke the existing enhancement path for copy controls and other enhancements');
  });
}

function testStreamingCodeKeywordsHighlightOnThrottle() {
  withDom(container => {
    const scheduled = new Map();
    const cleared = [];
    let timerId = 0;
    const escapeHtml = value => String(value).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]));
    const highlighter = {
      getLanguage: language => language === 'js',
      highlight: source => ({ value: escapeHtml(source).replace(/\b(const|return)\b/g, '<span class="hljs-keyword">$1</span>') }),
    };
    const renderer = streaming.createStreamingRenderer({
      renderMarkdown: markdownEngine.renderMarkdown,
      enhance: () => {},
      highlighter,
      setTimer: callback => { timerId += 1; scheduled.set(timerId, callback); return timerId; },
      clearTimer: id => { cleared.push(id); scheduled.delete(id); },
      highlightIntervalMs: 180,
    });

    renderer.append('```js\nconst html = "<img onerror=alert(1)>";', container);
    const code = container.querySelector('[data-markdown-streaming-code="1"] code');
    assert.strictEqual(code.querySelectorAll('.hljs-keyword').length, 0, 'tokens should stay cheap plain text until the throttle fires');
    assert.strictEqual(scheduled.size, 1, 'streaming code should schedule one throttled highlight pass');

    const firstTimer = [...scheduled.entries()][0];
    scheduled.delete(firstTimer[0]);
    firstTimer[1]();
    assert.strictEqual(code.querySelector('.hljs-keyword')?.textContent, 'const');
    assert.strictEqual(code.querySelectorAll('img').length, 0, 'highlighted code must not turn source HTML into DOM');
    assert.strictEqual(code.textContent, 'const html = "<img onerror=alert(1)>";');

    const existingKeyword = code.querySelector('.hljs-keyword');
    renderer.append('\nreturn html;', container);
    assert.ok(existingKeyword.isConnected, 'new deltas should append after existing highlighted spans instead of blanking them');
    assert.ok(code.textContent.endsWith('\nreturn html;'));
    const secondTimer = [...scheduled.entries()][0];
    scheduled.delete(secondTimer[0]);
    secondTimer[1]();
    assert.deepStrictEqual([...code.querySelectorAll('.hljs-keyword')].map(node => node.textContent), ['const', 'return']);

    renderer.append('\nconst done = true;', container);
    const pendingTimerId = [...scheduled.keys()][0];
    renderer.append('\n```\n', container);
    assert.ok(cleared.includes(pendingTimerId), 'closing the fence should cancel any pending live highlight timer');
    assert.ok(!container.querySelector('[data-markdown-streaming-code]'));
  });
}

function testBundledHighlighterSupportsJavaSyntax() {
  const source = fs.readFileSync(path.join(__dirname, '../../vendor/highlight-common.min.js'), 'utf8');
  const browserGlobal = {};
  browserGlobal.window = browserGlobal;
  browserGlobal.globalThis = browserGlobal;
  vm.createContext(browserGlobal);
  vm.runInContext(source, browserGlobal);

  const highlighter = browserGlobal.hljs;
  assert.strictEqual(highlighter?.versionString, '11.11.1', 'the browser bundle should contain the real highlight.js runtime');
  assert.ok(highlighter.getLanguage('java'), 'the bundled common language set should register Java');

  withDom(container => {
    const scheduled = [];
    const renderer = streaming.createStreamingRenderer({
      renderMarkdown: markdownEngine.renderMarkdown,
      enhance: () => {},
      highlighter,
      setTimer: callback => { scheduled.push(callback); return scheduled.length; },
      clearTimer: () => {},
    });
    renderer.append('```java\npublic class Demo { private int value = 1; }', container);
    scheduled.shift()();

    const code = container.querySelector('code.language-java');
    assert.strictEqual(code?.textContent, 'public class Demo { private int value = 1; }');
    assert.deepStrictEqual([...code.querySelectorAll('.hljs-keyword')].map(node => node.textContent), ['public', 'class', 'private']);
    assert.strictEqual(code.querySelector('.hljs-title.class_')?.textContent, 'Demo');
    assert.strictEqual(code.querySelector('.hljs-type')?.textContent, 'int');
  });
}

function testDisposingLiveCodePreviewCancelsWorkWithoutClearingVisibleContent() {
  withDom(container => {
    let timerId = 0;
    const scheduled = new Set();
    const cleared = [];
    const renderer = streaming.createStreamingRenderer({
      renderMarkdown: markdownEngine.renderMarkdown,
      enhance: () => {},
      highlighter: { getLanguage: () => true, highlight: source => ({ value: source }) },
      setTimer: () => { timerId += 1; scheduled.add(timerId); return timerId; },
      clearTimer: id => { cleared.push(id); scheduled.delete(id); },
    });
    renderer.append('```js\nconst value = 1;', container);
    const liveBlock = container.querySelector('[data-markdown-streaming-code]');
    assert.ok(liveBlock && scheduled.size === 1);

    renderer.dispose();

    assert.deepStrictEqual(cleared, [1], 'disposing a large-message live preview should cancel its pending highlight work');
    assert.strictEqual(container.querySelector('[data-markdown-streaming-code]'), liveBlock, 'dispose should preserve the visible preview until the offscreen canonical result is ready');
  });
}

function testFencedCodeUsesBalancedContrastTheme() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(css.includes('--ds-code:#e8ebf0!important'), 'fenced code should use a medium blue-gray surface');
  assert.ok(css.includes('--ds-code-text:#28303d!important'), 'code text should keep strong contrast without switching to a dark theme');
  assert.ok(css.includes('background-image:none!important') && css.includes('box-shadow:none!important'), 'fenced code should use a uniform flat surface without gradients or shadows');
  assert.ok(css.includes('.markdown-body .code-block::after') && css.includes('content:none!important'), 'the legacy gradient overlay pseudo-element should be disabled');
  assert.ok(css.includes('backdrop-filter:none!important') && css.includes('.markdown-body .code-lang'), 'glass filters and the translucent language-label surface should be disabled');
  assert.ok(css.includes('.markdown-body .hljs-keyword') && css.includes('color:#7c3aed!important'), 'syntax tokens should use a coordinated light-theme palette');
  assert.ok(index.includes('styles/flat-theme.css?v=2.2.3-code-action-motion'), 'the browser cache version should change with the code theme');
  assert.ok(index.includes('assets/chatui.bundle.css?v=1.3.160-code-action-motion'), 'the immutable CSS bundle URL should change with the code theme');

  const dom = new JSDOM(`<style>${css}</style><div class="message assistant"><div class="content markdown-body"><div class="code-block"><span class="code-lang">js</span><pre><code class="hljs language-js">const x = 1;</code></pre></div></div></div>`);
  const codeBlockStyle = dom.window.getComputedStyle(dom.window.document.querySelector('.code-block'));
  const languageStyle = dom.window.getComputedStyle(dom.window.document.querySelector('.code-lang'));
  assert.strictEqual(codeBlockStyle.backgroundColor, 'rgb(232, 235, 240)', 'the final code surface should resolve to one opaque color');
  assert.strictEqual(codeBlockStyle.backgroundImage, 'none');
  assert.strictEqual(codeBlockStyle.boxShadow, 'none');
  assert.strictEqual(codeBlockStyle.backdropFilter, 'none');
  assert.strictEqual(languageStyle.backgroundColor, 'rgba(0, 0, 0, 0)', 'the language label should not add a lighter patch on the left');
}

function testMarkdownActionHoverUsesStableAnimatedSurface() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const lockMarker = '/* Markdown action interaction lock: state changes must not alter the button box. */';
  const motionMarker = '/* Markdown action motion: visible surface feedback without translation or scaling. */';
  const feedbackMarker = '/* Code-block action feedback states retain their meaning without changing on hover. */';
  const lockStart = css.indexOf(lockMarker);
  const motionStart = css.indexOf(motionMarker, lockStart);
  const feedbackStart = css.indexOf(feedbackMarker, motionStart);
  assert.ok(lockStart >= 0 && motionStart > lockStart && feedbackStart > motionStart, 'the final Markdown-action interaction rules should be present');

  const lockRules = css.slice(lockStart, motionStart);
  assert.ok(lockRules.includes(':is(:hover,:focus,:focus-visible,:active)'), 'hover, focus, and active states should share the same geometry and visual baseline');
  assert.ok(lockRules.includes('.code-copy-icon:is(.copied,.copy-failed)') && lockRules.includes(':is(.is-error,.is-loading)'), 'copy and Mermaid feedback states should use the same locked button box');
  assert.ok(lockRules.includes(':is(.mermaid-block,.mermaid-rendered-block)>.mermaid-render-toggle'), 'the rendered Mermaid conversion button should use the same interaction lock');
  for (const declaration of [
    'top:8px!important',
    'width:28px!important',
    'height:24px!important',
    'border:1px solid #cbd2dc!important',
    'border-radius:6px!important',
    'box-shadow:none!important',
    'transform:none!important',
    'transition:background-color .16s ease,border-radius .16s ease!important',
  ]) {
    assert.ok(lockRules.includes(declaration), `Markdown-action interaction lock should include ${declaration}`);
  }

  const motionRules = css.slice(motionStart, feedbackStart);
  assert.ok(motionRules.includes('background-color:#d8e2f0!important') && motionRules.includes('background-color:#cbd8e9!important'), 'hover and active surfaces should be visibly distinct');
  assert.ok(motionRules.includes('border-radius:8px!important'), 'hover should gently increase the button radius');
  const motionProperties = [...new Set([...motionRules.matchAll(/(?:^|\n)\s*([a-z-]+)\s*:/g)].map(match => match[1]))].sort();
  assert.deepStrictEqual(motionProperties, ['background-color', 'border-radius'], 'interaction motion must not move, resize, recolor, or shadow the button');

  const dom = new JSDOM(`<style>${css}</style><div class="markdown-body">
    <div class="code-block"><button data-state="normal" class="inline-copy code-action-icon code-copy-icon"></button></div>
    <div class="code-block"><button data-state="copied" class="inline-copy code-action-icon code-copy-icon copied"></button></div>
    <div class="code-block"><button data-state="failed" class="inline-copy code-action-icon code-copy-icon copy-failed"></button></div>
    <div class="code-block"><button data-state="mermaid-error" class="inline-copy code-action-icon mermaid-toggle-btn mermaid-render-toggle is-error"></button></div>
    <div class="mermaid-block mermaid-rendered-block"><button data-state="rendered-mermaid" class="inline-copy code-action-icon mermaid-toggle-btn mermaid-render-toggle"></button></div>
  </div>`);
  for (const button of dom.window.document.querySelectorAll('button')) {
    const style = dom.window.getComputedStyle(button);
    assert.strictEqual(style.top, '8px', `${button.dataset.state} code action should keep its vertical position`);
    assert.strictEqual(style.width, '28px', `${button.dataset.state} code action should keep its width`);
    assert.strictEqual(style.height, '24px', `${button.dataset.state} code action should keep its height`);
    assert.strictEqual(style.borderRadius, '6px', `${button.dataset.state} Markdown action should use the shared base radius`);
    assert.strictEqual(style.transform, 'none', `${button.dataset.state} code action should never translate or scale`);
  }
}

module.exports = [
  testOpenFenceRendersAsLiveCodeBlock,
  testLiveCodeBlockAppendsTextWithoutReplacingCodeNode,
  testClosingFenceFinalizesThroughMarkdownRenderer,
  testStreamingCodeKeywordsHighlightOnThrottle,
  testBundledHighlighterSupportsJavaSyntax,
  testDisposingLiveCodePreviewCancelsWorkWithoutClearingVisibleContent,
  testFencedCodeUsesBalancedContrastTheme,
  testMarkdownActionHoverUsesStableAnimatedSurface,
];
