const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testFollowupQuoteDoesNotChangeUserBodyAlignment() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');
  assert.ok(
    /\.message\.user \.content,\s*\.message\.user \.plain-text\s*\{[^}]*text-align\s*:\s*start!important;/is.test(css),
    'user message body alignment must be stable regardless of quote/follow-up metadata',
  );
  assert.ok(
    !/\.message\.user\.has-quote[^}]*text-align\s*:\s*right/is.test(css),
    'has-quote must not right-align the user message body',
  );
  assert.ok(
    !/\.message\.user\.has-quote\s+\.content\s*>\s*:not\(\.sent-quote-preview\)[^}]*margin-left\s*:\s*auto/is.test(css),
    'has-quote must not push body children to the right',
  );
}

module.exports = [
  testFollowupQuoteDoesNotChangeUserBodyAlignment,
];
