'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const INK_CSS = path.join(ROOT, 'styles/skins/ink/skin.css');

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

function testInkTypographyUsesClassicalReadableStacks() {
  const css = read(INK_CSS);
  const firstTokenRule = ruleBody(css, ':root[data-skin="ink"] {');
  assert.ok(/--ink-font-body:\s*Georgia/.test(firstTokenRule.body),
    'ink body stack must start with a clear classical Latin serif');
  assert.ok(/--ink-font-body:\s*[^;]*"Noto Serif SC"/.test(firstTokenRule.body),
    'ink body stack must prefer Noto Serif SC for crisp Chinese text');
  assert.ok(firstTokenRule.body.indexOf('"Noto Serif SC"') < firstTokenRule.body.indexOf('"SimSun"'),
    'Noto Serif SC must be preferred before SimSun for legibility');
  assert.ok(/--ink-font-display:\s*Georgia/.test(firstTokenRule.body),
    'ink display stack must keep a classical Latin serif');
  assert.ok(/--ink-font-display:\s*[^;]*"STKaiti"/.test(firstTokenRule.body),
    'ink display stack must prefer a classical Kai face');
  assert.ok(/--ink-font-mono:/.test(firstTokenRule.body), 'ink must keep a dedicated code face');

  const bodyRule = lastRuleBody(css, 'html[data-skin="ink"] body,');
  assert.ok(/font-family:\s*var\(--ink-font-body\)\s*!important/.test(bodyRule.body),
    'ink body must use the classical readable body stack');

  const displayRule = lastRuleBody(css, 'html[data-skin="ink"] h1,');
  assert.ok(/font-family:\s*var\(--ink-font-display\)\s*!important/.test(displayRule.body),
    'ink headings must use the Kai display stack');

  const messageRule = lastRuleBody(css, 'html[data-skin="ink"] .message.user .plain-text,');
  assert.ok(/font-family:\s*var\(--ink-font-body\)\s*!important/.test(messageRule.body),
    'ink message copy must use the readable body stack');
  assert.ok(/font-weight:\s*500\s*!important/.test(messageRule.body),
    'ink message copy must use a medium weight for clear small-size strokes');
  assert.ok(/line-height:\s*1\.62\s*!important/.test(messageRule.body),
    'ink message copy needs a readable line rhythm');
  assert.ok(/letter-spacing:\s*\.012em\s*!important/.test(messageRule.body),
    'ink message copy needs a little tracking for clarity');

  const smallLabelRule = lastRuleBody(css, 'html[data-skin="ink"] .message-meta,');
  assert.ok(/font-weight:\s*600\s*!important/.test(smallLabelRule.body),
    'ink small labels need extra weight for legibility');
  assert.ok(/letter-spacing:\s*\.03em\s*!important/.test(smallLabelRule.body),
    'ink small labels need extra tracking for legibility');

  const featureRule = lastRuleBody(css, 'html[data-skin="ink"] .announcement-dialog,');
  assert.ok(/font-family:\s*var\(--ink-font-body\)\s*!important/.test(featureRule.body),
    'ink feature dialogs must inherit the classical body stack too');

  const codeRule = lastRuleBody(css, 'html[data-skin="ink"] code,');
  assert.ok(/font-family:\s*var\(--ink-font-mono\)\s*!important/.test(codeRule.body),
    'ink code must stay monospace');

  assert.ok(!/@import/.test(css), 'ink skin must not add a remote font import');
  assert.ok(css.includes('html[data-skin="ink"]'), 'ink typography must remain skin-scoped');
}

function testInkTypographyDeepensSmallTextContrast() {
  const css = read(INK_CSS);
  const contrastMarker = css.indexOf('Ink typography and contrast.');
  assert.ok(contrastMarker >= 0, 'ink typography contrast section must exist');
  const finalTokenRule = ruleBody(css, ':root[data-skin="ink"] {', contrastMarker);
  for (const expected of ['--skin-text: #171b1a;', '--skin-muted: #4f5a54;', '--skin-muted-strong: #39423d;']) {
    assert.ok(finalTokenRule.body.includes(expected), `ink contrast token missing: ${expected}`);
  }
}

module.exports = [
  testInkTypographyUsesClassicalReadableStacks,
  testInkTypographyDeepensSmallTextContrast,
];
