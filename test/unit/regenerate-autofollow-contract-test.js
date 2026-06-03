#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

assert.ok(app.includes('function armStreamingOutputFocus'), 'shared streaming focus arming helper exists');
assert.match(
  app,
  /function prepareRegeneratedResponse[\s\S]*armStreamingOutputFocus\(s,o,\{margin:72,clearStaleFocus:!0\}\)[\s\S]*setTimeout\(\(\)=>\{armStreamingOutputFocus\(s,o,\{margin:72\}\)/,
  'regenerate path must set active output and lock to regenerated assistant node immediately and on next tick',
);
assert.match(
  app,
  /function prepareRegeneratedResponse[\s\S]*state\.userScrollLocked=!1[\s\S]*state\.autoScrollLocked=!0[\s\S]*clearTimeout\(scrollTimer\)/,
  'regenerate path clears stale stream focus conflicts before following',
);
assert.match(
  app,
  /function sendChat[\s\S]*setActiveOutputForSession\(i,g\)[\s\S]*lockToStreamingOutput\(g,\{margin:72\}\)/,
  'sendChat keeps ordinary stream follow behavior',
);
assert.match(
  app,
  /function shouldFollowScroll\(\)\{return!!state\.streamFocusLocked&&!state\.userScrollLocked\}/,
  'stream append/final follow remains gated by stream focus and manual scroll lock',
);
assert.match(
  app,
  /function markManualMessageScroll[\s\S]*state\.streamFocusLocked=!1[\s\S]*state\.userScrollLocked=!0[\s\S]*restoreStreamingFollowIfNearBottom/,
  'manual wheel/touch/scrollbar away still pauses follow and bottom restore remains wired',
);
assert.match(
  app,
  /focus\(\{preventScroll:!0\}\)/,
  'regenerate completion may restore input focus without stealing scroll',
);

console.log('regenerate autofollow contract ok');
