'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SNOW_CSS = path.join(ROOT, 'styles/skins/snow/skin.css');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function lastRuleBody(css, selector) {
  const at = css.lastIndexOf(selector);
  assert.ok(at >= 0, `missing rule ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  assert.ok(open >= 0 && close > open, `malformed rule ${selector}`);
  return { body: css.slice(open + 1, close), at, close };
}

function ruleBody(css, selector, from = 0) {
  const at = css.indexOf(selector, from);
  assert.ok(at >= 0, `missing rule ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  assert.ok(open >= 0 && close > open, `malformed rule ${selector}`);
  return { body: css.slice(open + 1, close), at, close };
}

function testSnowTypographyUsesReadableBodyAndPlayfulDisplayStacks() {
  const css = read(SNOW_CSS);
  const tokenRule = ruleBody(css, ':root[data-skin="snow"] {');
  assert.ok(/--snow-font-body:\s*[^;]*"Segoe UI Variable Text"/.test(tokenRule.body),
    'snow body stack must start from a clear UI face');
  assert.ok(/--snow-font-body:\s*[^;]*"Nunito"/.test(tokenRule.body),
    'snow body stack must offer a rounded playful fallback');
  assert.ok(/--snow-font-display:\s*[^;]*"Trebuchet MS"/.test(tokenRule.body),
    'snow display stack must keep a friendly rounded face for short labels');
  assert.ok(/--snow-font-display:\s*[^;]*"YouYuan"/.test(tokenRule.body),
    'snow display stack must offer a playful CJK fallback');
  const bodyStack = tokenRule.body.match(/--snow-font-body:\s*([^;]+);/)?.[1] || '';
  assert.ok(!bodyStack.includes('"YouYuan"'), 'long-form copy must stay on the calm UI stack');
  const displayStack = tokenRule.body.match(/--snow-font-display:\s*([^;]+);/)?.[1] || '';
  assert.ok(displayStack.indexOf('"YouYuan"') < displayStack.indexOf('"HarmonyOS Sans SC"'),
    'the playful CJK display face must be preferred when available');

  assert.ok(/--snow-font-mono:/.test(tokenRule.body), 'snow must keep a dedicated code face');
  assert.ok(/--snow-text-halo:\s*0 1px 2px/.test(tokenRule.body),
    'snow text halo must start tight so dark ink stays crisp on the photograph');

  const bodyRule = lastRuleBody(css, 'html[data-skin="snow"] body {');
  assert.ok(/font-family:\s*var\(--snow-font-body\)\s*!important/.test(bodyRule.body),
    'snow body must use the readable body stack');

  const displayRule = lastRuleBody(css, 'html[data-skin="snow"] h1,');
  assert.ok(/font-family:\s*var\(--snow-font-display\)\s*!important/.test(displayRule.body),
    'snow headings and short labels must use the playful display stack');

  const messageRule = lastRuleBody(css, 'html[data-skin="snow"] .message .content,');
  assert.ok(/line-height:\s*1\.62\s*!important/.test(messageRule.body),
    'snow message copy needs a readable line rhythm');
  assert.ok(/letter-spacing:\s*\.012em\s*!important/.test(messageRule.body),
    'snow message copy needs a little tracking for clarity');
  assert.ok(/text-shadow:\s*var\(--snow-text-halo\)\s*!important/.test(messageRule.body),
    'snow message copy must use the crisp halo');

  const codeRule = lastRuleBody(css, 'html[data-skin="snow"] code,');
  assert.ok(/font-family:\s*var\(--snow-font-mono\)\s*!important/.test(codeRule.body),
    'snow code must stay monospace');

  assert.ok(!/@import/.test(css), 'snow skin must not add a remote font import');
  assert.ok(css.includes('html[data-skin="snow"]'), 'snow typography must remain skin-scoped');
}

function testSnowTypographyDarkensTextTokensForContrast() {
  const css = read(SNOW_CSS);
  const tokenRule = ruleBody(css, ':root[data-skin="snow"] {');
  for (const expected of ['--skin-text: #172433;', '--skin-muted: #52677b;', '--skin-muted-strong: #43576a;']) {
    assert.ok(tokenRule.body.includes(expected), `snow contrast token missing: ${expected}`);
  }
  assert.ok(!tokenRule.body.includes('--skin-text: #1e2a36;'), 'snow ink must not stay at the old low-contrast value');
}

module.exports = [
  testSnowTypographyUsesReadableBodyAndPlayfulDisplayStacks,
  testSnowTypographyDarkensTextTokensForContrast,
];
