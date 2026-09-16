'use strict';

// Design 29 stage 1 gate: skins are isolated *by loading*, not by winning an
// !important fight. The bundle ships only the default skin, the active skin is
// injected on demand, and the reviewed post-skin functional override always
// keeps the final cascade word.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const staticBundle = require('../../server/services/static-bundle.service');
const { isPublicStaticPath } = require('../../server/http/static');
const skinCore = require('../../client/core/skin');
const skinSwitcher = require('../../client/features/skin-system/skin-switcher');

const ROOT = path.join(__dirname, '../..');
const HEAD_LINKS = '<!doctype html><html><head><link rel="stylesheet" href="/assets/chatui.bundle.css" />'
  + '<link rel="stylesheet" href="/styles/message-actions-text.css" data-chatui-post-skin="1" /></head><body></body></html>';

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n?/g, '\n');
}

function cssEntries() {
  return staticBundle.parseAssetManifest(ROOT, `${ROOT}${path.sep}`, 'css');
}

function orderOf(entries, suffix) {
  return entries.findIndex(entry => entry.urlPath.endsWith(suffix));
}

function makeDocument() {
  const dom = new JSDOM(HEAD_LINKS, { url: 'http://chatui.local/' });
  return { document: dom.window.document, storage: dom.window.localStorage };
}

function testSkinStylesheetHrefIsBundledOrOnDemand() {
  assert.strictEqual(skinCore.skinStylesheetHref('default'), '', 'the default skin ships inside the bundle');
  assert.strictEqual(skinCore.skinStylesheetHref('ink'), '/styles/skins/ink/skin.css', 'ink must resolve to its own folder');
  assert.strictEqual(skinCore.skinStylesheetHref('snow'), '/styles/skins/snow/skin.css', 'snow must resolve to its own folder');
  assert.strictEqual(skinCore.skinStylesheetHref('<script>'), '', 'unknown ids fail closed and must never build a request');
  assert.strictEqual(skinCore.skinStylesheetHref('../../server.js'), '', 'path traversal in stored ids must resolve to nothing');
}

function testBootInjectsOnlyTheActiveNonDefaultSkin() {
  const index = read('index.html');
  assert.ok(index.includes("if (activeSkin !== 'default') {"), 'the boot script must skip injection for the bundled default skin');
  assert.ok(index.includes("skinStyle.href = '/styles/skins/' + activeSkin + '/skin.css'"), 'the boot script must inject the active skin sheet from the whitelist');
  assert.ok(index.includes("document.head.insertBefore(skinStyle, postSkin)"), 'the injected sheet must land before the post-skin override');
  assert.ok(index.includes("skinIds.includes(storedSkin) ? storedSkin : 'default'"), 'the boot whitelist must fail closed to default');
}

function testManifestShipsOnlyTheDefaultSkin() {
  const entries = cssEntries();
  const defaultAt = orderOf(entries, 'skins/default/skin.css');
  assert.ok(defaultAt >= 0, 'the default skin must stay in the bundle');
  for (const skin of skinCore.SKINS) {
    const id = String(skin.id);
    const bundled = entries.filter(entry => entry.urlPath.includes(`/skins/${id}/`));
    assert.strictEqual(bundled.length, id === 'default' ? 1 : 0,
      `${id} skin must ${id === 'default' ? 'ship inside the bundle' : 'load on demand instead of shipping in the bundle'}`);
  }
  assert.ok(isPublicStaticPath('/styles/skins/ink/skin.css'), 'on-demand skin sheets must stay publicly servable');
}

function testInactiveSkinsNeverReachTheDocumentStyles() {
  const entries = cssEntries();
  const bundle = staticBundle.buildBundleBody(entries, 'css').toString('utf8');
  for (const skin of skinCore.SKINS) {
    const id = String(skin.id);
    if (id === 'default') continue;
    assert.ok(!bundle.includes(`data-skin="${id}"`), `the bundle must not carry ${id} rules while ${id} is inactive`);
    assert.ok(!bundle.includes(`/styles/skins/${id}/`), `the bundle must not reference ${id} assets while ${id} is inactive`);
  }
  assert.ok(bundle.includes('url("/styles/skins/default/scenery.jpg?v=1")'), 'the bundled default canvas must keep its rewritten public url');
}

function testPostSkinOverrideLoadsAfterEverySkin() {
  const entries = cssEntries();
  assert.strictEqual(entries.filter(entry => entry.urlPath.includes('message-actions-text')).length, 0,
    'the reviewed post-skin override must be a static head link, not a bundle entry');
  const index = read('index.html');
  const headEnd = index.indexOf('</head>');
  const bootEnd = index.lastIndexOf('</script>', headEnd);
  const overrideAt = index.indexOf('data-chatui-post-skin="1"'); // the attribute, not the boot selector string
  assert.ok(bootEnd > 0 && bootEnd < overrideAt && overrideAt < headEnd,
    'the override link must be parsed after the boot script, so no injected skin can outrank it');
}

// Design 29 stage 1 leaves the shared sidebar material scoped to the default
// skin until every skin expresses the domain through control points. That scope
// is transitional debt: the baseline may only shrink, never gain a new file.
const TRANSITIONAL_SCOPED_DOMAINS_BASELINE = ['styles/surfaces/session-sidebar.css'];

function testTransitionalDefaultScopeInsideSurfacesShrinksOnly() {
  const dir = path.join(ROOT, 'styles/surfaces');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(name => name.endsWith('.css')).sort()
    : [];
  const scoped = files
    .filter(name => fs.readFileSync(path.join(dir, name), 'utf8').includes('data-skin="default"'))
    .map(name => `styles/surfaces/${name}`)
    .sort();
  assert.ok(
    scoped.length <= TRANSITIONAL_SCOPED_DOMAINS_BASELINE.length,
    `the transitional default-skin scope must shrink as skins adopt control points: ${scoped.join(', ')}`
  );
  for (const file of scoped) {
    assert.ok(
      TRANSITIONAL_SCOPED_DOMAINS_BASELINE.includes(file),
      `${file} adds a new transitional default scope; express the domain through skin control points instead`,
    );
  }
}
function testSurfacesDomainOwnsSidebarAndDefaultSkinOwnsItsTokens() {
  const surfaces = read('styles/surfaces/session-sidebar.css');
  assert.ok(surfaces.includes('.session-sidebar'), 'the sidebar domain must own the sidebar surface');
  for (const token of ['--sidebar-fill', '--sidebar-veil', '--sidebar-border', '--sidebar-blur', '--sidebar-saturate']) {
    assert.ok(surfaces.includes(`var(${token})`), `the sidebar domain must consume ${token}`);
  }
  const defaults = read('styles/skins/default/skin.css');
  for (const token of ['--sidebar-fill', '--sidebar-veil', '--sidebar-border', '--sidebar-blur', '--sidebar-saturate']) {
    assert.ok(defaults.includes(`${token}:`), `the default skin must define the authoritative ${token} value`);
  }
  // Translucent control is per-skin: the default keeps a strongly sheer sidebar.
  const fill = defaults.match(/--sidebar-fill:\s*rgba\([^)]*?,\s*(0?\.\d+)\)/);
  assert.ok(fill && Number(fill[1]) <= 0.25, 'the default sidebar veil must stay strongly translucent');
  const blur = defaults.match(/--sidebar-blur:\s*(\d+)px/);
  assert.ok(blur && Number(blur[1]) >= 8, 'the default sidebar must keep a glass blur');
}

function testSidebarDomainDoesNotLeakOntoOtherSkins() {
  const surfaces = read('styles/surfaces/session-sidebar.css');
  for (const skin of skinCore.SKINS) {
    const id = String(skin.id);
    if (id === 'default') continue;
    assert.ok(!surfaces.includes(`data-skin="${id}"`), `the shared domain must not mention the ${id} skin`);
  }
  const selectorScopes = [...surfaces.matchAll(/html\[data-skin="([a-z]+)"\]/g)].map(match => match[1]);
  assert.ok(selectorScopes.length > 0 && selectorScopes.every(id => id === 'default'),
    'transitional sidebar rules must stay scoped to the default skin until every skin uses control points');
}

function testSwitcherKeepsExactlyOneSkinSheetInSync() {
  const { document, storage } = makeDocument();
  storage.setItem(skinCore.SKIN_STORAGE_KEY, 'ink');
  const switcher = skinSwitcher.createSkinSwitcher({ document, storage, skinCore });
  assert.ok(switcher, 'the switcher must create against a real DOM');
  const sheet = () => document.head.querySelector('link[data-chatui-skin]');
  const links = () => [...document.head.querySelectorAll('link')];

  switcher.refresh();
  assert.strictEqual(sheet()?.getAttribute('href'), '/styles/skins/ink/skin.css', 'refresh must adopt the persisted skin sheet');

  switcher.selectSkin('snow');
  assert.strictEqual(sheet()?.getAttribute('href'), '/styles/skins/snow/skin.css', 'switching must retune the single sheet instead of stacking');
  assert.strictEqual(document.head.querySelectorAll('link[data-chatui-skin]').length, 1, 'only one skin sheet may ever be present');

  const bundle = document.head.querySelector('link[href*="chatui.bundle.css"]');
  const override = document.head.querySelector('link[data-chatui-post-skin]');
  assert.ok(links().indexOf(bundle) < links().indexOf(sheet()), 'the skin sheet must load after the shared bundle');
  assert.ok(links().indexOf(sheet()) < links().indexOf(override), 'the skin sheet must load before the post-skin override');

  switcher.selectSkin('default');
  assert.strictEqual(sheet(), null, 'the bundled default skin needs no injected sheet');
  assert.ok(document.documentElement.getAttribute('data-skin'), 'the default skin must still mark the document');

  switcher.selectSkin('not-a-skin');
  assert.strictEqual(sheet(), null, 'an unknown id must fail closed to default and request nothing');
}

function testSwitcherSurvivesMissingHeadAnchors() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://chatui.local/' });
  const storage = dom.window.localStorage;
  const switcher = skinSwitcher.createSkinSwitcher({ document: dom.window.document, storage, skinCore });
  switcher.refresh();
  storage.setItem(skinCore.SKIN_STORAGE_KEY, 'ink');
  switcher.selectSkin('snow');
  const sheet = dom.window.document.head.querySelector('link[data-chatui-skin]');
  assert.strictEqual(sheet?.getAttribute('href'), '/styles/skins/snow/skin.css', 'without an override anchor the sheet still loads at the head tail');
}

module.exports = [
  testSkinStylesheetHrefIsBundledOrOnDemand,
  testBootInjectsOnlyTheActiveNonDefaultSkin,
  testManifestShipsOnlyTheDefaultSkin,
  testInactiveSkinsNeverReachTheDocumentStyles,
  testPostSkinOverrideLoadsAfterEverySkin,
  testTransitionalDefaultScopeInsideSurfacesShrinksOnly,
  testSurfacesDomainOwnsSidebarAndDefaultSkinOwnsItsTokens,
  testSidebarDomainDoesNotLeakOntoOtherSkins,
  testSwitcherKeepsExactlyOneSkinSheetInSync,
  testSwitcherSurvivesMissingHeadAnchors,
];
