const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createMarkdownEngine } = require('../../client/app/markdown/markdown-engine');
const { createStreamingRenderer } = require('../../client/app/markdown/streaming-renderer');
const { sanitizeHtml } = require('../../client/app/markdown/sanitizer');

function dom(html) { return new JSDOM(`<main>${html}</main>`).window.document; }
function text(html) { return dom(html).body.textContent; }

function testStandardGfm() {
  const engine = createMarkdownEngine();
  const html = engine.render('# H\n\n**bold** [link](https://example.com)\n\n| L | C | R |\n|:--|:-:|--:|\n| a | b | c |\n\n- [x] task\n\n~~gone~~');
  const d = dom(html);
  assert(d.querySelector('h1'));
  assert(d.querySelector('strong'));
  assert(d.querySelector('a[href="https://example.com"][target="_blank"]'));
  assert(d.querySelector('table'));
  assert(d.querySelector('.task-list-item-checkbox[checked]'));
  assert(d.querySelector('s'));
}

function testCodeRawAndEscapes() {
  const engine = createMarkdownEngine();
  const code = engine.render('```txt\n**bold**\n# h\n[link](x)\n$math$\n<b>html</b>\n```');
  const codeText = dom(code).querySelector('code').textContent;
  assert.strictEqual(codeText, '**bold**\n# h\n[link](x)\n$math$\n<b>html</b>\n');
  assert(!dom(code).querySelector('code strong, code a, code .katex, code b'));

  const escaped = engine.render('\\# h\n\\*em\\*\n\\[x\\]\n\\(y\\)\n\\|');
  assert.strictEqual(text(escaped).trim(), '# h\n*em*\n[x]\n(y)\n|');
  assert(!dom(escaped).querySelector('h1,em,a,.katex'));
}

function testMathAndMermaid() {
  const engine = createMarkdownEngine();
  const math = engine.render('$a+b$\n\n$$\nc=d\n$$\n\n\\(\\alpha+\\beta\\)\n\n\\[\\sum_i x_i=1\\]');
  assert((math.match(/katex/g) || []).length >= 4);
  assert(!engine.render('\\[ 方括号 \\]').includes('katex'));
  assert(!engine.render('\\( 圆括号 \\)').includes('katex'));
  const mermaid = engine.render('```mermaid\ngraph TD; A-->B;\n```');
  const d = dom(mermaid);
  assert(d.querySelector('.markdown-mermaid-pending code.language-mermaid'));
  assert.strictEqual(d.querySelector('code').textContent, 'graph TD; A-->B;\n');
}

function testTableAlignmentAndSanitizer() {
  const engine = createMarkdownEngine();
  const html = engine.render('| L | C | R |\n|:--|:-:|--:|\n| a | b | c |');
  assert(html.includes('md-align-left') && html.includes('md-align-center') && html.includes('md-align-right'));
  assert(!html.includes('style="text-align'));
  const safe = sanitizeHtml('<div style="color:red;position:fixed;background-image:url(javascript:alert(1));padding:4px" onclick="x"><script>x</script>ok</div>');
  assert(safe.includes('color: red') && safe.includes('padding: 4px'));
  assert(!/position|url\(|onclick|<script/i.test(safe));
}

function testStreamingFinalFullRender() {
  const engine = createMarkdownEngine();
  const domEnv = new JSDOM('<div id="c"></div>');
  global.document = domEnv.window.document;
  const c = document.getElementById('c');
  const r = createStreamingRenderer({ renderMarkdown: value => engine.render(value) });
  r.append('| A | B |\n| - | - |\n| 1 |', c);
  assert(c.querySelector('.streaming-tail'), 'complex partial markdown is kept as text tail');
  r.append(' 2 |\n', c);
  const result = r.final(c);
  assert.strictEqual(result.mode, 'full-rerender-final');
  assert(c.querySelector('table'));
  assert(!c.querySelector('.streaming-tail'));
  delete global.document;
}

function main() {
  testStandardGfm();
  testCodeRawAndEscapes();
  testMathAndMermaid();
  testTableAlignmentAndSanitizer();
  testStreamingFinalFullRender();
}

if (require.main === module) main();
module.exports = { testStandardGfm, testCodeRawAndEscapes, testMathAndMermaid, testTableAlignmentAndSanitizer, testStreamingFinalFullRender };
