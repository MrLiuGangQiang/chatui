const assert = require('assert');
const { JSDOM } = require('jsdom');
const { escapeHtml, renderMath } = require('../../client/app/markdown/math-renderer');
const { createMarkdownEngine } = require('../../client/app/markdown/markdown-engine');
const { sanitizeHtml } = require('../../client/app/markdown/sanitizer');
const { enhanceRenderedMarkdown, renderMermaidBlocks } = require('../../client/app/markdown/enhancer');
const { createStreamingRenderer } = require('../../client/app/markdown/streaming-renderer');
const { splitStableTail } = require('../../client/app/markdown/stable-boundary');

function testEscapeCharactersAndAttributes() {
  const source = '&<>"\'`';
  const escaped = escapeHtml(source);
  assert.strictEqual(escaped, '&amp;&lt;&gt;&quot;&#39;&#96;');
  const attr = `<a title="${escaped}" data-copy-text="${escaped}">x</a>`;
  assert(!attr.includes(source), 'raw dangerous chars should not remain in attributes');
  assert(sanitizeHtml('<a href="javascript:alert(1)" onclick="x()">bad</a>').includes('javascript:') === false);
}

function testMarkdownBlankLinesAndFeatures() {
  const engine = createMarkdownEngine();
  const html = engine.render('para1\n\n\n\npara2\n\n- [x] task\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconsole.log("x")\n```\n\ninline $a+b$\n\n$$\nc=d\n$$\n');
  assert(html.includes('<p>para1</p>') && html.includes('<p>para2</p>'));
  assert(!html.includes('<br><br><br>'), 'blank lines should not explode into br runs');
  assert(html.includes('<table>') && html.includes('task-list-item-checkbox'));
  assert(html.includes('language-js') || html.includes('hljs'));
  assert(html.includes('katex') || html.includes('math-fallback'));
}

async function testCodeCopyAndMermaidDom() {
  const dom = new JSDOM('<div id="root"></div>');
  global.document = dom.window.document;
  global.innerHeight = 800;
  global.navigator = { clipboard: { writeText: async () => {} } };
  const root = document.getElementById('root');
  const engine = createMarkdownEngine();
  root.innerHTML = engine.render('```js\nconsole.log(1)\n```\n\n```mermaid\nsequenceDiagram\nA->>B: hi\n```');
  await enhanceRenderedMarkdown(root, { copyText: async text => assert.strictEqual(text, 'console.log(1)\n'), loadMermaid: async () => ({ initialize() {}, run: async () => {} }) });
  assert(root.querySelector('.code-block .code-copy-icon[data-copy-text]'), 'copy button DOM');
  assert(root.querySelector('.mermaid[data-mermaid-rendered="1"]'), 'mermaid rendered placeholder');

  const bad = document.createElement('div');
  bad.innerHTML = engine.render('```mermaid\ngantt\ntitle Bad\n```');
  const result = await renderMermaidBlocks(bad, async () => ({ initialize() {}, run: async () => { throw new Error('bad diagram'); } }));
  assert.strictEqual(result[0].ok, false);
  assert(bad.querySelector('.mermaid-fallback .markdown-error'), 'mermaid error fallback kept source');
  delete global.document;
  delete global.innerHeight;
  delete global.navigator;
}

async function testInvisibleMermaidIsDeferredUntilVisible() {
  const dom = new JSDOM('<div id="root"><div class="markdown-mermaid-pending" data-mermaid-rendered="0"><pre><code class="language-mermaid">graph TD; A-->B;</code></pre></div></div>');
  global.document = dom.window.document;
  global.innerHeight = 800;
  const root = document.getElementById('root');
  const block = root.querySelector('.markdown-mermaid-pending');
  block.getBoundingClientRect = () => ({ top: 5000, bottom: 5100 });
  let loads = 0;
  const first = await renderMermaidBlocks(root, async () => { loads += 1; return { initialize() {}, render: async () => ({ svg: '<svg></svg>' }) }; });
  assert.strictEqual(first.length, 0);
  assert.strictEqual(loads, 0, 'offscreen mermaid should not load/render immediately');
  block.getBoundingClientRect = () => ({ top: 100, bottom: 200 });
  const second = await renderMermaidBlocks(root, async () => { loads += 1; return { initialize() {}, render: async id => ({ svg: `<svg id="${id}"></svg>` }) }; });
  assert.strictEqual(second.length, 1);
  assert.strictEqual(loads, 1);
  assert(root.querySelector('.mermaid-rendered-block'));
  delete global.document;
  delete global.innerHeight;
}

function testStreamingSegmentsAndNoFullReplace() {
  const dom = new JSDOM('<div id="c"></div>');
  global.document = dom.window.document;
  const c = document.getElementById('c');
  let fullRepaint = 0;
  const desc = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  Object.defineProperty(c, 'innerHTML', { get() { return desc.get.call(this); }, set(v) { fullRepaint += 1; return desc.set.call(this, v); } });
  const r = createStreamingRenderer({ renderMarkdown: text => `<section>${escapeHtml(text)}</section>` });
  r.append('intro\n\n```mermaid\ngraph TD;\nA-->', c);
  assert(c.textContent.includes('intro'));
  assert(c.querySelector('.streaming-tail'), 'unclosed mermaid/code tail buffered');
  r.append('B;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |', c);
  assert(c.querySelector('.streaming-tail'), 'table without blank terminator buffered');
  r.append('\n\nmath $x', c);
  assert(splitStableTail(r.getRaw()).tail.includes('$x'), 'unclosed inline math buffered');
  r.append('$\n', c);
  const done = r.final(c);
  assert.notStrictEqual(done.mode, 'full-replace');
  assert.strictEqual(fullRepaint, 0);
  assert(c.textContent.includes('graph TD') && c.textContent.includes('math $x$'));
  delete global.document;
}

async function main() {
  testEscapeCharactersAndAttributes();
  testMarkdownBlankLinesAndFeatures();
  await testCodeCopyAndMermaidDom();
  await testInvisibleMermaidIsDeferredUntilVisible();
  testStreamingSegmentsAndNoFullReplace();
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { testEscapeCharactersAndAttributes, testMarkdownBlankLinesAndFeatures, testCodeCopyAndMermaidDom, testInvisibleMermaidIsDeferredUntilVisible, testStreamingSegmentsAndNoFullReplace };
