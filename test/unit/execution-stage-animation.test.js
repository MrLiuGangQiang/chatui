'use strict';

const assert = require('assert');
const fs = require('fs');

function testActiveExecutionStageShowsAnimatedDots() {
  const css = fs.readFileSync('styles/calm-theme.css', 'utf8');
  assert.ok(css.includes('.intent-reasoning-title.is-current-status::after'));
  assert.ok(css.includes('intentReasoningEllipsis'));
}

module.exports = [testActiveExecutionStageShowsAnimatedDots];

