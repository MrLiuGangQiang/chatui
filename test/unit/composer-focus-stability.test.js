'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
function collectCssFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectCssFiles(file);
    return entry.isFile() && entry.name.endsWith('.css') ? [file] : [];
  });
}

const STYLESHEETS = [
  path.join(ROOT, 'styles.css'),
  ...collectCssFiles(path.join(ROOT, 'styles')),
].map(file => path.relative(ROOT, file).split(path.sep).join('/'));

function isBorderColorProperty(property) {
  return /^border(?:-(?:top|right|bottom|left))?-color$/.test(property);
}

function isAccentColour(value) {
  return /^var\(--(?:skin-)?accent(?:\s*,|\s*\))/.test(String(value || '').trim());
}

function collectStyleRules(cssRules, output = []) {
  for (const rule of Array.from(cssRules || [])) {
    if (rule.selectorText) output.push(rule);
    else if (rule.cssRules) collectStyleRules(rule.cssRules, output);
  }
  return output;
}

function splitSelectors(selectorText) {
  return String(selectorText || '').split(',').map(selector => selector.trim()).filter(Boolean);
}

function isInputStackFocusRule(rule) {
  const selectors = splitSelectors(rule.selectorText);
  const stackSelectors = selectors.filter(selector => selector.includes('.input-stack'));
  return stackSelectors.length > 0
    && stackSelectors.some(selector => selector.includes(':focus-within'))
    && stackSelectors.every(selector => selector.includes(':focus'));
}

function inputStackFocusRules(file) {
  const css = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const dom = new JSDOM(`<!doctype html><style>${css}</style>`);
  return collectStyleRules(dom.window.document.styleSheets[0]?.cssRules).filter(isInputStackFocusRule);
}

function testInputFocusOnlyChangesBorderColor() {
  for (const file of STYLESHEETS) {
    for (const rule of inputStackFocusRules(file)) {
      for (let index = 0; index < rule.style.length; index += 1) {
        const property = rule.style.item(index);
        assert.ok(
          isBorderColorProperty(property),
          `${file} ${rule.selectorText} must not change ${property} on input focus`,
        );
      }
    }
  }
}

function testEverySkinFocusBorderUsesAccentColour() {
  for (const file of STYLESHEETS) {
    for (const rule of inputStackFocusRules(file)) {
      for (let index = 0; index < rule.style.length; index += 1) {
        const property = rule.style.item(index);
        if (!isBorderColorProperty(property)) continue;
        const value = rule.style.getPropertyValue(property);
        assert.ok(
          isAccentColour(value),
          `${file} ${rule.selectorText} must use a high-contrast accent for ${property}; got ${value}`,
        );
      }
    }
  }
}

function testEverySkinKeepsABorderOnlyFocusFeedback() {
  for (const file of STYLESHEETS) {
    const rules = inputStackFocusRules(file);
    if (!rules.length) continue;
    assert.ok(
      rules.some(rule => rule.style.getPropertyValue('border-color')),
      `${file} must expose input focus through border-color`,
    );
  }
}

module.exports = [
  testInputFocusOnlyChangesBorderColor,
  testEverySkinFocusBorderUsesAccentColour,
  testEverySkinKeepsABorderOnlyFocusFeedback,
];
