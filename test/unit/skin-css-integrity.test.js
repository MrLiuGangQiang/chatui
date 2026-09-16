'use strict';

// Design 29 recurrence gate for the stylesheet layer itself.
//
// Why this exists: a CJK byte sequence written back through the wrong code page
// can turn a comment terminator into mojibake, leaving an unterminated /*
// comment. The browser then silently drops every declaration that follows, while
// a plain substring search still reports the text as "present". These tests read
// CSS the way a parser does and require byte-exact UTF-8.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

const SKIN_STYLESHEETS = [
  'styles/skins/default/skin.css',
  'styles/surfaces/session-sidebar.css',
  'styles/skins/ink/skin.css',
  'styles/skins/snow/skin.css',
];

const SIDEBAR_CONTROL_POINTS = [
  '--sidebar-fill',
  '--sidebar-veil',
  '--sidebar-border',
  '--sidebar-blur',
  '--sidebar-saturate',
];

// Stage 1 is a pure relocation: the sidebar material moved out of the default
// skin file into the surfaces domain and became control points. These are the
// exact values the browser resolved before the move, so any drift here is a
// visible change to the default skin (a loose bound would let .20 become .90).
const PRE_MIGRATION_SIDEBAR_VALUES = {
  '--sidebar-fill': 'rgba(255, 255, 255, .20)',
  '--sidebar-veil': 'linear-gradient(180deg, rgba(240, 244, 248, .30), rgba(228, 235, 242, .24))',
  '--sidebar-border': 'rgba(214, 224, 235, .55)',
  '--sidebar-blur': '12px',
  '--sidebar-saturate': '1.04',
};

function readBuffer(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath));
}

function liveCssText(source) {
  return String(source).replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function squeeze(value) {
  return String(value).trim().replace(/\s+/g, ' ');
}

function testSkinStylesheetsAreByteExactUtf8() {
  for (const rel of SKIN_STYLESHEETS) {
    const buffer = readBuffer(rel);
    const text = buffer.toString('utf8');
    assert.ok(!text.includes('\uFFFD'), `${rel} must decode as UTF-8 with no replacement character`);
    assert.strictEqual(Buffer.from(text, 'utf8').compare(buffer), 0, `${rel} must be byte-exact UTF-8`);
    assert.strictEqual(
      (text.match(/\/\*/g) || []).length,
      (text.match(/\*\//g) || []).length,
      `${rel} must keep CSS comment markers balanced so no rule is swallowed by an open comment`
    );
  }
}

function testSidebarControlPointsAreLiveCss() {
  const live = liveCssText(readBuffer('styles/skins/default/skin.css').toString('utf8'));
  assert.ok(live.includes('--skin-radius'), 'comment stripping must not swallow the token block');
  for (const token of SIDEBAR_CONTROL_POINTS) {
    assert.ok(live.includes(token + ':'), `the default skin must declare ${token} as live CSS, not inside a comment`);
  }
  // The legacy alias layer feeds untouched stylesheets; losing it restyles the app.
  for (const alias of ['--bg: var(--skin-canvas)', '--chatui-surface:', '--ds-page: var(--skin-canvas)']) {
    assert.ok(live.includes(alias), `the default skin must keep ${alias} live`);
  }
}

function testSidebarDomainRuleIsLiveCss() {
  const live = liveCssText(readBuffer('styles/surfaces/session-sidebar.css').toString('utf8'));
  assert.ok(live.includes('.session-sidebar'), 'the sidebar domain rule must be live CSS');
  for (const token of SIDEBAR_CONTROL_POINTS) {
    assert.ok(live.includes(`var(${token})`), `the domain must consume ${token}`);
  }
}

function testSidebarControlPointsPinThePreMigrationValues() {
  const live = liveCssText(readBuffer('styles/skins/default/skin.css').toString('utf8'));
  for (const [token, value] of Object.entries(PRE_MIGRATION_SIDEBAR_VALUES)) {
    const declared = live.match(new RegExp(token + '\\s*:\\s*([^;]+);'));
    assert.ok(declared, `${token} must be declared`);
    assert.strictEqual(
      squeeze(declared[1]),
      squeeze(value),
      `${token} must keep the value the default skin resolved before the surfaces split`
    );
  }
}

function testDefaultSkinUsesEverySidebarControlPointOnce() {
  const live = liveCssText(readBuffer('styles/skins/default/skin.css').toString('utf8'));
  for (const token of SIDEBAR_CONTROL_POINTS) {
    const declared = (live.match(new RegExp(token + '\\s*:', 'g')) || []).length;
    assert.strictEqual(declared, 1, `${token} must have exactly one authoritative default value`);
  }
}

module.exports = [
  testSkinStylesheetsAreByteExactUtf8,
  testSidebarControlPointsAreLiveCss,
  testSidebarDomainRuleIsLiveCss,
  testSidebarControlPointsPinThePreMigrationValues,
  testDefaultSkinUsesEverySidebarControlPointOnce,
];