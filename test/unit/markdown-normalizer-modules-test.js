const assert = require('assert');
const { JSDOM } = require('jsdom');
const sourceNormalizer = require('../../client/app/markdown/source-normalizer');
const linkPolicy = require('../../client/app/markdown/link-policy');
const mermaidNormalizer = require('../../client/app/markdown/mermaid-normalizer');

function testSourceNormalizer() {
  assert.strictEqual(sourceNormalizer.normalizeEscapedUrlSlashes('https:\\/\\/openai.com'), 'https://openai.com');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>OK</text></svg>';
  const html = sourceNormalizer.normalizeMarkdownSource(`![图](data:image/svg+xml;utf8,${svg})`);
  assert.match(html, /^!\[图\]\(data:image\/svg\+xml;base64,/);
  const folded = sourceNormalizer.normalizeMarkdownSource('![内嵌SVG图片]\n(data:image/svg+xml;base64, PHN2Zz48L3N2Zz4= )');
  assert.strictEqual(folded, '![内嵌SVG图片](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)');
}

function testLinkPolicy() {
  assert.strictEqual(linkPolicy.isSafeMarkdownLink('https://example.com'), true);
  assert.strictEqual(linkPolicy.isSafeMarkdownLink('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), true);
  assert.strictEqual(linkPolicy.isSafeMarkdownLink('javascript:alert(1)'), false);
  assert.strictEqual(linkPolicy.isSafeMarkdownLink('data:text/html,<script>x</script>'), false);
}

function testMermaidNormalizer() {
  const arch = mermaidNormalizer.normalizeArchitectureMermaidSource('architecture-beta\nservice api[API服务]');
  assert(arch.includes('["API服务"]'));
  const sankey = mermaidNormalizer.normalizeBetaMermaidSource('sankey-beta\n  用户访问,首页,100\n  首页,详情页,60');
  assert(sankey.includes('sankey_node_1,sankey_node_2,100'));
  const replacements = mermaidNormalizer.getSankeyLabelReplacements('sankey-beta\n用户访问,首页,100');
  assert.deepStrictEqual(replacements.map(item => item.label), ['用户访问', '首页']);
  const dom = new JSDOM('<svg><text>sankey_node_1</text></svg>');
  mermaidNormalizer.restoreSankeySvgLabels(dom.window.document, 'sankey-beta\n用户访问,首页,100');
  assert.strictEqual(dom.window.document.querySelector('text').textContent, '用户访问');
  const radar = mermaidNormalizer.normalizeBetaMermaidSource('radar-beta\ntitle 技能雷达图\naxis HTML, CSS, JavaScript, Vue, Node.js\n"张三" : 90, 85, 80, 75, 70');
  assert(radar.includes('axis html["HTML"], css["CSS"], javascript["JavaScript"], vue["Vue"], node_js["Node.js"]'));
  assert(radar.includes('curve curve1["张三"]{90, 85, 80, 75, 70}'));
}

function testBrowserGlobals() {
  const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
  const fs = require('fs');
  const path = require('path');
  for (const file of ['source-normalizer.js', 'link-policy.js', 'mermaid-normalizer.js']) {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '../../client/app/markdown', file), 'utf8'));
  }
  assert.strictEqual(dom.window.ChatUIMarkdownSourceNormalizer.normalizeEscapedUrlSlashes('https:\\/\\/openai.com'), 'https://openai.com');
  assert.strictEqual(dom.window.ChatUIMarkdownLinkPolicy.isSafeMarkdownLink('javascript:alert(1)'), false);
  assert(dom.window.ChatUIMarkdownMermaidNormalizer.normalizeBetaMermaidSource('sankey-beta\n用户访问,首页,100').includes('sankey_node_1'));
}

function main() {
  testSourceNormalizer();
  testLinkPolicy();
  testMermaidNormalizer();
  testBrowserGlobals();
}

if (require.main === module) main();
module.exports = { testSourceNormalizer, testLinkPolicy, testMermaidNormalizer, testBrowserGlobals };
