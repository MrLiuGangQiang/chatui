'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const staticBundle = require('../../server/services/static-bundle.service');
const { isPublicStaticPath } = require('../../server/http/static');
const skinCore = require('../../client/core/skin');
const skinSystem = require('../../client/features/skin-system/skin-switcher');

const ROOT = path.join(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n?/g, '\n');
}

function cssEntries() {
  return staticBundle.parseAssetManifest(ROOT, `${ROOT}${path.sep}`, 'css');
}

function orderOf(entries, pathSuffix) {
  return entries.findIndex(entry => entry.urlPath.endsWith(pathSuffix));
}

function testDefaultSidebarStaysTranslucent() {
  const defaults = read('styles/skins/default/skin.css');
  const at = defaults.indexOf('Default scenic canvas');
  assert.ok(at >= 0, 'default skin must own the scenic canvas pass');
  const tail = defaults.slice(at);
  const pairRe = /html\[data-skin="default"\] \.session-sidebar,\s*html\[data-skin="default"\] \.session-rail\s*\{([^}]*)\}/;
  const match = tail.match(pairRe);
  assert.ok(match, 'default skin must style .session-sidebar/.session-rail together in the scenic pass');
  const body = match[1];
  assert.ok(/background:\s*transparent/.test(body), 'sidebar must clear the opaque canvas');
  const alpha = body.match(/background-color:\s*rgba\([^)]*?,\s*(0?\.\d+)\)/);
  assert.ok(alpha && Number(alpha[1]) <= 0.25, 'default sidebar veil must stay strongly translucent (about 80% transparent)');
  assert.ok(/backdrop-filter:\s*blur\(/.test(body), 'sidebar must keep a glass blur');
  assert.ok(!/inset\s+\d+px\s+0\s+0/.test(body), 'sidebar must not gain a left colour bar');
}


function testDefaultActiveSessionUsesProminentAccentSelection() {
  const defaults = read('styles/skins/default/skin.css');
  const selectionRe = /html\[data-skin="default"\] \.session-tab\.active,\s*html\[data-skin="default"\] \.session-tab\.active:hover\s*\{([^}]*)\}/;
  const match = defaults.match(selectionRe);
  assert.ok(match, 'default skin must own a scoped active-session selection rule');

  const body = match[1];
  const wash = body.match(/background:\s*rgba\(77,\s*107,\s*254,\s*\.(\d+)\)/);
  assert.ok(wash && Number(wash[1]) >= 15, 'active session must use a dense enough accent wash');
  const border = body.match(/border-color:\s*rgba\(77,\s*107,\s*254,\s*\.(\d+)\)/);
  assert.ok(border && Number(border[1]) >= 35, 'active session must keep a visible accent border');
  assert.ok(!/inset\s+\d+px\s+0\s+0/.test(body), 'active session must not use a left colour bar');

  const titleAt = defaults.indexOf('html[data-skin="default"] .session-tab.active .session-title');
  assert.ok(titleAt >= 0, 'default active session must style its title');
  const titleBody = defaults.slice(defaults.indexOf('{', titleAt) + 1, defaults.indexOf('}', titleAt));
  assert.ok(/color:\s*#2f4ce4/.test(titleBody), 'active session title must use a darker accent');
  const weight = titleBody.match(/font-weight:\s*(\d+)/);
  assert.ok(weight && Number(weight[1]) >= 700, 'active session title must be bold');

  const metaAt = defaults.indexOf('html[data-skin="default"] .session-tab.active small');
  assert.ok(metaAt >= 0, 'default active session must style its metadata');
  const metaBody = defaults.slice(defaults.indexOf('{', metaAt) + 1, defaults.indexOf('}', metaAt));
  assert.ok(/color:\s*var\(--skin-accent\)/.test(metaBody), 'active session metadata must use the accent colour');
  assert.ok(/font-weight:\s*650/.test(metaBody), 'active session metadata must be emphasised');
}

function testDefaultSkinShipsTheSilkWaveCanvas() {
  const defaults = read('styles/skins/default/skin.css');
  assert.ok(defaults.includes('Default scenic canvas'), 'default skin must own the approved scenic canvas pass');
  assert.ok(defaults.includes('url("./scenery.jpg?v=1")'), 'default skin must reference its silk wave background');
  assert.ok(fs.existsSync(path.join(ROOT, 'styles/skins/default/scenery.jpg')), 'default background asset must ship inside the skin folder');
  const bundle = staticBundle.buildBundleBody(cssEntries(), 'css').toString('utf8');
  assert.ok(bundle.includes('url("/styles/skins/default/scenery.jpg?v=1")'), 'bundle must rewrite the default background to its public path');
}

function testSkinBootScriptAppliesOnlyKnownSkinBeforeBody() {
  const index = read('index.html');
  assert.ok(index.includes("document.documentElement.setAttribute('data-skin'"), 'index head must apply data-skin before body');
  const whitelist = index.match(/const skinIds = \[([^\]]*)\];/);
  assert.ok(whitelist, 'index boot script must declare the skin whitelist');
  const ids = whitelist[1].split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepStrictEqual(ids, skinCore.SKINS.map(skin => String(skin.id)), 'boot whitelist must match the registered skin catalog');
  assert.ok(index.includes("skinIds.includes(storedSkin) ? storedSkin : 'default'"), 'boot script must fail closed to the default skin');
}

function testSkinCssLoadsAfterDefaultThemeInStableOrder() {
  const entries = cssEntries();
  const calm = orderOf(entries, 'calm-theme.css');
  const defaults = orderOf(entries, 'skins/default/skin.css');
  const switcher = orderOf(entries, 'skin-system.css');
  const ink = orderOf(entries, 'skins/ink/skin.css');
  assert.ok(calm >= 0 && defaults >= 0 && switcher >= 0 && ink >= 0, 'skin CSS entries must be in the manifest');
  assert.ok(calm < defaults && defaults < switcher && switcher < ink, 'skin layers must override the default theme and ink must load last');
  assert.strictEqual(ink, entries.length - 1, 'ink skin must be the final CSS override');
}

function testDefaultSkinExtractsTokensAndAliasesCurrentPalette() {
  const defaults = read('styles/skins/default/skin.css');
  for (const fragment of ['--skin-canvas: #f7f8fb', '--skin-accent: #4d6bfe', '--chatui-canvas: var(--skin-canvas)', '--bg: var(--skin-canvas)', '--ds-page: var(--skin-canvas)']) {
    assert.ok(defaults.includes(fragment), `default skin extraction must keep ${fragment}`);
  }
}

function testInkSkinIsFullyScopedAndSurvivesBundleAssembly() {
  const ink = read('styles/skins/ink/skin.css');
  assert.ok(ink.includes(':root[data-skin="ink"]'), 'ink tokens must be scoped to the ink attribute');
  assert.ok(ink.includes('Generated color remap snapshot'), 'ink skin must include the generated hardcoded-color remap');
  assert.ok(ink.indexOf('Generated color remap snapshot') < ink.indexOf('Rice-paper canvas'), 'generated remap must run before manual ink overrides');
  for (const fragment of [
    'html[data-skin="ink"] body',
    'html[data-skin="ink"] .input-stack',
    'html[data-skin="ink"] .session-sidebar',
    'html[data-skin="ink"] .welcome-hero',
    'html[data-skin="ink"] .config-dialog { color: var(--skin-text)',
    'html[data-skin="ink"] .usage-stats-card { color: var(--skin-text)',
    'html[data-skin="ink"] .announcement-body { color: var(--skin-muted-strong)',
  ]) {
    assert.ok(ink.includes(fragment), `ink skin must cover ${fragment}`);
  }
  const body = staticBundle.buildBundleBody(cssEntries(), 'css').toString('utf8');
  for (const fragment of [':root[data-skin="ink"]', '--skin-canvas: #f4efe3', 'html[data-skin="ink"] .input-stack']) {
    assert.ok(body.includes(fragment), `CSS bundle must preserve ${fragment}`);
  }
}

function testInkSkinUsesApprovedSceneryAndAlignedPalette() {
  const ink = read('styles/skins/ink/skin.css');
  assert.ok(ink.includes('Approved scenic literati background'), 'ink skin must keep its approved scenic background');
  assert.ok(fs.existsSync(path.join(ROOT, 'styles/skins/ink/scenery.jpg')), 'approved ink scenery asset must ship with the skin');
  assert.ok(!fs.existsSync(path.join(ROOT, 'styles/skins/ink/ink-literati.svg')), 'superseded SVG background must not ship');
  assert.ok(!fs.existsSync(path.join(ROOT, 'styles/skins/ink/ink-literati.jpg')), 'superseded warm raster must not ship');
  assert.strictEqual((ink.match(/ink-literati/g) || []).length, 0, 'ink skin must not reference superseded artwork');

  for (const fragment of [
    'url("./scenery.jpg?v=1")',
    'background-position: center 46% !important',
    'background-size: cover !important',
    'Final palette alignment',
    '--skin-canvas: #f0f2ed',
    '--skin-accent: #5d776e',
    'linear-gradient(135deg, #647f76 0%, #4d675f 60%, #40584f 100%)',
    'radial-gradient(64rem 44rem at 50% 42%',
    'font-family: Georgia, "Songti SC", "STSong", "Noto Serif SC", SimSun, serif',
    'Unified literati material pass',
    '--ink-paper-raised',
  ]) {
    assert.ok(ink.includes(fragment), `scenic ink skin must keep ${fragment}`);
  }

  for (const selector of [
    'html[data-skin="ink"] .message.user .bubble',
    'html[data-skin="ink"] .input-stack',
    'html[data-skin="ink"] .config-dialog',
    'html[data-skin="ink"] .usage-stats-card',
    'html[data-skin="ink"] .welcome-hero',
    'html[data-skin="ink"] .welcome-feature-card',
    'html[data-skin="ink"] #configModal .config-dialog',
    'html[data-skin="ink"] .shell-app.app',
    'html[data-skin="ink"] .messages',
  ]) {
    assert.ok(ink.includes(selector), `aligned palette must cover ${selector}`);
  }

  const raisedMaterialCount = (ink.match(/background-image: var\(--ink-paper-raised\)/g) || []).length;
  assert.ok(raisedMaterialCount >= 3, 'primary surface groups must share the raised ink paper material');
  for (const staleColor of ['#3f5a7a', '#2f6d68', '#7c4a86']) {
    assert.ok(!ink.includes(staleColor), `ink skin must replace the cold modern hue ${staleColor}`);
  }

  for (const fragment of [
    'Conversation detail repair',
    'html[data-skin="ink"] .message.assistant .bubble:has(.generated-image-grid)',
    'html[data-skin="ink"] .generated-image-batch-slot',
    'html[data-skin="ink"] .intent-reasoning-trace',
    'html[data-skin="ink"] .message.assistant .bubble:not(:has(.generated-image-grid)):not(:has(.generated-image-batch-grid))',
    'background-color: rgba(237, 243, 239, .70) !important',
    'Scroll stability',
    'background-attachment: fixed, fixed !important',
    'html[data-skin="ink"] .message .bubble',
    'backdrop-filter: none !important',
    'Refresh scroll reliability',
    'background-attachment: scroll, scroll !important',
    'overflow-y: scroll !important',
    'touch-action: pan-y !important',
    'background: transparent !important',
    'Message translucency tuning',
    'Quiet session titles and waiting prompt',
    'html[data-skin="ink"] .session-tab.active',
    'border: 1px solid rgba(184, 203, 192, .36) !important',
    'border-color: rgba(158, 182, 170, .58) !important',
    'box-shadow: none !important',
    'background: rgba(237, 243, 239, .58) !important',
    'backdrop-filter: blur(14px) saturate(1.05)',
    'background-color: rgba(237, 243, 239, .70) !important',
    'backdrop-filter: blur(12px) saturate(1.04)',
  ]) {
    assert.ok(ink.includes(fragment), `aligned ink skin must keep conversation detail rule: ${fragment}`);
  }

  const bundle = staticBundle.buildBundleBody(cssEntries(), 'css').toString('utf8');
  assert.ok(!bundle.includes('ink-literati'), 'ink background must not reference superseded artwork');
  assert.ok(bundle.includes('url("/styles/skins/ink/scenery.jpg?v=1")'), 'CSS bundle must rewrite the approved scenery asset to its public path');
}

function testEveryRegisteredSkinOwnsAnIsolatedFolder() {
  const entries = cssEntries();
  const skinsRoot = path.join(ROOT, 'styles/skins');
  const folderIds = fs.readdirSync(skinsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const skinIds = skinCore.SKINS.map(skin => String(skin.id)).sort();
  assert.deepStrictEqual(folderIds, skinIds, 'styles/skins must contain exactly one folder per registered skin');

  for (const skin of skinCore.SKINS) {
    const id = String(skin.id);
    const relativeCss = `styles/skins/${id}/skin.css`;
    assert.ok(fs.existsSync(path.join(ROOT, relativeCss)), `${id} skin must own ${relativeCss}`);
    assert.ok(!fs.existsSync(path.join(ROOT, `styles/skins/${id}.css`)), `${id} skin must not keep a flat stylesheet outside its folder`);
    const manifestEntries = entries.filter(entry => entry.urlPath === `/styles/skins/${id}/skin.css`);
    assert.strictEqual(manifestEntries.length, 1, `manifest must load ${relativeCss} exactly once`);
    assert.ok(isPublicStaticPath(`/${relativeCss}`), `${relativeCss} must remain publicly servable`);

    const css = read(relativeCss);
    for (const match of css.matchAll(/url\(\s*["']?\.\/([^"'()?#]+)/gi)) {
      const asset = match[1];
      const assetUrl = `/styles/skins/${id}/${asset}`;
      assert.ok(isPublicStaticPath(assetUrl), `${assetUrl} must remain publicly servable`);
      assert.ok(
        fs.existsSync(path.join(ROOT, 'styles/skins', id, asset)),
        `${id} skin asset ${asset} must live inside styles/skins/${id}`
      );
    }
  }
}

function testInkSkinKeepsMessagesTransparentAndSidebarTranslucent() {
  const ink = read('styles/skins/ink/skin.css');
  const finalPass = ink.indexOf('Quiet conversation surfaces');
  assert.ok(finalPass > ink.indexOf('Refresh scroll reliability'), 'transparent message pass must win over the scroll-stability tints');

  function finalRuleBody(selector) {
    const at = ink.lastIndexOf(selector);
    assert.ok(at >= 0, `ink skin must define ${selector}`);
    const open = ink.indexOf('{', at);
    const close = ink.indexOf('}', open);
    assert.ok(open >= 0 && close > open, `ink skin must close the rule for ${selector}`);
    return ink.slice(open + 1, close);
  }

  for (const selector of [
    'html[data-skin="ink"] .message.user .bubble',
    'html[data-skin="ink"] .message.assistant .bubble:not(:has(.generated-image-grid)):not(:has(.generated-image-batch-grid))',
    'html[data-skin="ink"] .message.error .bubble',
  ]) {
    const body = finalRuleBody(selector);
    assert.ok(/background:\s*transparent\s*!important/.test(body), `${selector} must end fully transparent`);
    assert.ok(/background-image:\s*none\s*!important/.test(body), `${selector} must not paint a bubble fill`);
    assert.ok(/box-shadow:\s*none\s*!important/.test(body), `${selector} must not keep a card shadow`);
  }

  const sidebar = finalRuleBody('html[data-skin="ink"] .session-sidebar');
  assert.ok(/background-color:\s*rgba\(/.test(sidebar), 'sidebar must use a translucent rgba veil');
  assert.ok(/backdrop-filter:\s*blur\(/.test(sidebar), 'sidebar must keep a glass blur behind its veil');
  const alpha = sidebar.match(/background-color:\s*rgba\([^)]*?,\s*(0?\.\d+)\)/);
  assert.ok(alpha && Number(alpha[1]) < 1, 'sidebar background must stay semi-transparent');
  assert.ok(Number(alpha[1]) <= 0.6, 'sidebar veil must let the painting read through');
}

function testSkinsNeverRevealTheLegacyInlineImageDownloadRow() {
  const base = read('styles.css');
  assert.ok(/\.content\s*\.image-download-row\s*\{\s*display:\s*none\s*!important/.test(base),
    'the default theme must keep the legacy in-bubble image download row hidden');

  for (const skin of skinCore.SKINS) {
    const id = String(skin.id);
    if (id === 'default') continue;
    const css = read(`styles/skins/${id}/skin.css`);
    for (const rule of css.split("}")) {
      if (!rule.includes(".image-download-row")) continue;
      const body = rule.slice(rule.lastIndexOf("{") + 1);
      assert.ok(!/display\s*:/.test(body), `${id} skin must not re-display the legacy .image-download-row`);
    }
  }
}

function testInkSkinKeepsPreviewDownloadLookingEnabled() {
  const ink = read('styles/skins/ink/skin.css');
  const selector = 'html[data-skin="ink"] .image-preview-download svg path';
  const at = ink.lastIndexOf(selector);
  assert.ok(at >= 0, 'ink skin must style the image preview download glyph');
  const open = ink.indexOf('{', at);
  const close = ink.indexOf('}', open);
  const body = ink.slice(open + 1, close);
  assert.ok(/stroke:\s*currentColor\s*!important/.test(body), 'preview download glyph must inherit the enabled action colour');
  assert.ok(!/#52606d/i.test(body), 'preview download glyph must not keep the muted disabled-looking colour');

  const hoverAt = ink.lastIndexOf('html[data-skin="ink"] .image-preview-download:hover {');
  assert.ok(hoverAt > at, 'preview download must define a hover state after the base colour');
  assert.ok(/color:\s*#fff6e3\s*!important/i.test(ink.slice(hoverAt, ink.indexOf('}', hoverAt))), 'preview download hover must brighten the glyph');
}

function testEverySkinKeepsTheActiveSessionDistinct() {
  for (const skin of skinCore.SKINS) {
    const id = String(skin.id);
    if (id === 'default') continue;
    const css = read(`styles/skins/${id}/skin.css`);
    const pattern = new RegExp(`html\\[data-skin="${id}"\\] \\.session-tab\\.active(?:,\\s*html\\[data-skin="${id}"\\] \\.session-tab\\.active:hover)?\\s*\\{([^}]*)\\}`, "g");
    const matches = [...css.matchAll(pattern)];
    const body = matches.length ? matches[matches.length - 1][1] : "";
    assert.ok(body, `${id} must style the active session tab`);
    assert.ok(/background/.test(body), `${id} active session must define a selection wash`);
    assert.ok(!/inset\s+\d+px\s+0\s+0/.test(body), `${id} active session must not use a left colour bar`);

    const titleAt = css.indexOf(`html[data-skin="${id}"] .session-tab.active .session-title`);
    assert.ok(titleAt >= 0, `${id} must style the active session title`);
    const titleBody = css.slice(css.indexOf('{', titleAt) + 1, css.indexOf('}', titleAt));
    assert.ok(/font-weight:\s*700/.test(titleBody), `${id} active session title must be bold`);
  }
}

function testSnowSkinKeepsMessagesTransparentAndSidebarTranslucent() {
  const snow = read('styles/skins/snow/skin.css');
  const pass = snow.indexOf('Quiet conversation surfaces');
  assert.ok(pass >= 0, 'snow skin must keep a final quiet-surface pass');
  const tail = snow.slice(pass);

  function lastRuleBody(selector) {
    const at = tail.lastIndexOf(selector);
    assert.ok(at >= 0, `snow skin must define ${selector}`);
    const open = tail.indexOf('{', at);
    const close = tail.indexOf('}', open);
    return tail.slice(open + 1, close);
  }

  for (const selector of [
    'html[data-skin="snow"] .message.user .bubble',
    'html[data-skin="snow"] .message.assistant .bubble',
    'html[data-skin="snow"] .message.error .bubble',
  ]) {
    const body = lastRuleBody(selector);
    assert.ok(/background:\s*transparent\s*!important/.test(body), `${selector} must end fully transparent`);
    assert.ok(/border-color:\s*transparent\s*!important/.test(body), `${selector} must drop its bubble border`);
    assert.ok(/box-shadow:\s*none\s*!important/.test(body), `${selector} must not keep a card shadow`);
  }

  const sidebar = lastRuleBody('html[data-skin="snow"] .session-sidebar');
  assert.ok(/background-color:\s*rgba\(/.test(sidebar), 'sidebar must use a translucent frost veil');
  assert.ok(/backdrop-filter:\s*blur\(/.test(sidebar), 'sidebar must keep a glass blur');
  const alpha = sidebar.match(/background-color:\s*rgba\([^)]*?,\s*(0?\.\d+)\)/);
  assert.ok(alpha && Number(alpha[1]) <= 0.6, 'sidebar veil must stay translucent');
}

function testSnowSkinShipsItsAlpineBackground() {
  const snow = read('styles/skins/snow/skin.css');
  assert.ok(snow.includes(':root[data-skin="snow"]'), 'snow skin must define scoped tokens');
  assert.ok(snow.includes('url("./scenery.jpg?v=1")'), 'snow skin must reference its own alpine background');
  assert.ok(fs.existsSync(path.join(ROOT, 'styles/skins/snow/scenery.jpg')), 'snow background asset must ship inside the skin folder');
  assert.ok(read('styles/skin-system.css').includes('.skin-swatch-snow'), 'snow skin must have a switcher swatch');
  const bundle = staticBundle.buildBundleBody(cssEntries(), 'css').toString('utf8');
  assert.ok(bundle.includes('url("/styles/skins/snow/scenery.jpg?v=1")'), 'bundle must rewrite the snow background to its public path');
}

function testSkinSwitcherTriggerUsesAColourfulPaletteIcon() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://chatui.local/' });
  const document = dom.window.document;
  const switcher = skinSystem.createSkinSwitcher({ document, storage: dom.window.localStorage, skinCore });
  assert.ok(switcher, 'switcher must render for the icon check');
  switcher.refresh();
  const svg = document.querySelector('.skin-switcher-trigger svg');
  assert.ok(svg, 'skin trigger must render an svg icon');

  const paletteColours = [...svg.querySelectorAll("[fill]")]
    .map(node => String(node.getAttribute("fill") || "").trim().toLowerCase())
    .filter(value => value && value !== "none" && value !== "currentcolor");
  assert.ok(new Set(paletteColours).size >= 4, `palette icon needs at least four distinct paint colours, found ${new Set(paletteColours).size}`);
  assert.ok(svg.querySelectorAll("circle").length >= 4, "palette icon must paint several colour dabs");
  assert.ok(svg.querySelector("path"), "palette icon must keep the painter palette body");

  const css = read('styles/skin-system.css');
  const triggerSvgRule = css.match(/\.skin-switcher-trigger svg \{[^}]*\}/);
  assert.ok(triggerSvgRule, 'trigger svg rule must exist');
  assert.ok(!/stroke:\s*currentColor/.test(triggerSvgRule[0]), "trigger svg rule must not recolour the palette icon with currentColor");
}

function testSkinSwitcherAppliesPersistsAndShowsActiveOption() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://chatui.local/' });
  const document = dom.window.document;
  const storage = dom.window.localStorage;
  const switcher = skinSystem.createSkinSwitcher({ document, storage, skinCore });
  assert.ok(switcher, 'skin switcher must create against a real DOM');

  switcher.refresh();
  assert.strictEqual(document.documentElement.getAttribute('data-skin'), 'default');
  const trigger = document.querySelector('.skin-switcher-trigger');
  const options = [...document.querySelectorAll('.skin-switcher-option')];
  assert.ok(trigger, 'bottom-right skin trigger must be rendered');
  assert.strictEqual(options.length, skinCore.SKINS.length);
  assert.deepStrictEqual(options.map(option => option.dataset.skinId), skinCore.SKINS.map(skin => String(skin.id)));
  assert.strictEqual(options[0].getAttribute('aria-checked'), 'true');

  trigger.click();
  assert.strictEqual(document.querySelector('.skin-switcher-menu').hidden, false, 'trigger must open the skin menu');
  options[1].click();
  assert.strictEqual(document.documentElement.getAttribute('data-skin'), 'ink');
  assert.strictEqual(storage.getItem(skinCore.SKIN_STORAGE_KEY), 'ink');
  assert.strictEqual(options[1].getAttribute('aria-checked'), 'true');
  assert.strictEqual(document.querySelector('.skin-switcher-menu').hidden, true, 'choosing a skin must close the menu');

  trigger.click();
  options[0].click();
  assert.strictEqual(document.documentElement.getAttribute('data-skin'), 'default');
  assert.strictEqual(storage.getItem(skinCore.SKIN_STORAGE_KEY), 'default');
}

module.exports = [
  testSkinBootScriptAppliesOnlyKnownSkinBeforeBody,
  testSkinCssLoadsAfterDefaultThemeInStableOrder,
  testDefaultSkinExtractsTokensAndAliasesCurrentPalette,
  testInkSkinIsFullyScopedAndSurvivesBundleAssembly,
  testInkSkinUsesApprovedSceneryAndAlignedPalette,
  testEveryRegisteredSkinOwnsAnIsolatedFolder,
  testInkSkinKeepsMessagesTransparentAndSidebarTranslucent,
  testInkSkinKeepsPreviewDownloadLookingEnabled,
  testEverySkinKeepsTheActiveSessionDistinct,
  testSnowSkinKeepsMessagesTransparentAndSidebarTranslucent,
  testSkinsNeverRevealTheLegacyInlineImageDownloadRow,
  testDefaultSkinShipsTheSilkWaveCanvas,
  testDefaultSidebarStaysTranslucent,
  testDefaultActiveSessionUsesProminentAccentSelection,
  testSnowSkinShipsItsAlpineBackground,
  testSkinSwitcherTriggerUsesAColourfulPaletteIcon,
  testSkinSwitcherAppliesPersistsAndShowsActiveOption,
];
