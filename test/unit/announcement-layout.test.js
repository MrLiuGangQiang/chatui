'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function cssRule(css, selector) {
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm'
  );
  const match = css.match(pattern);
  assert.ok(match, `Missing CSS rule ${selector}`);
  return match[1];
}

function testAnnouncementLayoutKeepsMainContentCompactAndFormal() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/announcement.css'), 'utf8');

  // Main content keeps a tight, formal vertical rhythm.
  assert.match(cssRule(css, '.announcement-head'), /padding:\s*20px 30px 14px/);
  assert.match(cssRule(css, '.announcement-scroll'), /padding:\s*0 30px 16px/);
  assert.match(cssRule(css, '.announcement-latest'), /padding:\s*18px 22px 20px/);
  assert.match(cssRule(css, '.announcement-footer'), /padding:\s*13px 30px 16px/);
  assert.match(cssRule(css, '.announcement-history-panel'), /margin-top:\s*16px/);

  // Single-column responsive layout keeps the cover and content in separate rows.
  assert.match(css, /@media \(max-width: 860px\) \{[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\);/);

  // Low-height desktops get an extra density level without hiding content.
  assert.match(css, /@media \(min-width: 861px\) and \(max-height: 760px\) \{[\s\S]*?\.announcement-head \{ padding: 16px 30px 12px; \}/);

  // The notification stays formal and simple: flat surfaces, one subtle accent.
  assert.match(cssRule(css, '.announcement-dialog'), /border-radius:\s*22px/);
  assert.match(cssRule(css, '.announcement-hero-tips'), /box-shadow:\s*none/);
  assert.match(cssRule(css, '.announcement-hero-explain'), /box-shadow:\s*none/);
  assert.doesNotMatch(cssRule(css, '.announcement-backdrop'), /radial-gradient/);
  assert.doesNotMatch(cssRule(css, '.announcement-hero'), /radial-gradient|linear-gradient/);
  assert.doesNotMatch(cssRule(css, '.announcement-surface'), /radial-gradient|linear-gradient/);
  const acknowledgeRule = css.match(/\.announcement-acknowledge-btn\s*\{\s*min-width:\s*220px;[^}]*\}/);
  assert.ok(acknowledgeRule, 'Missing standalone .announcement-acknowledge-btn rule');
  assert.doesNotMatch(acknowledgeRule[0], /linear-gradient/);
  assert.match(acknowledgeRule[0], /background:\s*#4f46e5/);
}

module.exports = [
  testAnnouncementLayoutKeepsMainContentCompactAndFormal,
];
