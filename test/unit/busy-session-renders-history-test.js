#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');

assert.ok(appJs.includes('function currentMessagesSessionId()'), 'messages DOM tracks which session it represents');
assert.ok(appJs.includes('function markMessagesSession'), 'messages DOM is marked after canonical renders');

const ensureStart = appJs.indexOf('function ensureCanonicalDom');
assert.ok(ensureStart >= 0, 'ensureCanonicalDom exists');
const ensureBody = appJs.slice(ensureStart, appJs.indexOf('function renderActiveSession', ensureStart));
assert.ok(
  ensureBody.includes('state.busySessions.has(e.id)&&currentMessagesSessionId()===e.id&&canonicalDomSignature()===t'),
  'busy sessions should skip only repeat renders when the already-mounted DOM matches canonical messages',
);
assert.ok(ensureBody.includes('forceRenderCanonicalMessages(e)'), 'busy sessions can still render when switching back from another session');

const loadStart = appJs.indexOf('function loadChatHistory');
assert.ok(loadStart >= 0, 'loadChatHistory exists');
const loadBody = appJs.slice(loadStart, appJs.indexOf('function getChatWorkflow', loadStart));
assert.ok(
  loadBody.includes('e&&state.busySessions.has(t.id)&&currentMessagesSessionId()===t.id&&canonicalDomSignature()===messagesDomSignature(state.messages)?!0:'),
  'loadChatHistory should avoid repeated full rebuilds only when busy DOM already matches the session messages',
);
assert.ok(loadBody.includes('markMessagesSession(t)'), 'loadChatHistory marks the mounted session after rebuilding');
assert.ok(loadBody.includes('renderMessageFromCanonical'), 'loadChatHistory still renders canonical messages when switching back');

const renderStart = appJs.indexOf('function renderActiveSession');
const renderBody = appJs.slice(renderStart, appJs.indexOf('function saveActivePromptDraft', renderStart));
assert.ok(renderBody.includes('getActiveRun(e.id)||state.resumingJobs.has'), 'renderActiveSession should not repeatedly resume jobs that are already active/resuming');

console.log('busy session renders history ok');
