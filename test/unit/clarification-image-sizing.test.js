'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');

function testClarificationCandidatesStayCompact() {
  assert.match(css, /\.clarification-presentation\{[\s\S]*?width:min\(540px,calc\(100vw - 112px\)\)|width:min\(720px,calc\(100vw - 112px\)\)/);
  assert.match(css, /\.markdown-body \.clarification-image-list\{[\s\S]*?grid-template-columns:repeat\(3,minmax\(0,100px\)\)/);
  assert.match(css, /\.clarification-choice-media\{[\s\S]*?aspect-ratio:1\/1/);
}

module.exports = [testClarificationCandidatesStayCompact];
