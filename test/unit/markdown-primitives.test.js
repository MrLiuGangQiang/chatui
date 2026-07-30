'use strict';

const assert = require('assert');
const linkPolicy = require('../../client/app/markdown/link-policy');
const mathRenderer = require('../../client/app/markdown/math-renderer');
const mermaidNormalizer = require('../../client/app/markdown/mermaid-normalizer');

function testMarkdownLinkPolicyAcceptsOrdinaryAndStrictRasterUrls() {
  assert.strictEqual(Object.isFrozen(linkPolicy), true, 'the browser-facing link policy facade must be immutable');

  const safeUrls = [
    '',
    '#usage',
    '/docs/guide?q=markdown#links',
    '../assets/example.png',
    '//cdn.example.test/library.js',
    'https://example.test/path?q=hello%20world',
    'http://localhost:3000/health',
    'mailto:help@example.test',
    'tel:+12025550123',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==',
    'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    'data:image/jpg;base64,/9j/4AAQSkZJRg==',
    'data:image/webp;base64,UklGRgAAAABXRUJQVlA4',
    'data:image/avif;base64,AAAAIGZ0eXBhdmlm',
    '  DATA:IMAGE/PNG;BASE64,AAAA  ',
  ];

  safeUrls.forEach((url) => {
    assert.strictEqual(linkPolicy.isSafeMarkdownLink(url), true, `expected a safe Markdown URL: ${url}`);
  });

  const urlObject = new URL('https://example.test/from-url-object');
  assert.strictEqual(linkPolicy.isSafeMarkdownLink(urlObject), true, 'URL-like values must be checked after string coercion');
}

function testMarkdownLinkPolicyRejectsExecutableSchemesAndMalformedDataUrls() {
  const dangerousUrls = [
    'javascript:alert(1)',
    '  JaVaScRiPt:alert(1)  ',
    'java\u0000script:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    'vbscript:msgbox(1)',
    'vb\tscript:msgbox(1)',
    'file:///etc/passwd',
    'f\ri\nle:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'da\nta:text/html,<script>alert(1)</script>',
    'data:application/xhtml+xml,<svg onload=alert(1)>',
    'data:text/javascript,alert(1)',
    'data:application/json,{"html":"<script>"}',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=',
    'data:image/png;base64,',
    'data:image/png;base64,AA AA',
    'data:image/png;base64,AAAA!',
    'data:image/png;charset=utf-8;base64,AAAA',
    'data:image/bmp;base64,AAAA',
  ];

  dangerousUrls.forEach((url) => {
    assert.strictEqual(linkPolicy.isSafeMarkdownLink(url), false, `expected an unsafe Markdown URL: ${JSON.stringify(url)}`);
  });

  const coercedDangerousUrl = Object.freeze({ toString: () => ' javascript:alert(1)' });
  assert.strictEqual(linkPolicy.isSafeMarkdownLink(coercedDangerousUrl), false, 'coercion must not bypass scheme validation');
}

function testMathRendererUsesKatexWithLockedDownRuntimeOptions() {
  const calls = [];
  const katex = {
    renderToString(source, options) {
      calls.push({ source, options });
      return '<span class="katex">rendered</span>';
    },
  };
  const raw = Object.freeze({ toString: () => 'x < y' });

  assert.strictEqual(mathRenderer.renderMath(raw, 1, katex), '<span class="katex">rendered</span>');
  assert.deepStrictEqual(calls, [{
    source: 'x < y',
    options: {
      displayMode: true,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'htmlAndMathml',
    },
  }]);
}

function testMathRendererEscapesInlineAndDisplayFallbacks() {
  assert.strictEqual(mathRenderer.escapeHtml('&<>"\'`'), '&amp;&lt;&gt;&quot;&#39;&#96;');

  const inline = mathRenderer.renderMath('<img src=x onerror="boom">&`', false, {});
  assert.match(inline, /^<span class="math-fallback" title="[^"]*">/);
  assert.ok(inline.endsWith('$&lt;img src=x onerror=&quot;boom&quot;&gt;&amp;&#96;$</span>'));
  assert.strictEqual(inline.includes('<img'), false, 'fallback math must never inject the raw source as HTML');

  const renderError = new Error('invalid TeX');
  const display = mathRenderer.renderMath('a & b', true, {
    renderToString() {
      throw renderError;
    },
  });
  assert.match(display, /^<div class="math-fallback" title="[^"]*">/);
  assert.ok(display.endsWith('$$a &amp; b$$</div>'));
  assert.strictEqual(display.includes(renderError.message), false, 'fallback output must not expose renderer errors');
}

function testKatexOptionsPreserveCallerDataButCannotRelaxSecurity() {
  const macros = Object.freeze({ '\\RR': '\\mathbb{R}' });
  const callerKatexOptions = Object.freeze({
    macros,
    fleqn: true,
    trust: true,
    throwOnError: true,
    strict: 'error',
    output: 'html',
  });
  const callerOptions = Object.freeze({ katexOptions: callerKatexOptions });
  const before = { ...callerKatexOptions };

  const options = mathRenderer.createKatexOptions(callerOptions);

  assert.notStrictEqual(options, callerKatexOptions, 'the returned options must not alias the caller container');
  assert.strictEqual(options.macros, macros);
  assert.strictEqual(options.fleqn, true);
  assert.strictEqual(options.trust, false);
  assert.strictEqual(options.throwOnError, false);
  assert.strictEqual(options.strict, false);
  assert.strictEqual(options.output, 'htmlAndMathml');
  assert.deepStrictEqual(callerKatexOptions, before, 'normalization must not mutate caller-owned options');
}

function testMathPluginInstallsResolvedPluginWithSecureOptions() {
  const loads = [];
  const uses = [];
  function texmathPlugin() {}
  const katex = Object.freeze({ renderToString() {} });
  const macros = Object.freeze({ '\\N': '\\mathbb{N}' });
  const callerKatexOptions = Object.freeze({ macros, trust: true, output: 'html' });
  const md = {
    use(plugin, options) {
      uses.push({ plugin, options });
      return this;
    },
  };

  const result = mathRenderer.applyMathPlugin(md, {
    katexOptions: callerKatexOptions,
    loadOptional(packageName, globalName) {
      loads.push([packageName, globalName]);
      if (packageName === 'markdown-it-texmath' && globalName === 'markdownItTexmath') return null;
      if (packageName === 'markdown-it-texmath' && globalName === 'texmath') return { full: texmathPlugin };
      if (packageName === 'katex') return katex;
      return null;
    },
  });

  assert.strictEqual(result, true);
  assert.deepStrictEqual(loads, [
    ['markdown-it-texmath', 'markdownItTexmath'],
    ['markdown-it-texmath', 'texmath'],
    ['katex', 'katex'],
  ]);
  assert.strictEqual(uses.length, 1);
  assert.strictEqual(uses[0].plugin, texmathPlugin);
  assert.strictEqual(uses[0].options.engine, katex);
  assert.deepStrictEqual(uses[0].options.delimiters, ['dollars', 'brackets', 'beg_end']);
  assert.strictEqual(uses[0].options.katexOptions.macros, macros);
  assert.strictEqual(uses[0].options.katexOptions.trust, false);
  assert.strictEqual(uses[0].options.katexOptions.output, 'htmlAndMathml');
  assert.strictEqual(callerKatexOptions.trust, true, 'plugin setup must not rewrite caller-owned options');
}

function testMathPluginDegradesForMissingOrThrowingOptionalDependencies() {
  let unexpectedUse = false;
  assert.strictEqual(mathRenderer.applyMathPlugin({ use() { unexpectedUse = true; } }, { loadOptional: () => null }), false);
  assert.strictEqual(unexpectedUse, false, 'a missing plugin must not attempt Markdown registration');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const probeFailure = new Error('optional dependency probe failed');
    assert.strictEqual(mathRenderer.applyMathPlugin({ use() {} }, {
      loadOptional() {
        throw probeFailure;
      },
    }), false);

    const registrationFailure = new Error('plugin registration failed');
    assert.strictEqual(mathRenderer.applyMathPlugin({
      use() {
        throw registrationFailure;
      },
    }, {
      loadOptional: packageName => packageName === 'markdown-it-texmath' ? (() => {}) : {},
    }), false);

    assert.deepStrictEqual(warnings.map(args => args[0]), [
      '[markdown] math plugin failed: markdown-it-texmath',
      '[markdown] math plugin failed: markdown-it-texmath',
    ]);
    assert.strictEqual(warnings[0][1], probeFailure);
    assert.strictEqual(warnings[1][1], registrationFailure);
  } finally {
    console.warn = originalWarn;
  }
}

function testMermaidPrimitiveHelpersProduceStableIdsAndEscapedLabels() {
  assert.strictEqual(Object.isFrozen(mermaidNormalizer), true, 'the browser-facing Mermaid facade must be immutable');
  assert.strictEqual(mermaidNormalizer.mermaidSafeId('Cr\u00e8me Br\u00fbl\u00e9e'), 'creme_brulee');
  assert.strictEqual(mermaidNormalizer.mermaidSafeId('Hello_world 42'), 'hello_world_42');
  assert.strictEqual(mermaidNormalizer.mermaidSafeId('42 \u4e2d\u6587', 'node7'), 'node7');
  assert.strictEqual(mermaidNormalizer.mermaidSafeId('---', 'axis1'), 'axis1');
  assert.strictEqual(mermaidNormalizer.mermaidQuoteLabel('  Path\\to "core"  '), 'Path\\\\to \\"core\\"');
}

function testArchitectureBetaNormalizationQuotesOnlyUnquotedNonAsciiLabels() {
  const source = [
    '  architecture-beta',
    'service api[\u63a5\u53e3 \u670d\u52a1]',
    'service quoted["\u5df2\u5f15\u7528"]',
    "service single['\u5355\u5f15\u53f7']",
    'service cache[Cache]',
  ].join('\r\n');
  const original = source.slice();

  assert.strictEqual(mermaidNormalizer.normalizeArchitectureMermaidSource(source), [
    '  architecture-beta',
    'service api["\u63a5\u53e3 \u670d\u52a1"]',
    'service quoted["\u5df2\u5f15\u7528"]',
    "service single['\u5355\u5f15\u53f7']",
    'service cache[Cache]',
  ].join('\r\n'));
  assert.strictEqual(source, original, 'architecture normalization must not alter the caller source');
}

function testSankeyBetaNormalizationUsesStableIdsWithoutMutatingSource() {
  const source = [
    '  sankey-beta',
    '  \u7528\u6237 , \u8ba2\u5355 ,10 ',
    '\u7528\u6237,\u652f\u4ed8,5',
    'Guest,\u8ba2\u5355,2',
    '  note',
  ].join('\r\n');
  const sourceBox = Object.freeze(new String(source));

  assert.deepStrictEqual(mermaidNormalizer.getSankeyLabelReplacements(sourceBox), [
    { id: 'sankey_node_1', label: '\u7528\u6237' },
    { id: 'sankey_node_2', label: '\u8ba2\u5355' },
    { id: 'sankey_node_3', label: '\u652f\u4ed8' },
  ]);
  assert.strictEqual(mermaidNormalizer.normalizeSankeyMermaidSource(sourceBox), [
    'sankey-beta',
    'sankey_node_1,sankey_node_2,10',
    'sankey_node_1,sankey_node_3,5',
    'Guest,sankey_node_2,2',
    'note',
  ].join('\n'));
  assert.strictEqual(sourceBox.valueOf(), source, 'Sankey normalization must not rewrite a caller-owned source wrapper');
}

function testSankeySvgRestorationReplacesGeneratedIdsInTextNodes() {
  const source = [
    'sankey-beta',
    '\u7528\u6237,\u8ba2\u5355,10',
    '\u7528\u6237,\u652f\u4ed8,5',
  ].join('\n');
  const nodes = [
    { textContent: 'sankey_node_1 \u2192 sankey_node_2' },
    { textContent: 'total: sankey_node_3' },
    { textContent: 'ASCII label' },
  ];
  const container = {
    querySelectorAll(selector) {
      assert.strictEqual(selector, 'text');
      return nodes;
    },
  };

  mermaidNormalizer.restoreSankeySvgLabels(container, source);

  assert.deepStrictEqual(nodes.map(node => node.textContent), [
    '\u7528\u6237 \u2192 \u8ba2\u5355',
    'total: \u652f\u4ed8',
    'ASCII label',
  ]);
  assert.strictEqual(source.includes('sankey_node_'), false, 'SVG restoration must not rewrite the original diagram source');
  assert.doesNotThrow(() => mermaidNormalizer.restoreSankeySvgLabels({}, source));
  assert.doesNotThrow(() => mermaidNormalizer.restoreSankeySvgLabels(container, 'flowchart TD'));
}

function testRadarBetaNormalizationExpandsPlainAxesAndCurves() {
  const source = [
    ' radar-beta ',
    ' axis \u901f\u5ea6, \u7a33\u5b9a\u6027, UX ',
    ' \u4ea7\u54c1 A: 1, 2, -3.5 ',
    ' "\u4ea7\u54c1 B": +3, 2, 1 ',
    ' axis latency["Latency"], qps["QPS"] ',
    ' showLegend true ',
  ].join('\r\n');

  const expected = [
    'radar-beta',
    'axis axis1["\u901f\u5ea6"], axis2["\u7a33\u5b9a\u6027"], ux["UX"]',
    'curve a["\u4ea7\u54c1 A"]{1, 2, -3.5}',
    'curve b["\u4ea7\u54c1 B"]{+3, 2, 1}',
    'axis latency["Latency"], qps["QPS"]',
    'showLegend true',
  ].join('\n');

  assert.strictEqual(mermaidNormalizer.normalizeRadarMermaidSource(source), expected);
  assert.strictEqual(mermaidNormalizer.normalizeBetaMermaidSource(source), expected, 'the beta dispatcher must apply radar normalization');
}

function testMermaidNormalizersLeaveNonBetaDiagramsUnchanged() {
  const source = '  flowchart TD\r\n    A[\u7528\u6237] --> B[\u8ba2\u5355]\r\n';

  assert.strictEqual(mermaidNormalizer.normalizeArchitectureMermaidSource(source), source);
  assert.strictEqual(mermaidNormalizer.normalizeSankeyMermaidSource(source), source);
  assert.strictEqual(mermaidNormalizer.normalizeRadarMermaidSource(source), source);
  assert.strictEqual(mermaidNormalizer.normalizeBetaMermaidSource(source), source);
  assert.deepStrictEqual(mermaidNormalizer.getSankeyLabelReplacements(source), []);
  assert.strictEqual(mermaidNormalizer.normalizeBetaMermaidSource(null), '');
}

module.exports = [
  testMarkdownLinkPolicyAcceptsOrdinaryAndStrictRasterUrls,
  testMarkdownLinkPolicyRejectsExecutableSchemesAndMalformedDataUrls,
  testMathRendererUsesKatexWithLockedDownRuntimeOptions,
  testMathRendererEscapesInlineAndDisplayFallbacks,
  testKatexOptionsPreserveCallerDataButCannotRelaxSecurity,
  testMathPluginInstallsResolvedPluginWithSecureOptions,
  testMathPluginDegradesForMissingOrThrowingOptionalDependencies,
  testMermaidPrimitiveHelpersProduceStableIdsAndEscapedLabels,
  testArchitectureBetaNormalizationQuotesOnlyUnquotedNonAsciiLabels,
  testSankeyBetaNormalizationUsesStableIdsWithoutMutatingSource,
  testSankeySvgRestorationReplacesGeneratedIdsInTextNodes,
  testRadarBetaNormalizationExpandsPlainAxesAndCurves,
  testMermaidNormalizersLeaveNonBetaDiagramsUnchanged,
];
