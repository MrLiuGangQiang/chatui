'use strict';

// Presence badge appearance gate: the online-user badge must stay a rounded
// rectangle (12px corners, matching the topbar utility buttons) with the
// breathing status dot, and keep the reduced-motion accessibility guard.
// It must not regress to the legacy fully-round 999px pill shape.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readPresenceCss() {
  return fs.readFileSync(path.join(__dirname, '../../styles/presence.css'), 'utf8');
}

function testPresenceBadgeUsesRoundedRectangleBorder() {
  const css = readPresenceCss();
  const block = /\.presence-indicator\s*\{[\s\S]*?\}/.exec(css);
  assert.ok(block, 'the .presence-indicator rule must exist in styles/presence.css');
  assert.match(block[0], /border-radius:\s*12px;/,
    'the online-user badge must keep 12px rounded-rectangle corners like the topbar utility buttons');
  assert.doesNotMatch(block[0], /border-radius:\s*999px/,
    'the online-user badge must not regress to the fully-rounded pill shape');
}

function testPresenceDotKeepsBreathingPulseAndReducedMotionGuard() {
  const css = readPresenceCss();
  assert.match(css, /\.presence-dot\s*\{[\s\S]*?animation:\s*presence-dot-breathe[\s\S]*?\}/,
    'the status dot must keep its breathing pulse so the badge reads as a live presence signal');
  assert.match(css, /@keyframes presence-dot-breathe/,
    'the breathing keyframes must stay defined');
  const reducedMotion = /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\}\s*\}/.exec(css);
  assert.ok(reducedMotion, 'a prefers-reduced-motion guard must exist');
  assert.match(reducedMotion[0], /\.presence-dot\s*\{\s*animation:\s*none/,
    'reduced-motion users must not see the breathing animation');
}

module.exports = [testPresenceBadgeUsesRoundedRectangleBorder, testPresenceDotKeepsBreathingPulseAndReducedMotionGuard];