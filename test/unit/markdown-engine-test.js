const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createMarkdownEngine } = require('../../client/app/markdown/markdown-engine');
const { createMarkdownRenderer } = require('../../client/app/markdown');
const { enhanceCodeCopy } = require('../../client/app/markdown/code-copy');
const { renderMermaidBlocks } = require('../../client/app/markdown/mermaid-renderer');

function renderFixture() {
  const engine = createMarkdownEngine();
  assert.ok(engine, 'markdown engine should be created');
  return engine.render(`# Title

**bold**

| A | B |
| - | - |
| 1 | 2 |

- [x] done

~~deleted~~ http://example.com :smile:

footnote[^1]

[^1]: footnote text

Term
: Definition text

*[HTML]: Hyper Text Markup Language
HTML

==marked== H~2~O x^2^

\`\`\`js
console.log(1)
\`\`\`

Inline math $E=mc^2$.

$$
a^2+b^2=c^2
$$

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

<img src=x onerror=alert(1)><script>alert(1)</script>[bad](javascript:alert(1))
`);
}

function testMarkdownEngineStaticFeatures() {
  const html = renderFixture();
  assert.match(html, /<h1[^>]*>Title<\/h1>/, 'heading');
  assert.ok(html.includes('<strong>bold</strong>'), 'bold');
  assert.ok(html.includes('<table>') && html.includes('<td>1</td>'), 'table');
  assert.ok(html.includes('contains-task-list') && html.includes('task-list-item-checkbox'), 'task list');
  assert.ok(html.includes('<s>deleted</s>'), 'strikethrough');
  assert.ok(html.includes('<a href="http://example.com" target="_blank" rel="noopener noreferrer">http://example.com</a>'), 'autolink');
  assert.ok(html.includes('😄') || html.includes('smile'), 'emoji');
  assert.ok(html.includes('footnote-ref') && html.includes('footnote-item'), 'footnote');
  assert.ok(html.includes('<dl>') && html.includes('<dt>Term</dt>') && html.includes('<dd>Definition text</dd>'), 'deflist');
  assert.ok(html.includes('<abbr title="Hyper Text Markup Language">HTML</abbr>'), 'abbr');
  assert.ok(html.includes('<mark>marked</mark>'), 'mark');
  assert.ok(html.includes('H<sub>2</sub>O') && html.includes('x<sup>2</sup>'), 'sub/sup');
  assert.match(html, /<code class="hljs language-js">/, 'highlight.js code class');
  assert.ok(html.includes('katex') && html.includes('<math'), 'math formula');
  assert.ok(html.includes('markdown-mermaid-pending') && html.includes('language-mermaid'), 'mermaid placeholder');
  assert.ok(!html.includes('<script>') && !html.includes('onerror') && !html.includes('javascript:'), 'dangerous html sanitized');
}

function testKatexSanitizerKeepsLayoutStyles() {
  const engine = createMarkdownEngine();
  const html = engine.render(String.raw`$$
\begin{aligned}
a^2+b^2 &= c^2 \\
\sum_{i=1}^{n} i &= \frac{n(n+1)}{2} \\
\prod_{k=1}^{n} k &= n!
\end{aligned}
$$

$$
f(x)=\begin{cases}
x^2, & x \ge 0 \\
-x, & x < 0
\end{cases}
$$`);
  assert.ok(html.includes('katex-display'), 'block math renders through KaTeX');
  assert.match(html, /style="[^"]*(?:height|vertical-align|top):/, 'KaTeX layout styles survive sanitizer so tall formulas do not collapse');
  assert.ok(!html.includes('javascript:') && !html.includes('onerror'), 'KaTeX sanitizer still strips dangerous content');
}

async function testRendererApiAndEnhancers() {
  const dom = new JSDOM('<div id="root"></div>');
  global.document = dom.window.document;
  global.navigator = { clipboard: { writeText: async () => {} } };

  const root = dom.window.document.getElementById('root');
  const renderer = createMarkdownRenderer();
  const result = await renderer.renderInto(root, '```js\nconsole.log(1)\n```\n\n```mermaid\ngraph TD; A-->B;\n```', {
    loadMermaid: async () => ({ initialize() {}, render: async id => ({ svg: `<svg id="${id}"><text>A graph</text></svg>` }) }),
    copyText: async text => assert.strictEqual(text, 'console.log(1)\n'),
  });
  assert.ok(result.html.includes('language-js'));
  assert.ok(root.querySelector('.code-block .code-copy-icon'), 'code copy button added');
  assert.ok(root.querySelector('.mermaid[data-mermaid-rendered="1"] svg'), 'mermaid block rendered through API');

  const fallbackRoot = dom.window.document.createElement('div');
  fallbackRoot.innerHTML = '<div class="markdown-mermaid-pending" data-mermaid-rendered="0"><pre><code class="language-mermaid">bad</code></pre></div>';
  const statuses = await renderMermaidBlocks(fallbackRoot, async () => { throw new Error('no mermaid'); });
  assert.strictEqual(statuses.length, 1);
  assert.strictEqual(statuses[0].ok, false);
  assert.ok(fallbackRoot.querySelector('.mermaid-fallback'), 'single mermaid failure isolated as fallback');

  const multiRoot = dom.window.document.createElement('div');
  multiRoot.innerHTML = ['pie title Pets\\n  "Dogs" : 4', 'erDiagram\\n  USER ||--o{ POST : writes', 'flowchart TD\\n  A-->B', 'sequenceDiagram\\n  A->>B: hi']
    .map(src => `<div class="mermaid-block markdown-mermaid-pending" data-mermaid-rendered="0"><pre><code class="language-mermaid">${src}</code></pre></div>`).join('');
  const multi = await renderMermaidBlocks(multiRoot, async () => ({ initialize() {}, render: async (id, source) => ({ svg: `<svg id="${id}"><text>${source.split('\\n')[0]}</text></svg>` }) }));
  assert.strictEqual(multi.filter(item => item.ok).length, 4);
  assert.strictEqual(multiRoot.querySelectorAll('.mermaid-rendered-block').length, 4, 'each mermaid source keeps an independent holder');
  assert.strictEqual(multiRoot.querySelectorAll('.mermaid svg').length, 4, 'one svg per mermaid block');
  const holders = [...multiRoot.querySelectorAll('.mermaid-rendered-block')];
  assert.deepStrictEqual(holders.map(node => node.textContent.trim()), ['pie title Pets', 'erDiagram', 'flowchart TD', 'sequenceDiagram']);
  const ids = [...multiRoot.querySelectorAll('.mermaid')].map(node => node.id);
  assert.strictEqual(new Set(ids).size, 4, 'mermaid render ids are unique per block');

  await renderMermaidBlocks(multiRoot, async () => { throw new Error('should not rerender already rendered diagrams'); });
  assert.strictEqual(multiRoot.querySelectorAll('.mermaid svg').length, 4, 'second enhance does not stack stale svg nodes');

  const rerenderRoot = dom.window.document.createElement('div');
  rerenderRoot.innerHTML = '<div class="mermaid-block markdown-mermaid-pending" data-mermaid-rendered="0"><pre><code class="language-mermaid">flowchart TD\\nA-->B</code></pre></div>';
  await renderMermaidBlocks(rerenderRoot, async () => ({ initialize() {}, render: async id => ({ svg: `<svg id="${id}"><text>new only</text></svg>` }) }));
  rerenderRoot.innerHTML = '<div class="mermaid-block markdown-mermaid-pending" data-mermaid-rendered="0"><pre><code class="language-mermaid">pie title Fresh</code></pre></div>';
  await renderMermaidBlocks(rerenderRoot, async () => ({ initialize() {}, render: async id => ({ svg: `<svg id="${id}"><text>fresh only</text></svg>` }) }));
  assert.strictEqual(rerenderRoot.querySelectorAll('.mermaid svg').length, 1, 'final full rerender leaves only current svg');
  assert(!rerenderRoot.textContent.includes('new only'), 'old mermaid svg/text removed after final rerender');

  const staleRoot = dom.window.document.createElement('div');
  staleRoot.innerHTML = '<div class="mermaid-block markdown-mermaid-pending" data-mermaid-rendered="0"><pre><code class="language-mermaid">flowchart TD\\nOld-->Late</code></pre></div>';
  let releaseLate;
  const late = renderMermaidBlocks(staleRoot, async () => ({
    initialize() {},
    render: async id => new Promise(resolve => { releaseLate = () => resolve({ svg: `<svg id="${id}"><text>late old</text></svg>` }); }),
  }));
  await new Promise(resolve => setTimeout(resolve, 0));
  staleRoot.innerHTML = '<p>new final markdown without old mermaid</p>';
  releaseLate();
  const staleResult = await late;
  assert.strictEqual(staleResult[0].stale, true, 'late async mermaid result is marked stale');
  assert(!staleRoot.textContent.includes('late old'), 'late old async result must not write into new DOM');

  const copyRoot = dom.window.document.createElement('div');
  copyRoot.innerHTML = '<pre><code class="language-js">console.log(2)</code></pre>';
  enhanceCodeCopy(copyRoot, async text => assert.strictEqual(text, 'console.log(2)'));
  assert.ok(copyRoot.querySelector('.code-block button[data-copy-text]'));

  delete global.document;
  delete global.navigator;
}

async function main() {
  testMarkdownEngineStaticFeatures();
  testKatexSanitizerKeepsLayoutStyles();
  await testRendererApiAndEnhancers();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { testMarkdownEngineStaticFeatures, testKatexSanitizerKeepsLayoutStyles, testRendererApiAndEnhancers };
