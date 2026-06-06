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
    renderMarkdown: value => String(value).replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>').replace(/$/, '</p>'),
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

  const imageOut = window.document.createElement('div');
  const imageRenderer = api.createStreamingRenderer();
  imageRenderer.append('![mark](/assets/Markdown-mark.svg)\n\n', imageOut);
  const streamingImage = imageOut.querySelector('img');
  assert(streamingImage, 'streaming markdown image should render an img placeholder');
  assert.strictEqual(streamingImage.getAttribute('data-stream-src'), '/assets/Markdown-mark.svg', 'streaming image original src should be deferred');
  assert.ok(streamingImage.getAttribute('src').startsWith('data:image/gif;base64,'), 'streaming image src should be transparent placeholder, not network URL');
  imageRenderer.final(imageOut);
  const finalImage = imageOut.querySelector('img');
  assert.strictEqual(finalImage.getAttribute('src'), '/assets/Markdown-mark.svg', 'final markdown image should restore real src once');
  assert.ok(!finalImage.hasAttribute('data-stream-src'), 'final image should clear streaming deferred src marker');
}

if (require.main === module) main();
module.exports = { main };
