const assert = require('assert');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createMarkdownEngine } = require('../../client/app/markdown/markdown-engine');
const { createStreamingRenderer } = require('../../client/app/markdown/streaming-renderer');
const { splitStableTail } = require('../../client/app/markdown/stable-boundary');

function textOf(html, selector) {
  const dom = new JSDOM(`<main>${html}</main>`);
  return dom.window.document.querySelector(selector)?.textContent;
}

function testSafeHtmlSubsetAndSecurity() {
  const engine = createMarkdownEngine();
  const html = engine.render('before <div class="box">x<br><kbd>⌘K</kbd><sub>2</sub><sup>3</sup><details><summary>more</summary><mark>ok</mark></details></div> **bold**');
  assert.match(html, /<div class="box">/);
  assert.match(html, /<br\s*\/?>/);
  assert(html.includes('<kbd>⌘K</kbd>'));
  assert(html.includes('<sub>2</sub>'));
  assert(html.includes('<sup>3</sup>'));
  assert(html.includes('<details>') && html.includes('<summary>more</summary>'));
  assert(html.includes('<strong>bold</strong>'), 'markdown should mix with raw HTML');

  const unsafe = engine.render('<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)" onclick="x()" style="color:red">bad</a><a href="data:text/html;base64,PHNjcmlwdA==">data</a>');
  assert(!unsafe.includes('<script'));
  assert(!/on\w+=/i.test(unsafe));
  assert(!new JSDOM(unsafe).window.document.querySelector('a[href^="javascript:"]'));
  assert(!unsafe.includes('data:text/html'));
  assert(!unsafe.includes('style="position') && !unsafe.includes('url('));

  const styled = engine.render('<div style="border:1px solid #999;padding:8px;position:fixed;unknown:1;background-image:url(javascript:alert(1))" onclick="x">box</div><style>body{}</style>');
  assert.match(styled, /style="[^"]*border: 1px solid #999[^"]*padding: 8px/);
  assert(!styled.includes('position'));
  assert(!styled.includes('unknown'));
  assert(!styled.includes('url('));
  assert(!/onclick|<style/i.test(styled));
}

function testBrowserParityForHtmlPolicy() {
  const dom = new JSDOM('<!doctype html><div></div>', { runScripts: 'outside-only' });
  dom.window.markdownit = require('markdown-it');
  dom.window.DOMPurify = require('dompurify')(dom.window);
  for (const file of ['source-normalizer.js', 'link-policy.js', 'mermaid-normalizer.js', 'browser-sanitizer.js', 'browser-engine.js', 'browser-enhancer.js', 'browser-streaming-renderer.js', 'browser.js']) {
    const code = fs.readFileSync(path.resolve(__dirname, '../../client/app/markdown', file), 'utf8');
    vm.runInContext(code, dom.getInternalVMContext(), { filename: file });
  }
  const browserHtml = dom.window.ChatUIMarkdown.renderMarkdown('<div>ok<br><kbd>K</kbd><sub>1</sub><sup>2</sup><details><summary>s</summary>x</details></div><script>x</script><img src=x onerror=x><a href="javascript:alert(1)">bad</a>');
  const nodeHtml = createMarkdownEngine().render('<div>ok<br><kbd>K</kbd><sub>1</sub><sup>2</sup><details><summary>s</summary>x</details></div><script>x</script><img src=x onerror=x><a href="javascript:alert(1)">bad</a>');
  for (const tag of ['div', 'br', 'kbd', 'sub', 'sup', 'details', 'summary']) {
    assert(browserHtml.includes(`<${tag}`), `browser keeps ${tag}`);
    assert(nodeHtml.includes(`<${tag}`), `node keeps ${tag}`);
  }
  for (const html of [browserHtml, nodeHtml]) {
    assert(!html.includes('<script'));
    assert(!/on\w+=/i.test(html));
    assert(!html.includes('javascript:'));
  }
}

function testTableAlignmentAndMathDelimiters() {
  const engine = createMarkdownEngine();
  const html = engine.render('| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |');
  assert(!html.includes('style='), 'table alignment should not use inline style');
  assert(html.includes('md-align-left'));
  assert(html.includes('md-align-center'));
  assert(html.includes('md-align-right'));

  const plainSquare = engine.render('\\[ 方括号 \\]');
  const plainParen = engine.render('\\( 圆括号 \\)');
  assert(plainSquare.includes('katex'), 'bracket delimiters are handled by markdown-it-texmath');
  assert(plainParen.includes('katex'), 'paren delimiters are handled by markdown-it-texmath');
  assert(new JSDOM(plainSquare).window.document.body.textContent.includes('方括号'));
  assert(new JSDOM(plainParen).window.document.body.textContent.includes('圆括号'));

  const math = engine.render('\\( \\alpha+\\beta \\) and \\[ \\sum_i x_i = 1 \\]');
  assert((math.match(/katex/g) || []).length >= 2, 'latex delimiters still render when math-like');
  const dollarMath = engine.render('行内公式：$E = mc^2$\n\n块级公式：\n$$ a^2 + b^2 = c^2 $$');
  assert((dollarMath.match(/katex/g) || []).length >= 2, 'dollar math renders through markdown-it-texmath');
  assert(!new JSDOM(dollarMath).window.document.body.textContent.includes('$E = mc^2$'), 'inline dollar delimiters are not shown as raw text');
  const code = engine.render('```txt\n\\( \\alpha+\\beta \\)\n$E = mc^2$\n```');
  assert(!code.includes('katex'), 'code fence must not render math');

  assert(!engine.render('\\vec{a}').includes('katex'), 'bare LaTeX is not guessed as math by ChatUI');
  assert(engine.render('\\( \\alpha+\\beta \\)').includes('katex'), 'bracket math renders via markdown-it-texmath');
  assert(engine.render('\\[ \\sum_i x_i = 1 \\]').includes('katex'), 'display bracket math renders via markdown-it-texmath');
}

function testFormulaAngleWrapperCompatibility() {
  const engine = createMarkdownEngine();
  const wrapped = engine.render('公式示例: > $score = a + b$ >');
  assert(new JSDOM(wrapped).window.document.body.textContent.includes('>'), 'non-CommonMark formula wrapper repair is no longer a semantic pre-pass');
  assert(wrapped.includes('katex'), 'inner formula still renders via markdown-it-texmath');
  const comparison = engine.render('a > b and $x$');
  assert(new JSDOM(comparison).window.document.body.textContent.includes('a > b'), 'comparison > preserved');
  const blockquote = engine.render('> $x$');
  assert(new JSDOM(blockquote).window.document.querySelector('blockquote'), 'real blockquote preserved');
  const code = engine.render('```txt\n公式示例: > $x$ >\n```');
  assert.strictEqual(new JSDOM(code).window.document.querySelector('code').textContent, '公式示例: > $x$ >\n');
}

function testEscapesLinksAndStreamingChunks() {
  const dom = new JSDOM('<div id="c"></div>');
  global.document = dom.window.document;
  const c = document.getElementById('c');
  const engine = createMarkdownEngine();
  const renderer = createStreamingRenderer({ renderMarkdown: text => engine.render(text) });
  renderer.append('\\', c); // produces one markdown escape slash before the heading marker
  renderer.append('# 这不是标题\n', c);
  renderer.append('more\n', c);
  renderer.append('\\*这不是斜体\\*\n', c);
  renderer.append('[Open', c);
  renderer.append('AI](https://openai.com)\n', c);
  renderer.final(c);
  assert(!c.querySelector('h1'), 'escaped # must not become h1');
  assert(!c.querySelector('em'), 'escaped * must not become em');
  assert.strictEqual((c.textContent.match(/这不是标题/g) || []).length, 1, 'escaped heading line not duplicated');
  assert(c.textContent.includes('# 这不是标题'));
  assert(c.textContent.includes('*这不是斜体*'));
  const a = c.querySelector('a[href="https://openai.com"]');
  assert(a && a.textContent === 'OpenAI', 'chunked markdown link renders');
  delete global.document;

  const oneShot = engine.render('[OpenAI](https://openai.com)');
  assert(new JSDOM(oneShot).window.document.querySelector('a[href="https://openai.com"]'));

  const escapeHtml = engine.render('\\*这不是斜体\\*\n\\# 这不是标题');
  const escapeDom = new JSDOM(escapeHtml).window.document;
  assert.strictEqual(escapeDom.body.textContent.trim(), '*这不是斜体*\n# 这不是标题');
  assert(!escapeDom.querySelector('em,h1,h2'), 'one-shot escaped emphasis and heading remain plain text');

  const streamCases = [
    ['\\', '# 这不是标题'],
    ['\\# 这不是标题\n', 'more'],
  ];
  for (const [first, second] of streamCases) {
    const domCase = new JSDOM('<div id="c"></div>');
    global.document = domCase.window.document;
    const node = document.getElementById('c');
    const r = createStreamingRenderer({ renderMarkdown: text => engine.render(text) });
    r.append(first, node);
    r.append(second, node);
    r.final(node);
    assert(!node.querySelector('h1,h2'), 'stream escaped heading must not become heading');
    assert(!node.textContent.includes('\\'), 'stream final should not leave escape slash');
    assert.strictEqual((node.textContent.match(/这不是标题/g) || []).length, 1, 'stream final should not duplicate heading text');
    assert(node.textContent.includes('# 这不是标题'), 'stream final should show literal # heading text');
    delete global.document;
  }
}

function testFenceAndBlockquoteCodeRegressions() {
  const engine = createMarkdownEngine();
  const htmlNoNl = engine.render('```python\nprint("Hello")\n```');
  const domNoNl = new JSDOM(htmlNoNl);
  const code = domNoNl.window.document.querySelector('pre > code.language-python, pre > code.hljs');
  assert(code, 'python fence without trailing newline renders code block');
  assert.strictEqual(code.textContent, 'print("Hello")\n');
  assert(!code.textContent.includes('> print'));

  const strayQuoteFence = textOf(engine.render('```python\n> print("Hello from quote")\n>\n```\n'), 'pre code');
  assert.strictEqual(strayQuoteFence, 'print("Hello from quote")\n\n', 'quoted fenced-code markers stripped narrowly when every content line is quote-prefixed');

  const blockquote = engine.render('> ```python\n> print("Hello from quote")\n> ```\n');
  const domBq = new JSDOM(blockquote);
  const bqCode = domBq.window.document.querySelector('blockquote pre code');
  assert(bqCode, 'blockquote fenced code renders inside blockquote');
  assert.strictEqual(bqCode.textContent, 'print("Hello from quote")\n');

  const repl = textOf(engine.render('```python\n>>> print("Hello")\nHello\n```'), 'pre code');
  assert.strictEqual(repl, '>>> print("Hello")\nHello\n', 'real Python REPL prompt preserved');

  const gt = textOf(engine.render('```python\nif a > b:\n    print(a)\n```'), 'pre code');
  assert.strictEqual(gt, 'if a > b:\n    print(a)\n', 'real > inside code preserved exactly once');
}

function testStreamingFenceFinalAndBlankLines() {
  const dom = new JSDOM('<div id="c"></div>');
  global.document = dom.window.document;
  const c = document.getElementById('c');
  const engine = createMarkdownEngine();
  const r = createStreamingRenderer({ renderMarkdown: text => engine.render(text) });
  r.append('```python\n', c);
  r.append('print(1)\n', c);
  const beforeClose = r.append('```', c);
  assert.strictEqual(splitStableTail(r.getRaw()).tail, '', 'closed fence without trailing newline is stable');
  assert.strictEqual(beforeClose.tail, '', 'streamer consumes closed fence without trailing newline');
  r.final(c);
  const code = c.querySelector('pre code');
  assert(code && code.textContent === 'print(1)\n');
  assert(!code.textContent.includes('>'));
  delete global.document;

  const bqDom = new JSDOM('<div id="bq"></div>');
  global.document = bqDom.window.document;
  const bq = document.getElementById('bq');
  const bqRenderer = createStreamingRenderer({ renderMarkdown: text => engine.render(text) });
  bqRenderer.append('> ```python\n', bq);
  bqRenderer.append('> print("Hello from quote")\n', bq);
  const bqBeforeClose = bqRenderer.append('> ```', bq);
  assert.strictEqual(bqBeforeClose.tail, '', 'closed blockquote fence without trailing newline is stable');
  let bqCode = bq.querySelector('blockquote pre code');
  assert(bqCode, 'streaming blockquote fenced code renders as code when fence closes');
  assert.strictEqual(bqCode.textContent, 'print("Hello from quote")\n');
  assert(!bqCode.textContent.includes('> print'));
  bqRenderer.final(bq);
  bqCode = bq.querySelector('blockquote pre code');
  assert.strictEqual(bqCode.textContent, 'print("Hello from quote")\n');
  delete global.document;

  const html = engine.render('```txt\nline 1\n\nline 3\n```\n\npara\n\n\nnext');
  assert.strictEqual(textOf(html, 'pre code'), 'line 1\n\nline 3\n', 'code block blank lines preserved');
  assert(html.includes('<p>para</p>') && html.includes('<p>next</p>'));
}

function testReportedCodeAndEscapeRegressions() {
  const engine = createMarkdownEngine();

  const plainPython = new JSDOM(engine.render('```python\nprint("Hello")\n```'));
  assert.strictEqual(plainPython.window.document.querySelector('pre code').textContent, 'print("Hello")\n', 'A plain python fenced code has no extra >');

  const quotedPython = new JSDOM(engine.render('> ```python\n> print("Hello from quote")\n> ```\n'));
  assert.strictEqual(quotedPython.window.document.querySelector('blockquote pre code').textContent, 'print("Hello from quote")\n', 'B blockquote fence marker stripped from code text');

  const replPython = new JSDOM(engine.render('```python\n>>> print("Hello")\n```'));
  assert.strictEqual(replPython.window.document.querySelector('pre code').textContent, '>>> print("Hello")\n', 'C Python REPL >>> preserved');

  const comparisonPython = new JSDOM(engine.render('```python\nif a > b:\n    print(a)\n```'));
  assert.strictEqual(comparisonPython.window.document.querySelector('pre code').textContent, 'if a > b:\n    print(a)\n', 'D comparison > preserved');

  const escaped = new JSDOM(engine.render('\\*这不是斜体\\*\n\\# 这不是标题'));
  assert.strictEqual(escaped.window.document.body.textContent.trim(), '*这不是斜体*\n# 这不是标题', 'E escaped text renders without residual slash');
  assert(!escaped.window.document.querySelector('em,h1,h2'), 'E escaped markdown does not create em/heading');

  for (const chunks of [["\\", '# 这不是标题'], ['\\# 这不是标题\n', 'more']]) {
    const dom = new JSDOM('<div id="c"></div>');
    global.document = dom.window.document;
    const c = document.getElementById('c');
    const renderer = createStreamingRenderer({ renderMarkdown: text => engine.render(text) });
    chunks.forEach(chunk => renderer.append(chunk, c));
    renderer.final(c);
    assert(!c.querySelector('h1,h2'), 'F streaming escaped heading does not create heading');
    assert(!c.textContent.includes('\\'), 'F streaming escaped heading has no residual slash');
    assert.strictEqual((c.textContent.match(/# 这不是标题/g) || []).length, 1, 'F streaming escaped heading not duplicated');
    delete global.document;
  }

  const rawCode = new JSDOM(engine.render('```\n这是一个普通代码块\n可以显示原始文本\n**不会被解析为加粗**\n# heading\n[link](url)\n$math$\n<b>html</b>\n```'));
  const code = rawCode.window.document.querySelector('pre code');
  assert(code, 'G/H raw code block exists');
  assert(code.textContent.includes('**不会被解析为加粗**'), 'G strong markdown kept as raw text');
  assert(!code.querySelector('strong'), 'G code block contains no strong element');
  for (const raw of ['# heading', '[link](url)', '$math$', '<b>html</b>']) assert(code.textContent.includes(raw), `H code block keeps raw ${raw}`);
  assert(!code.querySelector('a,.katex,.math-fallback,b,h1,h2,h3'), 'H code block contains no parsed markdown/math/html nodes');
}


function testTableMarkdownPluginAndEscapedUrlLinks() {
  const engine = createMarkdownEngine();
  const html = engine.render('| 项目 | 内容 |\n|---|:---:|\n| 加粗 | **bold** |\n| 链接 | https:\\/\\/openai.com |\n| 语法链接 | [OpenAI](https:\\/\\/openai.com) |');
  const dom = new JSDOM(html);
  const links = [...dom.window.document.querySelectorAll('td a')];
  assert(links.some(a => a.href === 'https://openai.com/' && a.textContent === 'https://openai.com'), 'escaped bare URL inside table should be normalized and linkified');
  assert(links.some(a => a.getAttribute('href') === 'https://openai.com' && a.textContent === 'OpenAI'), 'escaped markdown link URL inside table should be normalized');
  assert(dom.window.document.querySelector('td strong')?.textContent === 'bold', 'inline markdown inside table remains rendered by markdown-it table plugin');
  assert(!dom.window.document.body.textContent.includes('https:\\/\\/openai.com'), 'escaped URL slashes are not shown to the user');
}

function testStreamingFinalCommitsTailWithoutFullRerenderWhenEquivalent() {
  const engine = createMarkdownEngine();
  const dom = new JSDOM('<div id="c"></div>');
  global.document = dom.window.document;
  const c = document.getElementById('c');
  const renderer = createStreamingRenderer({ renderMarkdown: text => engine.render(text) });
  renderer.append('第一段\n\n', c);
  renderer.append('第二段', c);
  assert(c.querySelector('.streaming-tail'), 'unfinished tail is shown as text while streaming');
  const result = renderer.final(c);
  assert.strictEqual(result.mode, 'incremental-final', 'equivalent tail commit should not replace the whole message and flash');
  assert(!c.querySelector('.streaming-tail'));
  assert.strictEqual(c.querySelectorAll('p').length, 2);
  delete global.document;
}

function main() {
  testSafeHtmlSubsetAndSecurity();
  testBrowserParityForHtmlPolicy();
  testTableAlignmentAndMathDelimiters();
  testTableMarkdownPluginAndEscapedUrlLinks();
  testFormulaAngleWrapperCompatibility();
  testEscapesLinksAndStreamingChunks();
  testFenceAndBlockquoteCodeRegressions();
  testStreamingFenceFinalAndBlankLines();
  testReportedCodeAndEscapeRegressions();
  testStreamingFinalCommitsTailWithoutFullRerenderWhenEquivalent();
}

if (require.main === module) {
  main();
}

module.exports = { testSafeHtmlSubsetAndSecurity, testBrowserParityForHtmlPolicy, testTableAlignmentAndMathDelimiters, testTableMarkdownPluginAndEscapedUrlLinks, testFormulaAngleWrapperCompatibility, testEscapesLinksAndStreamingChunks, testFenceAndBlockquoteCodeRegressions, testStreamingFenceFinalAndBlankLines, testReportedCodeAndEscapeRegressions, testStreamingFinalCommitsTailWithoutFullRerenderWhenEquivalent };
