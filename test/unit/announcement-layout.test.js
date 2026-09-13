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

function testAnnouncementLayoutPreservesTheOriginalTwoColumnContent() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/announcement.css'), 'utf8');
  const dialog = cssRule(css, '.announcement-dialog');
  const hero = cssRule(css, '.announcement-hero');
  const surface = cssRule(css, '.announcement-surface');

  // Full-screen only changes the outer frame; the original two-column content remains.
  assert.match(cssRule(css, '.announcement-modal'), /padding:\s*0/);
  assert.match(dialog, /display:\s*grid/);
  assert.match(dialog, /grid-template-columns:\s*minmax\(280px, clamp\(280px, 20vw, 320px\)\) minmax\(0, 1fr\)/);
  assert.match(dialog, /width:\s*100%/);
  assert.match(dialog, /height:\s*100%/);
  assert.match(hero, /display:\s*flex/);
  assert.doesNotMatch(hero, /display:\s*none/);
  assert.match(hero, /overflow:\s*auto/);
  assert.match(surface, /display:\s*flex/);
  assert.match(surface, /min-height:\s*0/);
  assert.match(cssRule(css, '.announcement-head'), /width:\s*min\(100%, 1440px\)/);
  assert.match(cssRule(css, '.announcement-scroll'), /overflow:\s*auto/);
  assert.match(cssRule(css, '.announcement-footer'), /flex:\s*0 0 auto/);
}

function testAnnouncementLayoutKeepsReadableFullScreenSpacing() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/announcement.css'), 'utf8');
  assert.match(cssRule(css, '.announcement-hero h2'), /font-size:\s*clamp\(28px, 2.8vw, 40px\)/);
  assert.match(cssRule(css, '.announcement-title'), /font-size:\s*clamp\(28px, 2.6vw, 40px\)/);
  assert.match(cssRule(css, '.announcement-body'), /font-size:\s*15.5px/);
  assert.match(cssRule(css, '.announcement-latest'), /padding:\s*24px 28px 28px/);
  assert.match(cssRule(css, '.announcement-footer'), /padding:\s*15px clamp\(24px, 2.5vw, 40px\) 20px/);
  assert.ok(css.includes('@media (max-width: 860px)') && css.includes('grid-template-rows: minmax(0, 1fr) auto;'));
  assert.ok(css.includes('.announcement-hero-copy p { display: block; }'));
  assert.ok(css.includes('.announcement-hero-tips { display: block; }'));
}

module.exports = [
  testAnnouncementLayoutPreservesTheOriginalTwoColumnContent,
  testAnnouncementLayoutKeepsReadableFullScreenSpacing,
];
