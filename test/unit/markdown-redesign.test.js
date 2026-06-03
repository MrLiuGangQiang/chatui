const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createMarkdownEngine } = require('../../client/app/markdown/markdown-engine');
const { findStableBoundary, splitStableTail, hasConservativeInlineMathTail } = require('../../client/app/markdown/stable-boundary');
const { createStreamingRenderer } = require('../../client/app/markdown/streaming-renderer');
const { enhanceCodeCopy } = require('../../client/app/markdown/code-copy');
const loader = require('../../client/app/markdown/dependency-loader');

function testMarkdownEngine() {
  const engine = createMarkdownEngine();
  const html = engine.render('# Title\n\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n==mark== H~2~O x^2^ :smile:\n\n```js\nconsole.log(1)\n```\n\n<script>alert(1)</script>\n');
  assert(html.includes('<table>'));
  assert(html.includes('contains-task-list') || html.includes('task-list'));
  assert(html.includes('<mark>mark</mark>'));
  assert(!html.includes('<script>'));
  assert(html.includes('language-js') || html.includes('hljs'));
}
function testStableBoundary() {
  assert.strictEqual(findStableBoundary('a\n\n```js\nconst x=1;'), 3);
  assert.strictEqual(splitStableTail('a\n\n$$\nx=1').stable, 'a\n\n');
  assert.strictEqual(splitStableTail('# Title\nNext').stable, '# Title\n');
  assert.strictEqual(splitStableTail('- a\n- b').stable, '');
  assert.strictEqual(splitStableTail('- a\n- b\n\nnext').stable, '- a\n- b\n\n');
  assert.strictEqual(splitStableTail('| A | B |\n| - | - |\n| 1 | 2 |').stable, '');
  assert(splitStableTail('| A | B |\n| - | - |\n| 1 | 2 |\n\n').stable.includes('<') === false);
  assert.strictEqual(splitStableTail('```mermaid\ngraph TD;\nA-->B;').stable, '');
  assert(splitStableTail('```mermaid\ngraph TD;\nA-->B;\n```\n').stable.includes('mermaid'));
  assert.strictEqual(splitStableTail('::: note\nbody').stable, '');
  assert(splitStableTail('::: note\nbody\n:::\n').stable.includes('body'));
  assert.strictEqual(splitStableTail('<details>\n<summary>x</summary>\nbody').stable, '');
  assert(splitStableTail('<details>\n<summary>x</summary>\nbody\n</details>\n').stable.includes('</details>'));
  assert.strictEqual(splitStableTail('!!! note\n  body').stable, '');
  assert(splitStableTail('!!! note\n  body\n\n').stable.includes('body'));
  assert.strictEqual(hasConservativeInlineMathTail('a $x'), true);
}
function testStreamingRenderer() {
  const dom = new JSDOM('<div id="c"></div>'); global.document = dom.window.document;
  const c = document.getElementById('c');
  let fullReplaceCount = 0;
  const original = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  Object.defineProperty(c, 'innerHTML', { get() { return original.get.call(this); }, set(v) { fullReplaceCount += 1; return original.set.call(this, v); } });
  const enhanced = [];
  const r = createStreamingRenderer({ renderMarkdown: s => `<p>${s.trim()}</p>`, enhance: root => enhanced.push(root.childNodes.length) });
  r.append('hello\n\n```js\nconst x', c);
  assert(c.innerHTML.includes('<p>hello</p>'));
  assert(c.querySelector('.streaming-tail'));
  r.append('=1\n```\n', c);
  assert(c.querySelector('.streaming-tail') || c.innerHTML.includes('const x'));
  assert.strictEqual(fullReplaceCount, 0);
  r.final(c);
  assert(c.innerHTML.includes('hello'));
  assert(c.innerHTML.includes('const x=1'), 'final should render buffered code tail once');
  assert.strictEqual(fullReplaceCount, 0);
  assert(enhanced.length >= 1);
  delete global.document;
}
function testCodeCopy() {
  const dom = new JSDOM('<div><pre><code class="language-js">console.log(1)</code></pre></div>'); global.document = dom.window.document; global.navigator = { clipboard: { writeText: async () => {} } };
  enhanceCodeCopy(dom.window.document.body, async text => { assert.strictEqual(text, 'console.log(1)'); });
  assert(dom.window.document.querySelector('.code-block .code-copy-icon'));
  delete global.document; delete global.navigator;
}
function testDependencyLoader() {
  const markdownIt = loader.resources.scripts.find(resource => resource.id === 'markdown-it');
  const mermaid = loader.resources.scripts.find(resource => resource.id === 'mermaid');
  assert(markdownIt.cdn.includes('npmmirror'));
  assert(mermaid.local.includes('vendor'));
}
module.exports = { testMarkdownEngine, testStableBoundary, testStreamingRenderer, testCodeCopy, testDependencyLoader };
