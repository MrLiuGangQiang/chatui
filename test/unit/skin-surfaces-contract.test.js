'use strict';

// Design 29 stage 2 gates for the surfaces layer.
//
// A visual domain may only express colour/material through skin control points,
// and every control point it consumes must have an authoritative default. These
// baselines ratchet: extracted surface area can only get cleaner, never worse.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const SURFACES_DIR = path.join(ROOT, 'styles', 'surfaces');

// Files extracted so far, with the number of COLOUR declarations that still
// need !important to beat the base layers. Stage 1 leaves four on the sidebar
// because styles.css/flat-theme.css still shout; every new domain must start
// at zero and the existing entries may only go down. Behavioural !important
// (overflow locking, inert, display, font, motion) is not a skin contract and
// is deliberately not counted here.
const COLOUR_IMPORTANT_BASELINE = {
  'session-sidebar.css': 4,
  'usage-stats.css': 0,
  'announcement.css': 0,
};
const COLOR_PROPS = [
  'color', 'background', 'background-color', 'border', 'border-color',
  'border-top', 'border-bottom', 'box-shadow', 'outline', 'fill', 'stroke',
];

function readCss(name) {
  return fs.readFileSync(path.join(SURFACES_DIR, name), 'utf8');
}

function liveCss(source) {
  return String(source).replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// A var() fallback is not a bare literal: it is the value used only when the
// referenced custom property is missing, and legacy alias variables still
// carry fallbacks until stage 2 retires them.
function withoutVarArguments(text) {
  return String(text).replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "var()");
}

function surfaceFiles() {
  return fs.readdirSync(SURFACES_DIR).filter(name => name.endsWith('.css')).sort();
}

function defaultSkinDeclarations() {
  const skin = liveCss(fs.readFileSync(path.join(ROOT, 'styles/skins/default/skin.css'), 'utf8'));
  return new Set((skin.match(/(--[a-z0-9-]+)\s*:/g) || []).map(text => text.slice(0, -1).trim()));
}

function consumedControlPoints(source) {
  return new Set((liveCss(source).match(/var\((--[a-z0-9-]+)\)/g) || []).map(text => text.slice(4, -1)));
}

function testEverySurfaceControlPointHasAnAuthoritativeDefault() {
  const declared = defaultSkinDeclarations();
  for (const name of surfaceFiles()) {
    const missing = [...consumedControlPoints(readCss(name))].filter(token => !declared.has(token));
    assert.deepStrictEqual(
      missing,
      [],
      `${name} consumes control points the default skin never declares: ${missing.join(', ')}`
    );
  }
}

function testSurfacesCarryNoBareColourLiterals() {
  for (const name of surfaceFiles()) {
    const live = liveCss(readCss(name));
    const bare = [...withoutVarArguments(live).matchAll(new RegExp(`(${COLOR_PROPS.join('|')})\\s*:\\s*[^;{}]*?(#[0-9a-fA-F]{3,8}|\\brgba?\\()`, 'g'))];
    assert.strictEqual(
      bare.length,
      0,
      `${name} must route every colour through a control point; found ${bare.length} bare literal(s) such as ${bare[0] ? bare[0][0].replace(/\s+/g, ' ') : ''}`
    );
  }
}

function testSurfacesColourImportantBaselineOnlyShrinks() {
  const files = surfaceFiles();
  const colourImportant = new RegExp(
    '(?:^|[;{\\s])(' + COLOR_PROPS.join('|') + ')\\s*:[^;{}]*!important',
    'g',
  );
  for (const name of files) {
    const live = liveCss(readCss(name)).replace(/\s+/g, ' ');
    const count = (live.match(colourImportant) || []).length;
    const baseline = COLOUR_IMPORTANT_BASELINE[name];
    assert.ok(
      baseline !== undefined,
      `${name} is not registered in the surfaces colour-!important baseline; a new domain must start at 0`,
    );
    assert.ok(
      count <= baseline,
      `${name} routes ${count} colour declarations through !important but the baseline is ${baseline}; win by cascade position, never by weight`,
    );
  }
  for (const name of Object.keys(COLOUR_IMPORTANT_BASELINE)) {
    assert.ok(files.includes(name), `${name} is registered in the baseline but no longer exists`);
  }
}
function testUsageDomainExposesItsDocumentedControlPointFamilies() {
  const tokens = consumedControlPoints(readCss('usage-stats.css'));
  // The two tier families must stay separate: the skins colour metric tiers and
  // token badges differently, so a shared token would erase one of them.
  for (let index = 0; index <= 3; index += 1) {
    for (const suffix of ['line', 'surface', 'text']) {
      assert.ok(tokens.has(`--usage-metric-${index}-${suffix}`), `metric tier ${index} needs a ${suffix} control point`);
    }
  }
  for (let index = 0; index <= 4; index += 1) {
    for (const suffix of ['line', 'surface', 'text']) {
      assert.ok(tokens.has(`--usage-badge-${index}-${suffix}`), `badge tier ${index} needs a ${suffix} control point`);
    }
  }
  const source = readCss('usage-stats.css');
  assert.ok(!/--usage-tier-/.test(source), 'the old shared tier token family must not come back');
}

function testUsageDomainHeaderDocumentsItsControlPoints() {
  const source = readCss('usage-stats.css');
  const header = source.slice(0, source.indexOf('*/'));
  assert.ok(/域：/.test(header), 'the domain file must open with its domain name');
  assert.ok(/控制点契约/.test(header), 'the header must state the colour-only token contract');
  for (const family of ['--usage-surface', '--usage-text', '--usage-line', '--usage-accent', '--usage-metric-', '--usage-badge-', '--usage-medal-', '--usage-scrim', '--usage-shadow-']) {
    assert.ok(header.includes(family), `the header must document the ${family} family`);
  }
}

module.exports = [
  testEverySurfaceControlPointHasAnAuthoritativeDefault,
  testSurfacesCarryNoBareColourLiterals,
  testSurfacesColourImportantBaselineOnlyShrinks,
  testUsageDomainExposesItsDocumentedControlPointFamilies,
  testUsageDomainHeaderDocumentsItsControlPoints,
];