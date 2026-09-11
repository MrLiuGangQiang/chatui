'use strict';

const assert = require('assert');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const staticBundle = require('../../server/services/static-bundle.service');

const ROOT = path.join(__dirname, '../..');
const EXPECTED_RADIUS = '2px';

function buildCssBundle() {
  const entries = staticBundle.parseAssetManifest(ROOT, `${ROOT}${path.sep}`, 'css');
  return staticBundle.buildBundleBody(entries, 'css').toString('utf8');
}

function generatedImageRadii() {
  const css = buildCssBundle();
  const dom = new JSDOM(
    `<style>${css}</style><main id="messages"><article class="message assistant"><div class="bubble-wrap"><div class="bubble"><div class="content markdown-body"><div class="generated-image-grid"><div class="generated-image-item"><img class="generated-thumb" alt="" /></div></div></div></div></div></article>`,
    { virtualConsole: new VirtualConsole() },
  );
  const document = dom.window.document;
  const image = document.querySelector('img.generated-thumb');
  const item = document.querySelector('.generated-image-item');
  const radii = {
    image: dom.window.getComputedStyle(image).borderRadius,
    item: dom.window.getComputedStyle(item).borderRadius,
  };
  dom.window.close();
  return radii;
}

function generatedImageRadiusDeclarations(css) {
  const declarations = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rulePattern.exec(css))) {
    const selectors = match[1].trim();
    if (!selectors.includes('.generated-thumb') && !selectors.includes('.generated-image-item')) continue;
    const radius = /border-radius\s*:\s*([^;}]+)/i.exec(match[2]);
    if (!radius) continue;
    declarations.push({
      selectors: selectors.replace(/\s+/g, ' ').slice(0, 160),
      value: radius[1].replace(/!important/gi, '').trim(),
    });
  }
  return declarations;
}

function testGeneratedImageThumbnailUsesTightCorners() {
  const radii = generatedImageRadii();
  assert.strictEqual(radii.image, EXPECTED_RADIUS,
    'generated thumbnails must render with the 2px conversation-image radius');
  assert.strictEqual(radii.item, EXPECTED_RADIUS,
    'the generated-image wrapper must not restore a larger rounded frame');
}

function testGeneratedImageRulesNeverDeclareLargerCorners() {
  const declarations = generatedImageRadiusDeclarations(buildCssBundle());
  assert.ok(declarations.length >= 5,
    `the bundle must keep explicit generated-image radius rules, found ${declarations.length}`);
  for (const declaration of declarations) {
    const match = /^([\d.]+)(?:px)?$/.exec(declaration.value);
    assert.ok(match, `unexpected generated-image radius "${declaration.value}" in ${declaration.selectors}`);
    assert.ok(Number(match[1]) <= 2,
      `generated-image selector "${declaration.selectors}" must stay at or below 2px, found "${declaration.value}"`);
  }
}

function testGeneratedImagesUseACheckerboardBehindTransparency() {
  const css = buildCssBundle();
  const rule = /\.generated-image-item\s*\{[^}]*background-image:[^}]*linear-gradient[^}]*\}/i.exec(css);
  assert.ok(rule, 'generated images must render over a checkerboard so transparency is visible');
  assert.match(rule[0], /background-size:\s*12px 12px/i);
}

module.exports = [
  testGeneratedImageThumbnailUsesTightCorners,
  testGeneratedImageRulesNeverDeclareLargerCorners,
  testGeneratedImagesUseACheckerboardBehindTransparency,
];
