#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const moduleSource = fs.readFileSync(path.join(root, 'client/app/session-display.js'), 'utf8');

function extract(name) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const ps = appJs.indexOf('(', start); let pd = 0, bs = -1;
  for (let i = ps; i < appJs.length; i += 1) { if (appJs[i] === '(') pd += 1; else if (appJs[i] === ')') { pd -= 1; if (pd === 0) { bs = appJs.indexOf('{', i); break; } } }
  let d = 0;
  for (let i = bs; i < appJs.length; i += 1) { if (appJs[i] === '{') d += 1; else if (appJs[i] === '}') { d -= 1; if (d === 0) return appJs.slice(start, i + 1); } }
  throw new Error(`failed ${name}`);
}

assert.ok(indexHtml.includes('client/app/session-display.js'), 'session display module is loaded');
assert.ok(indexHtml.indexOf('client/app/session-display.js') < indexHtml.indexOf('./app.js'), 'session display loads before app.js');
assert.ok(moduleSource.includes('createSessionDisplayWorkflow'), 'module owns display workflow');
assert.ok(appJs.includes('function getSessionDisplayWorkflow()'), 'app has session display adapter');
for (const name of ['makeDisplayItem','persistSessionDisplay','saveSessionMessages','normalizeMessageForStorage','appendSessionDisplayMessage','updateSessionDisplayItem','persistDetachedResponse','replaceLastSessionDisplayMessage','syncActiveSession','saveSessionsMeta','loadSessions','sessionTitleHtml','getSessionReturnCount']) {
  const source = extract(name);
  assert.ok(source.includes('getSessionDisplayWorkflow().'), `${name} delegates to session display workflow`);
}
assert.ok(!appJs.includes('function appendSessionDisplayMessage(e,t,s,n={}){const a=state.sessions.find'), 'app no longer keeps append display implementation');
assert.ok(!appJs.includes('function saveSessionsMeta(){try{const e=state.sessions.map'), 'app no longer keeps sessions meta implementation');
assert.ok(!appJs.includes('function loadSessions(){let e=[];try{const t=readJsonStorage'), 'app no longer keeps load sessions implementation');
console.log('app session display adapter ok');
