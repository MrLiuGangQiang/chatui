'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const messagesCss = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');
const flatThemeCss = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');

function ruleBody(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `missing CSS rule: ${selector}`);
  const bodyStart = css.indexOf('{', start);
  const bodyEnd = css.indexOf('}', bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, `invalid CSS rule: ${selector}`);
  return css.slice(bodyStart + 1, bodyEnd);
}

function testStreamingMessageSpacingKeepsActionRowGeometryStable() {
  const streaming = ruleBody(flatThemeCss, '.message[data-streaming="1"] .msg-actions');
  const pending = ruleBody(flatThemeCss, '.message.assistant[data-persist="0"] .msg-actions');

  for (const [state, body] of [['pending', pending], ['streaming', streaming]]) {
    assert.match(body, /display:flex!important/, `${state} action row must stay in layout`);
    assert.match(body, /height:26px!important/, `${state} action row must reserve final height`);
    assert.match(body, /visibility:hidden!important/, `${state} action controls must stay hidden`);
    assert.doesNotMatch(body, /display:none!important|height:0!important|margin:0!important/,
      `${state} action row must not collapse and change the message gap`);
  }

  assert.doesNotMatch(messagesCss, /\.message:has\(\.msg-actions\):not\(\[data-streaming="1"\]\)[^{]*\{[^}]*margin-bottom:/s,
    'message spacing must not change when the streaming attribute is toggled');
}

module.exports = [testStreamingMessageSpacingKeepsActionRowGeometryStable];