'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const staticBundle = require('../../server/services/static-bundle.service');

const ROOT = path.join(__dirname, '../..');
const THEME_FILE = path.join(ROOT, 'styles/flat-theme.css');
const STATUS_SELECTOR = '.generated-image-slot-status';

// Regression gate: the live image-pending status ("正在基于参考图生成图片") was
// forced to a single line with text-overflow:ellipsis inside a fixed-width
// (120px) pending image slot, so the phrase rendered truncated ("正在基于参…").
// The status element must be allowed to wrap so the full status stays visible.
function cssRuleBlocks(source) {
  return source
    .split('}')
    .map(block => block.trim())
    .filter(block => block.includes('{'));
}

function statusRule(source) {
  return cssRuleBlocks(source).find(block => {
    const selector = block.slice(0, block.indexOf('{'));
    return selector.split(',').some(part => part.trim() === STATUS_SELECTOR);
  });
}

function testGeneratedImageSlotStatusAllowsWrappingInTheme() {
  const source = fs.readFileSync(THEME_FILE, 'utf8');
  const rule = statusRule(source);
  assert.ok(rule, `${THEME_FILE} must define a rule for ${STATUS_SELECTOR}`);
  const body = rule.slice(rule.indexOf('{') + 1);
  assert.ok(
    /white-space\s*:\s*normal/i.test(body),
    `${STATUS_SELECTOR} must allow wrapping (white-space:normal)`,
  );
  assert.ok(
    !(/white-space\s*:\s*nowrap/i.test(body) && /text-overflow\s*:\s*ellipsis/i.test(body)),
    `${STATUS_SELECTOR} must not force single-line truncation (nowrap + ellipsis)`,
  );
}

function testGeneratedImageSlotStatusWrappingSurvivesBundleAssembly() {
  const entries = staticBundle.parseAssetManifest(ROOT, `${ROOT}${path.sep}`, 'css');
  const theme = entries.find(entry => entry.urlPath === '/styles/flat-theme.css');
  assert.ok(theme, 'flat-theme.css must be part of the CSS asset manifest');
  const body = staticBundle.buildBundleBody([theme], 'css').toString('utf8');
  const rule = statusRule(body);
  assert.ok(rule, 'CSS bundle must preserve the .generated-image-slot-status rule');
  const ruleBody = rule.slice(rule.indexOf('{') + 1);
  assert.ok(
    /white-space\s*:\s*normal/i.test(ruleBody),
    'CSS bundle must preserve .generated-image-slot-status wrapping',
  );
}

module.exports = [
  testGeneratedImageSlotStatusAllowsWrappingInTheme,
  testGeneratedImageSlotStatusWrappingSurvivesBundleAssembly,
];
