#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function functionBody(name) {
  const start = app.indexOf(`function ${name}`) >= 0 ? app.indexOf(`function ${name}`) : app.indexOf(`async function ${name}`);
  assert(start >= 0, `${name} exists`);
  const marker = name === 'regenerateAssistantMessage' ? 'function normalizeRenderedCopyText' : `function ${name}`;
  const end = name === 'regenerateAssistantMessage' ? app.indexOf(marker, start) : -1;
  return app.slice(start, end > start ? end : app.length);
}

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
assert.ok(
  !app.includes('l=s.scrollHeight-s.scrollTop-s.clientHeight') && !app.includes('Math.max(o.bottom-r,l)'),
  'active-output pinning must not use whole conversation bottom gap; regenerating an early message would otherwise jump to the session bottom on every token',
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
  /function markManualMessageScroll[\s\S]*Math\.abs\(Number\(e\.deltaY\|\|0\)\)>1[\s\S]*state\.streamFocusLocked=!1[\s\S]*state\.userScrollLocked=!0/,
  'manual wheel/touch/scrollbar drag pauses streaming focus in either direction',
);
const regenerateBody = functionBody('regenerateAssistantMessage');
assert.doesNotMatch(
  regenerateBody,
  /finally\{[\s\S]*\$\("prompt"\)\.focus/,
  'regenerate completion must not refocus the composer because mobile browsers may scroll to the bottom',
);
assert.match(
  regenerateBody,
  /finally\{[\s\S]*updateResumeStreamButton\(\)/,
  'regenerate completion refreshes follow UI without stealing scroll focus',
);

console.log('regenerate autofollow contract ok');
