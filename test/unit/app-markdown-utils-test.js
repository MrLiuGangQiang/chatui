#!/usr/bin/env node
const assert = require('assert');
const {
  GFM_EMOJI_SHORTCODES,
  replaceGfmEmojiShortcodes,
  normalizeExtendedMarkdown,
  prepareMarkdownSource,
  renderLists,
  renderLegacyCodeBlockHtml,
  extractLegacyCodeBlocks,
  restoreLegacyCodeBlocks,
  renderLegacyInlineMarkdown,
  wrapLegacyParagraphs,
  renderMarkdownLegacy,
  extractMathSegments,
  restoreMathSegments,
  restoreRawMathSegments,
  slugifyHeading,
  repairMarkdownPunctuation,
  repairCollapsedMarkdownBlocks,
  normalizeMathExpression,
  repairLooseMathHtml,
  normalizeLooseMath,
  splitTableRow,
  renderTables,
} = require('../../client/app/markdown-utils');

assert.strictEqual(GFM_EMOJI_SHORTCODES.rocket, '🚀');
assert.strictEqual(replaceGfmEmojiShortcodes('ship :rocket: and :unknown:'), 'ship 🚀 and :unknown:');
assert.strictEqual(replaceGfmEmojiShortcodes('inline `:rocket:` stays'), 'inline `:rocket:` stays');
assert.strictEqual(replaceGfmEmojiShortcodes('```\n:rocket:\n```'), '```\n:rocket:\n```');
assert.strictEqual(
  normalizeExtendedMarkdown('See [site][ref]\n\n[ref]: https://example.com "Example"'),
  'See [site](https://example.com "Example")\n\n[ref]: https://example.com "Example"',
);
assert.strictEqual(normalizeExtendedMarkdown('==mark== ~sub~ ^sup^ :rocket:'), '<mark>mark</mark> <sub>sub</sub> <sup>sup</sup> 🚀');
assert.strictEqual(
  normalizeExtendedMarkdown('Text[^1]\n\n[^1]: note **x**', { renderMarkdown: value => `<p>${value}</p>`, escapeAttr: value => `safe-${value}` }),
  'Text<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">[1]</a></sup>\n\n\n<section class="footnotes">\n<ol>\n<li id="fn-safe-1">note **x** <a href="#fnref-safe-1" class="footnote-backref">↩</a></li>\n</ol>\n</section>',
);
assert.strictEqual(prepareMarkdownSource('a｜b text### title :rocket:'), 'a｜b text### title 🚀');
assert.strictEqual(normalizeMathExpression('1 < sup > 1 < / sup > and H < sub > 2 < / sub > O'), '1 ^{1} and H _{2} O');
assert.strictEqual(repairLooseMathHtml('`< sup >code< / sup >`'), '`< sup >code< / sup >`');
assert.strictEqual(prepareMarkdownSource('1 &lt; sup &gt; 1 &lt; / sup &gt;'), '1 ^{1}');
assert.strictEqual(normalizeLooseMath('next is 6^6 and x_1'), 'next is $6^{6}$ and $x_{1}$');
assert.strictEqual(normalizeLooseMath('`6^6` remains code'), '`6^6` remains code');
assert.strictEqual(normalizeLooseMath('keep $x^2$ and only fix y^3'), 'keep $x^2$ and only fix $y^{3}$');
assert.strictEqual(normalizeLooseMath('[x_1](https://example.com/a_b) plain z_2'), '[x_1](https://example.com/a_b) plain $z_{2}$');
assert.strictEqual(renderLists('- a\n- b\nplain\n1. one'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\nplain\n<ol>\n<li>one</li>\n</ol>');
assert.strictEqual(
  renderLegacyCodeBlockHtml({ lang: 'js', raw: 'const x = 1;' }, { escapeHtml: value => String(value), escapeAttr: value => `attr:${value}`, copyIconSvg: '<svg></svg>' }),
  '<div class="code-block"><span class="code-lang">js</span><button class="inline-copy code-copy-icon" type="button" title="复制代码" aria-label="复制代码" data-copy-text="attr:const x = 1;"><svg></svg></button><pre><code>const x = 1;</code></pre></div>',
);
assert.strictEqual(JSON.stringify(extractLegacyCodeBlocks('a```js\nx\n```b')), '{"text":"a@@CODE0@@b","blocks":[{"lang":"js","raw":"x"}]}');
assert.strictEqual(restoreLegacyCodeBlocks('@@CODE0@@', [{ lang: 'text', raw: '<x>' }], { escapeHtml: value => String(value).replace('<', '&lt;').replace('>', '&gt;'), escapeAttr: value => String(value) }), '<div class="code-block"><button class="inline-copy code-copy-icon" type="button" title="复制代码" aria-label="复制代码" data-copy-text="<x>"></button><pre><code>&lt;x&gt;</code></pre></div>');
assert.strictEqual(renderLegacyInlineMarkdown('# T\n**b** ~~d~~'), '<h1>T</h1>\n<strong>b</strong> <del>d</del>');
assert.strictEqual(wrapLegacyParagraphs('a\nb\n\n<h1>T</h1>'), '<p>a<br>b</p><h1>T</h1>');
assert.strictEqual(renderMarkdownLegacy('**b**\n\n```txt\nx\n```', { escapeHtml: value => String(value), escapeAttr: value => String(value), copyIconSvg: 'I' }), '<p><strong>b</strong></p><p><div class="code-block"><button class="inline-copy code-copy-icon" type="button" title="复制代码" aria-label="复制代码" data-copy-text="x">I</button><pre><code>x</code></pre></div></p>');

const extracted = extractMathSegments('inline $a+b$ and display $$x^2$$');
assert.strictEqual(extracted.text, 'inline @@MATH0@@ and display @@MATH1@@');
assert.deepStrictEqual(extracted.math, [
  { raw: 'a+b', displayMode: false },
  { raw: 'x^2', displayMode: true },
]);
assert.strictEqual(extractMathSegments('```\n$not math$\n```').math.length, 0);
assert.strictEqual(
  restoreMathSegments('A @@MATH0@@', [{ raw: '<x>', displayMode: false }], { escapeHtml: value => String(value).replace('<', '&lt;').replace('>', '&gt;') }),
  'A <span class="math-fallback">&lt;x&gt;</span>',
);
assert.strictEqual(
  restoreMathSegments('A @@MATH0@@', [{ raw: 'x', displayMode: true }], { katex: { renderToString: (raw, options) => `${raw}:${options.displayMode}` } }),
  'A x:true',
);
assert.strictEqual(restoreRawMathSegments('A @@MATH0@@ and @@MATH1@@', [{ raw: 'x^2', displayMode: false }, { raw: 'y', displayMode: true }]), 'A $x^2$ and $$y$$');

assert.strictEqual(slugifyHeading(' Hello, ChatUI! 你好 '), 'hello-chatui-你好');
assert.strictEqual(slugifyHeading('A--- B'), 'a-b');
assert.strictEqual(repairMarkdownPunctuation('a｜b − c ＊d‘x’'), 'a｜b − c ＊d‘x’');
assert.strictEqual(repairCollapsedMarkdownBlocks('text```js\ncode'), 'text```js\ncode');
assert.strictEqual(repairCollapsedMarkdownBlocks('text### title'), 'text### title');
assert.deepStrictEqual(splitTableRow('| a | b |'), ['a', 'b']);
assert.strictEqual(
  renderTables('| A | B |\n|---|---|\n| 1 | 2 |\nend'),
  '<div class="table-wrap"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>\nend',
);
assert.strictEqual(renderTables('plain'), 'plain');

console.log('app markdown utils ok');
