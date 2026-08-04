'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const linkPolicy = require('../../client/app/markdown/link-policy');
const sanitizer = require('../../client/app/markdown/sanitizer');

const MODULE_REGISTRY_SOURCE = fs.readFileSync(path.join(__dirname, '../../client/runtime/module-registry.js'), 'utf8');
const BROWSER_SANITIZER_SOURCE = fs.readFileSync(path.join(__dirname, '../../client/app/markdown/browser-sanitizer.js'), 'utf8');
const SANITIZER_POLICY_SOURCE = fs.readFileSync(path.join(__dirname, '../../client/app/markdown/sanitizer-policy.js'), 'utf8');

function loadBrowserSanitizer() {
  const window = {
    DOMPurify: createDOMPurify(new JSDOM('').window),
    ChatUIMarkdownLinkPolicy: linkPolicy,
  };
  const context = { window };
  vm.runInNewContext(MODULE_REGISTRY_SOURCE, context, { filename: 'client/runtime/module-registry.js' });
  vm.runInNewContext(SANITIZER_POLICY_SOURCE, context, { filename: 'client/app/markdown/sanitizer-policy.js' });
  vm.runInNewContext(BROWSER_SANITIZER_SOURCE, context, { filename: 'client/app/markdown/browser-sanitizer.js' });
  return window.ChatUIMarkdownSanitizer;
}

function fragment(html) {
  return JSDOM.fragment(String(html || ''));
}

function assertExecutableMarkupRemoved(output) {
  const root = fragment(output);
  assert.strictEqual(root.querySelector('script,iframe,form,input,button,textarea,select,option,object,embed'), null);
  assert.strictEqual(root.querySelector('[onerror],[onclick],[onload]'), null);
  assert.ok(!/javascript\s*:|vbscript\s*:|data\s*:\s*(?:text\/html|application\/xhtml\+xml)/i.test(output));
}

function testMarkdownSanitizerRemovesExecutableMarkupEventsAndClobberingNames() {
  const output = sanitizer.sanitizeHtml(`
    <script>alert(1)</script>
    <iframe src="https://attacker.invalid"></iframe>
    <form id="attributes"><input name="action"><button formaction="javascript:alert(2)">go</button></form>
    <img src="missing.png" onerror="alert(3)">
    <a id="__proto__" name="constructor" onclick="alert(4)" href="javascript:alert(5)">unsafe</a>
    <svg><a xlink:href="javascript:alert(6)">svg</a><script>alert(7)</script></svg>
    <math><mtext><img src="x" onerror="alert(8)"></mtext></math>
  `);
  assertExecutableMarkupRemoved(output);
  const root = fragment(output);
  const clobber = root.querySelector('a');
  assert.ok(clobber);
  assert.strictEqual(clobber.hasAttribute('id'), false);
  assert.strictEqual(clobber.hasAttribute('name'), false);
  assert.strictEqual(clobber.hasAttribute('href'), false);
}

function testMarkdownSanitizerEnforcesUriPolicyIncludingDataImages() {
  const output = sanitizer.sanitizeHtml(`
    <a id="https" href="https://example.test/path">https</a>
    <a id="relative" href="../guide#part">relative</a>
    <a id="newline" href="java&#10;script:alert(1)">newline</a>
    <a id="vb" href="vbscript:msgbox(1)">vb</a>
    <a id="file" href="file:///etc/passwd">file</a>
    <a id="xhtml" href="data:application/xhtml+xml;base64,PHNjcmlwdD4=">xhtml</a>
    <img id="png" src="data:image/png;base64,QUJDRA==">
    <img id="avif" src="data:image/avif;base64,QUJDRA==">
    <img id="svg" src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">
    <img id="html" src="data:text/html;base64,PHNjcmlwdD4=">
  `);
  const root = fragment(output);
  assert.strictEqual(root.querySelector('#https').getAttribute('href'), 'https://example.test/path');
  assert.strictEqual(root.querySelector('#relative').getAttribute('href'), '../guide#part');
  for (const id of ['newline', 'vb', 'file', 'xhtml']) {
    assert.strictEqual(root.querySelector(`#${id}`).hasAttribute('href'), false, `${id} must not retain an executable URI`);
  }
  assert.strictEqual(root.querySelector('#png').hasAttribute('src'), true);
  assert.strictEqual(root.querySelector('#avif').hasAttribute('src'), true);
  assert.strictEqual(root.querySelector('#svg').hasAttribute('src'), false);
  assert.strictEqual(root.querySelector('#html').hasAttribute('src'), false);
}

function testMarkdownSanitizerKeepsSafeMathLayoutAndDropsUnsafeStyles() {
  const output = sanitizer.sanitizeHtml(`
    <details open><summary>公式</summary>
      <table><tbody><tr><td style="text-align: right; vertical-align: -0.2em; height: 2em; color: #123; position: fixed; background-image: url(javascript:alert(1)); width: expression(alert(2)); --payload: bad">
        <math><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></math>
      </td></tr></tbody></table>
    </details>
  `);
  const root = fragment(output);
  assert.ok(root.querySelector('details[open] summary'));
  assert.strictEqual(root.querySelector('math mrow mi').textContent, 'x');
  const style = root.querySelector('td').getAttribute('style');
  assert.match(style, /text-align: right/);
  assert.match(style, /vertical-align: -0\.2em/);
  assert.match(style, /height: 2em/);
  assert.match(style, /color: #123/);
  assert.doesNotMatch(style, /position|background-image|url\s*\(|expression|--payload/i);
}

function testBrowserAndCommonJsSanitizersApplyTheSameSecurityBoundary() {
  const browserSanitizer = loadBrowserSanitizer();
  const attack = `
    <form><input name="token"></form>
    <a href="java&#9;script:alert(1)" onclick="alert(2)">bad</a>
    <img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" onerror="alert(3)">
    <div style="border: 1px solid red; background-image: url(https://attacker.invalid/pixel)">safe text</div>
  `;
  const commonOutput = sanitizer.sanitizeHtml(attack);
  const browserOutput = browserSanitizer.sanitizeHtml(attack);
  assertExecutableMarkupRemoved(commonOutput);
  assertExecutableMarkupRemoved(browserOutput);
  for (const output of [commonOutput, browserOutput]) {
    const root = fragment(output);
    assert.strictEqual(root.querySelector('a').hasAttribute('href'), false);
    assert.strictEqual(root.querySelector('img').hasAttribute('src'), false);
    assert.match(root.querySelector('div').getAttribute('style'), /border: 1px solid red/);
    assert.doesNotMatch(root.querySelector('div').getAttribute('style'), /background-image|url\s*\(/i);
  }
}

module.exports = [
  testMarkdownSanitizerRemovesExecutableMarkupEventsAndClobberingNames,
  testMarkdownSanitizerEnforcesUriPolicyIncludingDataImages,
  testMarkdownSanitizerKeepsSafeMathLayoutAndDropsUnsafeStyles,
  testBrowserAndCommonJsSanitizersApplyTheSameSecurityBoundary,
];
