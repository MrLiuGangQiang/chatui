#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const chatWorkflow = fs.readFileSync(path.join(root, 'client/app/chat-workflow.js'), 'utf8');
const scrollFocusWorkflow = fs.readFileSync(path.join(root, 'client/app/scroll-focus-workflow.js'), 'utf8');
const reasoningWorkflow = fs.readFileSync(path.join(root, 'client/app/reasoning-workflow.js'), 'utf8');

assert.match(
  app,
  /function renderActiveSession\(\)[\s\S]*state\.userScrollLocked=!1[\s\S]*state\.streamFocusLocked=!1[\s\S]*scheduleSessionTailFocusAfterLayout\(\{settleMs:\[120,320,700,1200\],quietMs:90,maxMs:1600\}\)/,
  'switching/rendering a session resets stale manual scroll state and waits for layout-stable settling before final tail focus',
);
assert.match(
  scrollFocusWorkflow,
  /function getSessionTailAnchor\(\)[\s\S]*querySelectorAll\("\.message"\)[\s\S]*function ensureTailScrollSpace[\s\S]*--session-tail-scroll-space[\s\S]*function focusSessionTail\(e=\{\}\)[\s\S]*ensureTailScrollSpace\(s\)[\s\S]*pinNodeBottomToTarget\(n,\{margin:s\}\)/,
  'session tail focus anchors the last rendered message visually and adds enough tail scroll space above the fixed composer',
);
assert.match(
  scrollFocusWorkflow,
  /function scheduleSessionTailFocusAfterLayout\(e=\{\}\)[\s\S]*ResizeObserver[\s\S]*MutationObserver[\s\S]*sessionTailFocusCleanup=\(\)=>[\s\S]*cancelSessionTailFocusAfterLayout/,
  'session switch tail focus observes post-render layout changes before final positioning',
);
assert.ok(
  !scrollFocusWorkflow.includes('const s=u();'),
  'layout-stability snapshot must not redeclare s and shadow the outer scrollVersion token',
);
assert.match(
  scrollFocusWorkflow,
  /function scrollToBottom\(e=!0,t=\{\}\)[\s\S]*state\.programmaticScrollUntil=Date\.now\(\)\+180[\s\S]*requestAnimationFrame[\s\S]*i\.forEach/,
  'programmatic bottom scroll is suppressed from manual-scroll detection and has delayed settling',
);
assert.match(
  scrollFocusWorkflow,
  /function markManualMessageScroll[\s\S]*Math\.abs\(Number\(e\.deltaY\|\|0\)\)>1[\s\S]*!r&&\(i\|\|o\)/,
  'manual wheel/touch/scrollbar drag pauses streaming focus, while programmatic scroll is ignored',
);
assert.match(
  scrollFocusWorkflow,
  /function settleActiveOutput\(e,t=\{\}\)[\s\S]*requestAnimationFrame[\s\S]*setTimeout[\s\S]*150/,
  'active output has delayed final settling for markdown/mermaid/image height changes',
);
assert.match(
  chatWorkflow,
  /async function sendChat[\s\S]*noScroll:!shouldFollowScroll\(\),streamKind:"chat"/,
  'first streaming response follows while the user has not manually scrolled away',
);
assert.match(
  chatWorkflow,
  /async function sendChat[\s\S]*updateMessage\(g,C,\{[\s\S]*noScroll:!shouldFollowScroll\(\)[\s\S]*followActive:shouldFollowScroll\(\)[\s\S]*settleActiveOutput\(g,\{margin:72\}\)/,
  'final response follows and then settles if the user has not manually scrolled away',
);
assert.match(
  app,
  /async function sendChat\([^)]*\)\{return getChatWorkflow\(\)\.sendChat\(e,t,s,n\)\}/,
  'app sendChat remains a thin adapter',
);
assert.match(
  app,
  /function prepareRegeneratedResponse[\s\S]*state\.userScrollLocked=!1[\s\S]*armStreamingOutputFocus\(s,o,\{margin:72,clearStaleFocus:!0\}\)/,
  'regenerate creates a fresh streaming focus and clears stale manual scroll lock',
);
assert.ok(!chatWorkflow.includes('noScroll:Number.isFinite(n.replaceAssistantIndex)||!shouldFollowScroll(),streamKind:"chat"'), 'replaceAssistantIndex must not disable streaming follow');
assert.ok(!chatWorkflow.includes('noScroll:Number.isFinite(n.replaceAssistantIndex),runToken:o.token'), 'replaceAssistantIndex must not disable live display streaming follow');


assert.match(
  scrollFocusWorkflow,
  /function scrollToActiveOutput\(e,t=\{\}\)\s*\{[\s\S]*!1===t\.force[\s\S]*return[\s\S]*lockToStreamingOutput\(e,t\)/,
  'force:false must be honored so status/reasoning updates cannot steal viewport focus',
);
assert.match(
  app,
  /function scrollToActiveOutput\([^)]*\)\{return getScrollFocusWorkflow\(\)\.scrollToActiveOutput\(e,t\)\}/,
  'app scrollToActiveOutput remains a thin adapter',
);
assert.match(
  reasoningWorkflow,
  /function updateReasoning[\s\S]*scrollToActiveOutput\(e,\{force:s\.forceScroll\?\?!1,active:!0===s\.followActive\}\)/,
  'reasoning updates default to no forced scroll and only update active output when explicitly following',
);
assert.match(
  app,
  /function updateReasoning\([^)]*\)\{return getReasoningWorkflow\(\)\.updateReasoning\(e,t,s\)\}/,
  'app updateReasoning remains a thin adapter',
);

console.log('focus follow contract ok');
