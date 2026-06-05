#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const moduleSource = fs.readFileSync(path.join(root, 'client/app/session-ui-workflow.js'), 'utf8');
function extract(name, asyncFn=false){const marker=`${asyncFn?'async ':''}function ${name}(`; const start=appJs.indexOf(marker); assert.ok(start>=0,`${name} exists`); const ps=appJs.indexOf('(',start); let pd=0,bs=-1; for(let i=ps;i<appJs.length;i++){if(appJs[i]==='(')pd++; else if(appJs[i]===')'){pd--; if(pd===0){bs=appJs.indexOf('{',i); break;}}} let d=0; for(let i=bs;i<appJs.length;i++){if(appJs[i]==='{')d++; else if(appJs[i]==='}'){d--; if(d===0)return appJs.slice(start,i+1);}} throw new Error(name)}
assert.ok(indexHtml.includes('client/app/session-ui-workflow.js'), 'session ui workflow is loaded');
assert.ok(indexHtml.indexOf('client/app/session-ui-workflow.js') < indexHtml.indexOf('./app.js'), 'session ui loads before app.js');
assert.ok(moduleSource.includes('createSessionUiWorkflow'), 'module owns workflow');
assert.ok(appJs.includes('function getSessionUiWorkflow()'), 'app has ui adapter');
for(const name of ['renderSessionList','newSession','beginRenameSession','renderSessionModelArea','setSessionChatModel']) assert.ok(extract(name).includes('getSessionUiWorkflow().'), `${name} delegates`);
for(const name of ['deleteSession','clearAllSessions']) assert.ok(extract(name,true).includes('getSessionUiWorkflow().'), `${name} delegates`);
assert.ok(!appJs.includes('function renderSessionList(){const e=$("sessionList")'), 'app no longer keeps renderSessionList implementation');
assert.ok(!appJs.includes('function newSession(){saveActivePromptDraft()'), 'app no longer keeps newSession implementation');
assert.ok(!appJs.includes('function clearAllSessions(){if(!state.sessions.length)return'), 'app no longer keeps clearAllSessions implementation');
console.log('app session ui workflow adapter ok');
