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

// Files extracted so far, with the !important count they still carry. Stage 1
// keeps six on the sidebar because the base layers still shout; every new domain
// must ship at zero, and the existing entries may only go down.
const IMPORTANT_BASELINE = {
  'session-sidebar.css': 6,
  'usage-stats.css': 0,
};

const COLOR_PROPS = 'color|background|background-color|border|border-color|box-shadow|outline|stroke|fill';

function readCss(name) {
  return fs.readFileSync(path.join(SURFACES_DIR, name), 'utf8');
}

function liveCss(source) {
  return String(source).replace(/\/\*[\s\S]*?\*\//g, ' ');
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
    const bare = [...live.matchAll(new RegExp(`(${COLOR_PROPS})\\s*:\\s*[^;{}]*?(#[0-9a-fA-F]{3,8}|\\brgba?\\()`, 'g'))];
    assert.strictEqual(
      bare.length,
      0,
      `${name} must route every colour through a control point; found ${bare.length} bare literal(s) such as ${bare[0] ? bare[0][0].replace(/\s+/g, ' ') : ''}`
    );
  }
}

function testSurfacesImportantBaselineOnlyShrinks() {
  const files = surfaceFiles();
  for (const name of files) {
    const count = (liveCss(readCss(name)).match(/!important/g) || []).length;
    const baseline = IMPORTANT_BASELINE[name];
    assert.ok(
      baseline !== undefined,
      `${name} is not registered in the surfaces !important baseline; a new domain must start at 0`
    );
    assert.ok(
      count <= baseline,
      `${name} carries ${count} !important declarations but the baseline is ${baseline}; remove weight, never add it`
    );
  }
  for (const name of Object.keys(IMPORTANT_BASELINE)) {
    assert.ok(files.includes(name), `${name} is registered in the !important baseline but no longer exists`);
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
  testSurfacesImportantBaselineOnlyShrinks,
  testUsageDomainExposesItsDocumentedControlPointFamilies,
  testUsageDomainHeaderDocumentsItsControlPoints,
];