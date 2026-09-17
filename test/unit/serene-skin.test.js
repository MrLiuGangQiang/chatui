'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const skinCore = require('../../client/core/skin');

const ROOT = path.resolve(__dirname, '../..');
const CSS_PATH = path.join(ROOT, 'styles/skins/serene/skin.css');
const ASSET_PATH = path.join(ROOT, 'styles/skins/serene/scenery.jpg');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function ruleBody(css, selector, from = 0) {
  const at = css.indexOf(selector, from);
  assert.ok(at >= 0, `missing rule ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  assert.ok(open >= 0 && close > open, `malformed rule ${selector}`);
  return { body: css.slice(open + 1, close), at, close };
}

function lastRuleBody(css, selector) {
  const at = css.lastIndexOf(selector);
  assert.ok(at >= 0, `missing rule ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  assert.ok(open >= 0 && close > open, `malformed rule ${selector}`);
  return { body: css.slice(open + 1, close), at, close };
}

function testSereneSkinIsRegisteredAndLoadsOnDemand() {
  const skin = skinCore.SKINS.find(item => item.id === 'serene');
  assert.ok(skin, 'serene must be registered in the skin catalog');
  assert.strictEqual(skin.label, '宁静');
  assert.strictEqual(skinCore.skinStylesheetHref('serene'), '/styles/skins/serene/skin.css');
  const index = read(path.join(ROOT, 'index.html'));
  assert.match(index, /const skinIds = \[[^\]]*'serene'[^\]]*\];/,
    'the boot whitelist must include serene so first paint can apply it');
  assert.ok(fs.existsSync(CSS_PATH), 'serene must own its skin stylesheet');
  const switcher = read(path.join(ROOT, 'styles/skin-system.css'));
  assert.ok(switcher.includes('.skin-swatch-serene'), 'the switcher must provide a serene swatch');
}

function testSereneSkinKeepsLakeMorningPaletteAndReadableSurfaces() {
  const css = read(CSS_PATH);
  const tokenRule = ruleBody(css, ':root[data-skin="serene"] {');
  for (const token of [
    '--skin-canvas: #eaf2ef;',
    '--skin-surface: #fffdf8;',
    '--skin-text: #102220;',
    '--skin-accent: #3f827b;',
    '--skin-user-bubble: #f7eee0;',
    '--skin-code: #eef4f1;',
  ]) {
    assert.ok(tokenRule.body.includes(token), `serene palette missing ${token}`);
  }
  for (const controlPoint of ['--sidebar-fill:', '--sidebar-veil:', '--sidebar-border:', '--sidebar-blur:', '--sidebar-saturate:']) {
    assert.ok(tokenRule.body.includes(controlPoint), `serene must expose ${controlPoint} for the shared sidebar domain`);
  }

  const sidebar = lastRuleBody(css, 'html[data-skin="serene"] .session-sidebar,');
  const sidebarAlpha = sidebar.body.match(/background-color:\s*rgba\([^)]*,\s*(0?\.\d+)\)/);
  assert.ok(sidebarAlpha && Number(sidebarAlpha[1]) <= 0.20, 'serene sidebar must stay about 80% transparent');

  const bodyRule = lastRuleBody(css, 'html[data-skin="serene"] body {');
  assert.ok(/url\("\.\/scenery\.jpg\?v=1"\)/.test(bodyRule.body), 'serene must use its own scenery asset relative to the skin folder');
  assert.ok(/linear-gradient\(180deg/.test(bodyRule.body), 'serene must place a soft morning veil over the photograph');

  const messageBubble = lastRuleBody(css, 'html[data-skin="serene"] .message .bubble,');
  assert.ok(/background:\s*transparent\s*!important/.test(messageBubble.body), 'serene message text must not sit on a bubble background');
  assert.ok(/border-color:\s*transparent\s*!important/.test(messageBubble.body), 'serene message text must not keep a bubble border');
  assert.ok(/box-shadow:\s*none\s*!important/.test(messageBubble.body), 'serene message text must not keep a card shadow');
  const welcome = lastRuleBody(css, 'html[data-skin="serene"] .welcome-hero,');
  assert.ok(/background:\s*transparent\s*!important/.test(welcome.body), 'serene welcome text must read directly on the photograph');
  const activeButtons = lastRuleBody(css, 'html[data-skin="serene"] .session-tab.active .session-rename-btn,');
  assert.ok(!/opacity:\s*1/.test(activeButtons.body), 'serene must not override the shared title-hover visibility contract');

  const active = lastRuleBody(css, 'html[data-skin="serene"] .session-tab.active,');
  assert.ok(/background:\s*linear-gradient\(90deg/.test(active.body), 'serene active session must use a lake-green wash');
  assert.ok(!/inset\s+\d+px\s+0\s+0/.test(active.body), 'serene active session must not use a left colour bar');
  const activeTitle = lastRuleBody(css, 'html[data-skin="serene"] .session-tab.active .session-title');
  assert.ok(/font-weight:\s*700/.test(activeTitle.body), 'serene active session title must stay bold');
}

function testSereneSkinUsesQuietReadableTypography() {
  const css = read(CSS_PATH);
  const tokenRule = ruleBody(css, ':root[data-skin="serene"] {');
  assert.ok(/--serene-font-body:\s*[^;]*"Segoe UI Variable Text"/.test(tokenRule.body), 'serene body must prefer a clear UI face');
  assert.ok(/--serene-font-display:\s*[^;]*"Noto Serif SC"/.test(tokenRule.body), 'serene headings must use a soft serif display face');
  assert.ok(/--serene-font-mono:/.test(tokenRule.body), 'serene must keep a dedicated code face');
  assert.ok(/--serene-text-halo:\s*0 1px 2px/.test(tokenRule.body), 'serene body text needs a tight halo for photograph contrast');

  const messageRule = lastRuleBody(css, 'html[data-skin="serene"] .message .content,');
  assert.ok(/line-height:\s*1\.62\s*!important/.test(messageRule.body), 'serene message copy needs a readable line rhythm');
  assert.ok(/letter-spacing:\s*\.01em\s*!important/.test(messageRule.body), 'serene message copy needs gentle tracking');
  const codeRule = lastRuleBody(css, 'html[data-skin="serene"] code,');
  assert.ok(/font-family:\s*var\(--serene-font-mono\)\s*!important/.test(codeRule.body), 'serene code must stay monospace');
  assert.ok(!/@import/.test(css), 'serene must not add a remote font import');
}

function testSereneSkinShipsLocalCanvasAndStaysIsolated() {
  const buffer = fs.readFileSync(ASSET_PATH);
  const magic = buffer.subarray(0, 3).toString('hex');
  assert.ok(magic === 'ffd8ff' || magic === '89504e47', 'serene canvas must be a JPEG or PNG raster');
  assert.ok(buffer.length > 50 * 1024 && buffer.length < 1024 * 1024, 'serene canvas must stay a reasonable local asset size');

  const css = read(CSS_PATH);
  assert.ok(!css.includes('data-skin="ink"'), 'serene must not style the ink skin');
  assert.ok(!css.includes('data-skin="snow"'), 'serene must not style the snow skin');
  assert.ok(!css.includes('url("../'), 'serene assets must stay inside the skin folder');
  for (const match of css.matchAll(/html\[data-skin="([^"]+)"\]/g)) {
    assert.strictEqual(match[1], 'serene', `serene stylesheet leaked a ${match[1]} selector`);
  }
}

module.exports = [
  testSereneSkinIsRegisteredAndLoadsOnDemand,
  testSereneSkinKeepsLakeMorningPaletteAndReadableSurfaces,
  testSereneSkinUsesQuietReadableTypography,
  testSereneSkinShipsLocalCanvasAndStaysIsolated,
];
