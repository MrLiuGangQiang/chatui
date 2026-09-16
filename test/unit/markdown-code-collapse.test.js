'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { enhanceCodeCopy, COLLAPSIBLE_CODE_MIN_LINES } = require('../../client/app/markdown/enhancer');
const markdownEngine = require('../../client/app/markdown/markdown-engine');
const markdownEnhancer = require('../../client/app/markdown/enhancer');
const streaming = require('../../client/app/markdown/browser-streaming-renderer');

async function withDom(run) {
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content"><pre><code></code></pre></div>');
  global.document = dom.window.document;
  try { return await run(dom.window.document.getElementById('content')); } finally { global.document = previousDocument; }
}

async function testLongCodeStartsCollapsedAndCopiesFullSource() {
  await withDom(async container => {
    const source = Array.from({ length: COLLAPSIBLE_CODE_MIN_LINES }, (_, index) => `line ${index + 1}`).join('\n');
    container.querySelector('code').textContent = source;
    let copied = '';
    enhanceCodeCopy(container, value => { copied = value; return Promise.resolve(); });
    const block = container.querySelector('.code-block');
    const expand = block.querySelector('.code-expand-toggle');
    const headerExpand = block.querySelector('.code-expand-header-toggle');
    assert.ok(block.classList.contains('code-block-collapsed'));
    assert.ok(headerExpand);
    assert.ok(headerExpand.querySelector('svg'));
    assert.strictEqual(expand.textContent, '查看完整内容');
    assert.strictEqual(expand.firstElementChild.tagName.toLowerCase(), 'svg');
    assert.strictEqual(expand.querySelectorAll('.code-expand-toggle-icon path').length, 2);
    assert.strictEqual(expand.lastElementChild.textContent, '查看完整内容');
    assert.strictEqual(expand.getAttribute('aria-label'), '查看完整内容');
    assert.strictEqual(headerExpand.querySelector('svg').outerHTML, expand.querySelector('svg').outerHTML);
    assert.strictEqual(block.querySelector('.code-copy-icon:not(.code-expand-header-toggle)').dataset.copyText, source);
    headerExpand.click();
    assert.ok(block.classList.contains('code-block-expanded'));
    assert.strictEqual(expand.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(expand.querySelectorAll('.code-expand-toggle-icon path').length, 2);
    assert.strictEqual(expand.getAttribute('aria-label'), '收起内容');
    assert.strictEqual(headerExpand.getAttribute('aria-expanded'), 'true');
    assert.ok(headerExpand.querySelector('svg'));
    assert.strictEqual(headerExpand.querySelector('svg').outerHTML, expand.querySelector('svg').outerHTML);
    expand.click();
    assert.ok(block.classList.contains('code-block-collapsed'));
    assert.strictEqual(headerExpand.getAttribute('aria-expanded'), 'false');
    block.querySelector('.code-copy-icon:not(.code-expand-header-toggle)').click();
    await Promise.resolve();
    assert.strictEqual(copied, source);
  });
}

function testShortCodeDoesNotGetExpansionControl() {
  withDom(container => {
    container.querySelector('code').textContent = 'const answer = 42;';
    enhanceCodeCopy(container);
    assert.ok(!container.querySelector('.code-expand-toggle'));
  });
}

function testOpenStreamingCodeCollapsesAndFollowsLatestOutput() {
  const previousEnhancer = global.ChatUIMarkdownEnhancer;
  global.ChatUIMarkdownEnhancer = require('../../client/app/markdown/enhancer');
  try { withDom(container => {
    const source = Array.from({ length: COLLAPSIBLE_CODE_MIN_LINES + 8 }, (_, index) => `line ${index + 1}`).join('\n');
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    renderer.append(`\`\`\`js\n${source}`, container);
    const block = container.querySelector('[data-markdown-streaming-code="1"]');
    const pre = block.querySelector('pre');
    Object.defineProperty(pre, 'scrollHeight', { value: 900 });
    renderer.append('\nlatest line', container);
    assert.ok(block, 'open fences must remain in the live streaming renderer');
    assert.ok(block.classList.contains('code-block-collapsed'));
    const toggle = block.querySelector('.code-expand-toggle');
    const headerToggle = block.querySelector('.code-expand-header-toggle');
    const stableHeaderIcon = headerToggle.querySelector('svg');
    assert.ok(toggle);
    assert.strictEqual(pre.scrollTop, 900, 'a collapsed live block should keep its latest output visible');
    renderer.append('\nanother latest line', container);
    assert.strictEqual(headerToggle.querySelector('svg'), stableHeaderIcon, 'streaming updates must not rebuild the action icon while its state is unchanged');
    toggle.click();
    assert.ok(block.classList.contains('code-block-expanded'), 'the live expansion control must respond to clicks');
    assert.strictEqual(block.querySelector('code').textContent, `${source}\nlatest line\nanother latest line`);
  }); } finally { global.ChatUIMarkdownEnhancer = previousEnhancer; }
}

function testCompletedStreamingCodeIsCollapsedBeforeItsFinalMount() {
  const previousEnhancer = global.ChatUIMarkdownEnhancer;
  global.ChatUIMarkdownEnhancer = require('../../client/app/markdown/enhancer');
  try { withDom(container => {
    const source = Array.from({ length: COLLAPSIBLE_CODE_MIN_LINES + 8 }, (_, index) => `line ${index + 1}`).join('\n');
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    renderer.append(`\`\`\`js\n${source}`, container);
    renderer.final(container, `\`\`\`js\n${source}\n\`\`\``);
    assert.ok(container.querySelector('.code-block').classList.contains('code-block-collapsed'), 'the canonical node must be collapsed synchronously, without a full-code flash');
  }); } finally { global.ChatUIMarkdownEnhancer = previousEnhancer; }
}

async function testHeaderExpansionActionNeverOverlapsCopyAction() {
  await withDom(container => {
    container.className = 'markdown-body';
    const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8').replace(/\r\n?/g, '\n').replace(/\r\n?/g, '\n');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    container.querySelector('code').textContent = Array.from({ length: COLLAPSIBLE_CODE_MIN_LINES }, (_, index) => `line ${index + 1}`).join('\n');
    enhanceCodeCopy(container, () => Promise.resolve());
    const header = container.querySelector('.code-expand-header-toggle');
    const copy = container.querySelector('.code-copy-icon');
    const bottom = container.querySelector('.code-expand-toggle');
    const headerStyle = document.defaultView.getComputedStyle(header);
    const copyStyle = document.defaultView.getComputedStyle(copy);
    const bottomStyle = document.defaultView.getComputedStyle(bottom);
    assert.strictEqual(headerStyle.right, '40px');
    assert.strictEqual(copyStyle.right, '8px');
    assert.strictEqual(headerStyle.width, copyStyle.width);
    assert.strictEqual(headerStyle.height, copyStyle.height);
    assert.strictEqual(bottomStyle.fontSize, '13px');
    assert.ok(css.includes('linear-gradient'));
    assert.strictEqual(bottomStyle.position, 'absolute');
    assert.ok(css.includes('.58') && css.includes('.56'));
  });
}

// A long artifact restored from history (page refresh, session switch) must not
// look like it lost its beginning: the collapsed code block has to start at the
// head of the content instead of the live-stream tail window.
async function testRestoredLongCodeBlockShowsItsHeadNotItsTail() {
  await withDom(async container => {
    container.className = 'markdown-body';
    const source = Array.from({ length: COLLAPSIBLE_CODE_MIN_LINES + 20 }, (_, index) => 'line ' + (index + 1)).join('\n');
    container.innerHTML = '<div class="code-block"><pre><code class="language-html"></code></pre></div>';
    const pre = container.querySelector('pre');
    pre.querySelector('code').textContent = source;
    Object.defineProperty(pre, 'scrollHeight', { configurable: true, get: () => 1000 });
    const block = container.querySelector('.code-block');

    // A live stream keeps the newest line visible.
    markdownEnhancer.enhanceCodeExpansion(block, pre.querySelector('code'), { reason: 'streaming' });
    assert.ok(block.classList.contains('code-block-collapsed'), 'a long live block starts collapsed');
    assert.strictEqual(pre.scrollTop, 1000, 'a live stream follows the newest line');

    // The refreshed / restored render path (streaming: false) must show the head.
    await markdownEnhancer.enhanceRenderedMarkdown(container, { allowResourceLoad: false, streaming: false });
    assert.ok(block.classList.contains('code-block-collapsed'), 'a restored block stays collapsed');
    assert.strictEqual(pre.scrollTop, 0, 'a restored block must show the head of the content');
  });
}

module.exports = [
  testLongCodeStartsCollapsedAndCopiesFullSource,
  testShortCodeDoesNotGetExpansionControl,
  testOpenStreamingCodeCollapsesAndFollowsLatestOutput,
  testCompletedStreamingCodeIsCollapsedBeforeItsFinalMount,
  testHeaderExpansionActionNeverOverlapsCopyAction,
  testRestoredLongCodeBlockShowsItsHeadNotItsTail,
];
