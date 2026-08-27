'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testMobileWelcomeUsesACompactFirstScreenLayout() {
  const root = path.resolve(__dirname, '../..');
  const css = fs.readFileSync(path.join(root, 'styles/flat-theme.css'), 'utf8').replace(/\r\n?/g, '\n').replace(/\r\n?/g, '\n');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const mobileStart = css.indexOf('@media (max-width:640px)');
  const mobileEnd = css.indexOf('/* Height-aware welcome density', mobileStart);
  const mobile = css.slice(mobileStart, mobileEnd);

  assert.ok(mobileStart >= 0 && mobileEnd > mobileStart);
  assert.match(mobile, /\.welcome-badges,\.welcome-guidelines,\.welcome-section-head\{display:none!important;\}/);
  assert.match(mobile, /\.welcome-feature-card p,\.welcome-feature-index\{display:none!important;\}/);
  assert.match(mobile, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)!important/);
  assert.match(mobile, /\.welcome-feature-card\{[\s\S]*min-height:50px!important/);
  assert.ok(!/\.welcome-feature-grid\{grid-template-columns:1fr!important/.test(mobile), 'narrow phones must not expand four compact capabilities into four full-width rows');
  assert.ok(index.includes('flat-theme.css?v=2.2.14-welcome-fonts'));
}

module.exports = [testMobileWelcomeUsesACompactFirstScreenLayout];
