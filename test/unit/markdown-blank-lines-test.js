const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createMarkdownEngine } = require('../../client/app/markdown/markdown-engine');
const { createStreamingRenderer } = require('../../client/app/markdown/streaming-renderer');

function count(html, re) { return (String(html).match(re) || []).length; }
function assertNoExcessBlankHtml(html, label) {
  assert.strictEqual(count(html, /<p>\s*<\/p>/g), 0, `${label}: should not emit empty paragraphs`);
  assert.ok(count(html, /<br\s*\/?/g) <= 1, `${label}: should not turn blank lines into many <br>`);
}

function fixture() {
  return `段落一


段落二

- item 1
- item 2

\`\`\`js
console.log(1)

console.log(2)
\`\`\`

结尾`;
}

function testStaticMarkdownBlankLines() {
  const engine = createMarkdownEngine();
  assert.ok(engine, 'markdown engine should be available');
  const html = engine.render(fixture());
  assertNoExcessBlankHtml(html, 'static markdown');
  assert.ok(html.includes('<p>段落一</p>') && html.includes('<p>段落二</p>'), 'paragraphs preserved');
  assert.ok(html.includes('<ul>') && html.includes('<li>item 1</li>') && html.includes('<li>item 2</li>'), 'list preserved');
  assert.ok(html.includes('console') && html.includes('\n\n'), 'code block content and intentional blank line preserved');
}

function testStreamingMarkdownBlankLines() {
  const dom = new JSDOM('<div id="root"></div>');
  global.document = dom.window.document;
  const root = dom.window.document.getElementById('root');
  const engine = createMarkdownEngine();
  const renderer = createStreamingRenderer({ renderMarkdown: text => engine.render(text) });
  const text = fixture();
  for (const chunk of text.match(/[\s\S]{1,7}/g)) renderer.append(chunk, root);
  renderer.final(root, text);
  const html = root.innerHTML;
  assertNoExcessBlankHtml(html, 'streaming markdown');
  assert.ok(root.querySelectorAll('p').length >= 3, 'streaming paragraphs preserved');
  assert.ok(root.querySelectorAll('li').length === 2, 'streaming list preserved');
  assert.ok(root.querySelector('pre code')?.textContent.includes('console.log(2)'), 'streaming code block preserved');
  delete global.document;
}

if (require.main === module) {
  testStaticMarkdownBlankLines();
  testStreamingMarkdownBlankLines();
  console.log('markdown blank-line rendering stays compact while preserving paragraphs/lists/code');
}

module.exports = { testStaticMarkdownBlankLines, testStreamingMarkdownBlankLines };
