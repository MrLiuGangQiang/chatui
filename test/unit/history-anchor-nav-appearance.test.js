'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testHistoryAnchorDirectoryUsesCompactIndexedTwoLineEntries() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/features/history-anchor-nav.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');

  assert.match(source, /const RAIL_ROW_HEIGHT = 30;/,
    'the compact directory must keep the rail aligned with its two-line item rows');
  assert.match(source, /history-anchor-title-wrap/);
  assert.match(source, /history-anchor-eyebrow/);
  assert.match(source, /history-anchor-item-index/,
    'every directory entry needs a stable ordinal marker for fast scanning');
  assert.match(source, /items\.forEach\(\(item, index\) => \{[\s\S]*?String\(index \+ 1\)\.padStart\(2, '0'\)/,
    'the ordinal must be computed from the render-loop index, not an undefined outer value');

  assert.match(css, /\.history-anchor-panel\{[\s\S]*?width:min\(228px/,
    'the expanded directory must stay narrow and compact on desktop');
  assert.match(css, /\.history-anchor-text\{[\s\S]*?text-overflow:ellipsis;[\s\S]*?white-space:nowrap;/,
    'long question titles must stay on one line and use an ellipsis');
  assert.match(css, /\.history-anchor-item-index\{[\s\S]*?font-variant-numeric:tabular-nums;/,
    'ordinal markers must remain visually stable while scanning');
  assert.match(css, /\.history-anchor-rail-bars\{[\s\S]*?gap:2px;/,
    'the rail must use the same inter-item gap as the directory list');
  assert.match(css, /\.history-anchor-rail-bar\{[\s\S]*?box-sizing:border-box;/,
    'rail rows must share the same box model as directory rows');
  assert.match(css, /\.history-anchor-item\{[\s\S]*?box-sizing:border-box;/,
    'directory rows must share the same box model as rail rows');
}

module.exports = [testHistoryAnchorDirectoryUsesCompactIndexedTwoLineEntries];
