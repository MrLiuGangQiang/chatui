const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function loadScript(window, file) {
  window.eval(fs.readFileSync(path.join(__dirname, '../../client/app/markdown', file), 'utf8'));
}

async function main() {
  const dom = new JSDOM('<!doctype html><main id="root"><h2>标题</h2><table><tr><td>x</td></tr></table><pre><code class="language-js">console.log(1)</code></pre><div class="mermaid-block markdown-mermaid-pending" data-mermaid-rendered="0"><pre><code class="language-mermaid">sankey-beta\n用户访问,首页,100</code></pre></div></main>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.console = console;
  window.navigator.clipboard = { writeText: async text => { window.__copied = text; } };
  window.DOMPurify = require('dompurify')(window);
  loadScript(window, 'source-normalizer.js');
  loadScript(window, 'link-policy.js');
  loadScript(window, 'mermaid-normalizer.js');
  loadScript(window, 'browser-sanitizer.js');
  loadScript(window, 'browser-engine.js');
  loadScript(window, 'enhancer.js');
  loadScript(window, 'browser-enhancer.js');

  const api = window.ChatUIMarkdownBrowserEnhancer;
  assert(api, 'browser enhancer namespace exists');
  const root = window.document.getElementById('root');
  await api.enhanceRenderedMarkdown(root, { skipMermaid: true, copyText: text => window.navigator.clipboard.writeText(text) });
  assert(root.querySelector('h2').id, 'heading anchor added');
  assert(root.querySelector('.table-wrap table'), 'table wrapped');
  const copy = root.querySelector('.code-copy-icon');
  assert(copy, 'code copy button added');
  copy.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(window.__copied, 'console.log(1)');
  assert(root.querySelector('.mermaid-toggle-btn'), 'mermaid toggle button added');

  const holder = root.querySelector('.mermaid-block');
  const fakeMermaid = {
    initialize() {},
    async render(_id, source) {
      assert(source.includes('sankey_node_1'), 'render source is normalized');
      return { svg: '<svg><text>sankey_node_1</text><text>sankey_node_2</text></svg>', bindFunctions() {} };
    },
  };
  holder.dataset.mermaidRendered = '0';
  const result = await api.renderMermaidBlockOnDemand(holder, async () => fakeMermaid);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(holder.dataset.mermaidRendered, '1');
  assert(root.textContent.includes('用户访问'), 'sankey labels restored after render');
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
module.exports = { main };
