const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function loadScript(window, file) {
  window.eval(fs.readFileSync(path.join(__dirname, '../../client/app/markdown', file), 'utf8'));
}

function main() {
  const dom = new JSDOM('<!doctype html><div id="out"></div>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.console = console;
  window.markdownit = require('markdown-it');
  window.katex = require('katex');
  window.markdownItTexmath = require('markdown-it-texmath');
  window.markdownitMultimdTable = require('markdown-it-multimd-table');

  window.DOMPurify = require('dompurify')(window);
  loadScript(window, 'source-normalizer.js');
  loadScript(window, 'link-policy.js');
  loadScript(window, 'mermaid-normalizer.js');
  loadScript(window, 'browser-sanitizer.js');
  loadScript(window, 'browser-engine.js');

  assert(window.ChatUIMarkdownBrowserEngine, 'browser engine namespace exists');
  assert.strictEqual(window.ChatUIMarkdownBrowserEngine.hasCriticalMarkdownPlugins(), true);
  const html = window.ChatUIMarkdownBrowserEngine.renderMarkdown('| A | B |\n|---|---|\n| **x** | https:\\/\\/openai.com |\n\n$a+b$\n\n```architecture-beta\nservice api[API服务]\n```');
  const tpl = window.document.createElement('template');
  tpl.innerHTML = html;
  assert(tpl.content.querySelector('table'));
  assert.strictEqual(tpl.content.querySelector('strong')?.textContent, 'x');
  assert(tpl.content.querySelector('a[href="https://openai.com"]'));
  assert(tpl.content.querySelector('.katex'));
  assert(tpl.content.querySelector('.markdown-mermaid-pending code.language-mermaid'));
  assert(!html.includes('javascript:alert'));

  const unsafe = window.ChatUIMarkdownBrowserEngine.renderMarkdown('[x](javascript:alert(1))');
  const unsafeTpl = window.document.createElement('template');
  unsafeTpl.innerHTML = unsafe;
  assert(!unsafeTpl.content.querySelector('a[href^="javascript:"]'));
  assert(!/on\w+=/i.test(unsafe));
}

if (require.main === module) main();
module.exports = { main };
