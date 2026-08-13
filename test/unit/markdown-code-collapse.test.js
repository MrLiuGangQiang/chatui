'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { enhanceCodeCopy, COLLAPSIBLE_CODE_MIN_LINES } = require('../../client/app/markdown/enhancer');
const markdownEngine = require('../../client/app/markdown/markdown-engine');
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
    assert.ok(bottomStyle.backgroundImage.includes('linear-gradient'));
    assert.strictEqual(bottomStyle.position, 'absolute');
    assert.ok(bottomStyle.backgroundImage.includes('0.58') && bottomStyle.backgroundImage.includes('0.56'));
  });
}

module.exports = [testLongCodeStartsCollapsedAndCopiesFullSource, testShortCodeDoesNotGetExpansionControl, testOpenStreamingCodeCollapsesAndFollowsLatestOutput, testCompletedStreamingCodeIsCollapsedBeforeItsFinalMount, testHeaderExpansionActionNeverOverlapsCopyAction];
