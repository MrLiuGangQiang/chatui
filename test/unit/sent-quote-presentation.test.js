'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '../../styles/messages.css');

function ruleBody(css, selectorPattern) {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`, 'is'));
  return match ? match[1] : '';
}

function testExplicitUserQuotePreviewRemainsVisible() {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const generic = ruleBody(css, String.raw`\.message\.user\s+\.sent-quote-preview`);
  assert.ok(!/display\s*:\s*none\s*!important/i.test(generic),
    'a manually selected quote must remain visible in the sent user message');
}

function testInternalPendingQuoteMetadataIsHiddenWithoutStretchingTheBubble() {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const internal = ruleBody(css, String.raw`\.message\.user\s+\.sent-quote-preview\.pending-clarification-source`);
  const content = ruleBody(css, String.raw`\.message\.user\.has-quote\s+\.content`);
  const bubble = ruleBody(css, String.raw`\.message\.user\.has-quote\s+\.bubble`);
  assert.match(internal, /display\s*:\s*none\s*!important/i,
    'only the internal clarification projection may be hidden');
  assert.match(content, /width\s*:\s*auto\s*!important/i,
    'quote metadata must not force the actual user body to full width');
  assert.ok(!/width\s*:\s*100%\s*!important/i.test(content));
  assert.match(bubble, /width\s*:\s*(?:fit-content|auto)\s*!important/i);
}

module.exports = [
  testExplicitUserQuotePreviewRemainsVisible,
  testInternalPendingQuoteMetadataIsHiddenWithoutStretchingTheBubble,
];
