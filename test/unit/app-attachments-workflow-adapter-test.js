#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const moduleSource = fs.readFileSync(path.join(root, 'client/app/attachments-workflow.js'), 'utf8');

function extract(name, asyncFn = false) {
  const marker = `${asyncFn ? 'async ' : ''}function ${name}(`;
  const start = appJs.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
  const paramsStart = appJs.indexOf('(', start);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = paramsStart; i < appJs.length; i += 1) {
    if (appJs[i] === '(') parenDepth += 1;
    else if (appJs[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        bodyStart = appJs.indexOf('{', i);
        break;
      }
    }
  }
  assert.ok(bodyStart >= 0, `${name} body found`);
  let depth = 0;
  for (let i = bodyStart; i < appJs.length; i += 1) {
    if (appJs[i] === '{') depth += 1;
    else if (appJs[i] === '}') {
      depth -= 1;
      if (depth === 0) return appJs.slice(start, i + 1);
    }
  }
  throw new Error(`failed to extract ${name}`);
}

assert.ok(indexHtml.includes('client/app/attachments-workflow.js'), 'attachments workflow module is loaded');
assert.ok(indexHtml.indexOf('client/app/attachments-workflow.js') < indexHtml.indexOf('./app.js'), 'attachments workflow loads before app.js');
assert.ok(moduleSource.includes('createAttachmentsWorkflow'), 'workflow module owns implementation');
assert.ok(appJs.includes('function getAttachmentWorkflow()'), 'app.js has workflow adapter');

const delegated = ['renderAttachments', 'renderUploadProgress', 'setUploadTask', 'finishUploadProgressSoon', 'setUploadPhase', 'setUploadPhaseProgress', 'startTimedUploadPhase', 'readFileAsDataURL', 'readFileAsArrayBuffer', 'clearAttachments'];
for (const name of delegated) {
  const source = extract(name);
  assert.ok(source.includes('getAttachmentWorkflow().'), `${name} delegates to workflow`);
  assert.ok(!source.includes('querySelectorAll') && !source.includes('FileReader') && !source.includes('state.uploadTasks.find'), `${name} no longer keeps root implementation`);
}
for (const name of ['compressImageIfNeeded', 'convertBmpToPng', 'readFileAsText', 'extractAttachmentText', 'addFiles']) {
  const source = extract(name, true);
  assert.ok(source.includes('getAttachmentWorkflow().'), `${name} delegates to workflow`);
}
for (const name of ['inferMimeByName', 'isPdfFile', 'isOfficeFile', 'isProbablyTextFile', 'looksBinary']) {
  const source = extract(name);
  assert.ok(source.includes('window.ChatUIAppAttachmentsWorkflow.'), `${name} delegates to workflow static helper`);
}

assert.ok(!appJs.includes('function inferMimeByName(e){return{txt:'), 'app.js no longer keeps MIME map implementation');
assert.ok(!appJs.includes('function addFiles(e){const t=[...e];if(!t.length)return;state.uploadTasks='), 'app.js no longer keeps addFiles implementation');
assert.ok(!appJs.includes('function renderAttachments(){const e=$("attachmentBar")'), 'app.js no longer keeps attachment bar render implementation');

console.log('app attachments workflow adapter ok');
