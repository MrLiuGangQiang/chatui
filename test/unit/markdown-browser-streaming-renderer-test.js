const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function loadScript(window, file) {
  window.eval(fs.readFileSync(path.join(__dirname, '../../client/app/markdown', file), 'utf8'));
}

function main() {
  const dom = new JSDOM('<!doctype html><div id="out"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.console = console;
  window.ChatUIMarkdownBrowserEngine = {
    escapeHtml: value => String(value).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])),
    renderMarkdown: value => `<p>${String(value).replace(/\n/g, '<br>')}</p>`,
  };
  const phases = [];
  window.ChatUIMarkdownBrowserEnhancer = {
    enhanceRenderedMarkdown(root, phase = {}) { phases.push({ phase, text: root.textContent }); },
  };
  loadScript(window, 'browser-streaming-renderer.js');

  const api = window.ChatUIMarkdownBrowserStreamingRenderer;
  assert(api, 'browser streaming namespace exists');
  assert.strictEqual(api.splitStableTail('a\n\nb').stable, 'a\n\n');

  const out = window.document.getElementById('out');
  const renderer = api.createStreamingRenderer();
  renderer.append('第一段\n\n```js\n', out);
  assert(out.querySelector('.streaming-tail'), 'open fence stays tail');
  renderer.append('console.log(1)\n```\n\n', out);
  assert(out.textContent.includes('console.log(1)'), 'closed fence commits');
  const result = renderer.final(out);
  assert(['incremental-final', 'full-rerender-final'].includes(result.mode));
  assert(phases.some(item => item.phase.streaming || item.phase.final || item.phase.reset), 'enhancer invoked during streaming');
}

if (require.main === module) main();
module.exports = { main };
