'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skinCore = require('../../client/core/skin');

const ROOT = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n?/g, '\n');
}

function blockFor(css, selectorFragment) {
  const at = css.indexOf(selectorFragment);
  if (at < 0) return '';
  const open = css.lastIndexOf('{', at);
  const close = css.indexOf('}', at);
  return open >= 0 && close > open ? css.slice(open + 1, close) : '';
}

function testEverySkinDefersSessionActionVisibilityToTitleHover() {
  const base = read('styles/flat-theme.css');
  const hidden = blockFor(base, '.session-tab .session-delete-btn,');
  assert.ok(/opacity:\s*0\s*!important/.test(hidden), 'session rename/delete actions must start hidden');

  for (const selector of [
    '.session-tab .session-title:hover ~ .session-rename-btn',
    '.session-tab .session-title:hover ~ .session-delete-btn',
  ]) {
    assert.ok(base.includes(selector), `session actions must be revealed by ${selector}`);
  }
  const revealed = blockFor(base, '.session-tab .session-title:hover ~ .session-rename-btn,');
  assert.ok(/opacity:\s*1\s*!important/.test(revealed), 'title hover must reveal the session actions');
  const titleRule = blockFor(base, '.session-tab .session-title');
  assert.ok(/display:\s*block/.test(titleRule), 'the title must keep a real hover hit area');
  assert.ok(/align-self:\s*stretch/.test(titleRule), 'the title hit box must stretch across the row height');
  assert.ok(/margin-top:\s*-9px/.test(titleRule) && /margin-bottom:\s*-9px/.test(titleRule),
    'the title hit box must bleed into the row padding so hovering the row title area always hits it');
  assert.ok(/padding-top:\s*9px/.test(titleRule) && /padding-bottom:\s*9px/.test(titleRule),
    'the title hit box must keep its text vertically centred while covering the row padding');
  assert.ok(/box-sizing:\s*content-box/.test(titleRule),
    'the title hit box must add padding on top of the stretched grid height');
  assert.ok(blockFor(base, '.session-title').includes('text-overflow: ellipsis') || base.includes('text-overflow:ellipsis'),
    'long session titles must keep the ellipsis contract');
  assert.ok(/\.session-tab:focus-within \.session-rename-btn/.test(base), 'keyboard focus must reveal the session actions');
  assert.ok(/\.session-tab\.renaming \.session-rename-btn/.test(base), 'rename mode must reveal the session actions');
  assert.ok(/@media \(hover: none\), \(pointer: coarse\)/.test(base), 'touch devices need a non-hover fallback');
  assert.ok(!/\.session-tab:hover \.session-(?:delete|rename)-btn\s*\{[^}]*opacity:\s*1/is.test(base),
    'hovering the whole session row must not reveal the actions');

  for (const skin of skinCore.SKINS) {
    const css = read(`styles/skins/${skin.id}/skin.css`);
    assert.ok(!/\.session-(?:delete|rename)-btn[^}]*opacity:\s*1/is.test(css),
      `${skin.id} must not re-enable session actions outside the shared title-hover contract`);
  }
}

module.exports = [
  testEverySkinDefersSessionActionVisibilityToTitleHover,
];
