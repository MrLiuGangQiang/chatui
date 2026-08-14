'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');

function clarificationImageGridColumnDeclarations() {
  return [...css.matchAll(/\.markdown-body\s+\.clarification-image-list\s*\{([^}]*)\}/g)]
    .flatMap(([, body]) => [...body.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)])
    .map(([, value]) => value.replace(/\s+/g, ''));
}

function testClarificationCandidatesAutoFillAvailableWidth() {
  assert.match(css, /\.clarification-presentation\{[\s\S]*?width:min\(540px,calc\(100vw - 112px\)\)|width:min\(720px,calc\(100vw - 112px\)\)/);
  assert.deepStrictEqual(
    clarificationImageGridColumnDeclarations(),
    ['repeat(auto-fill,100px)!important'],
    'image clarification candidates must derive the per-row count from available width instead of fixed desktop or mobile column counts',
  );
  assert.match(css, /\.clarification-choice-media\{[\s\S]*?aspect-ratio:1\/1/);
}

function testClarificationChoiceProgressStaysLeftAligned() {
  const headingRule = css.match(/\.clarification-choice-heading\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(headingRule, /justify-content\s*:\s*flex-start/,
    'edit-target progress copy must stay beside the role label on the left');
  assert.match(headingRule, /text-align\s*:\s*left/,
    'wrapped edit-target progress copy must remain left aligned');
  assert.doesNotMatch(headingRule, /justify-content\s*:\s*space-between/,
    'edit-target progress copy must not be pushed to the right edge');
}

module.exports = [
  testClarificationCandidatesAutoFillAvailableWidth,
  testClarificationChoiceProgressStaysLeftAligned,
];
