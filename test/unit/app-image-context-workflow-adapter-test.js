#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const moduleSource = fs.readFileSync(path.join(root, 'client/app/image-context-workflow.js'), 'utf8');

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
      if (parenDepth === 0) { bodyStart = appJs.indexOf('{', i); break; }
    }
  }
  let depth = 0;
  for (let i = bodyStart; i < appJs.length; i += 1) {
    if (appJs[i] === '{') depth += 1;
    else if (appJs[i] === '}') { depth -= 1; if (depth === 0) return appJs.slice(start, i + 1); }
  }
  throw new Error(`failed to extract ${name}`);
}

assert.ok(indexHtml.includes('client/app/image-context-workflow.js'), 'image context workflow module is loaded');
assert.ok(indexHtml.indexOf('client/app/image-context-workflow.js') < indexHtml.indexOf('./app.js'), 'image context workflow loads before app.js');
assert.ok(moduleSource.includes('createImageContextWorkflow'), 'image context module owns workflow');
assert.ok(appJs.includes('function getImageContextWorkflow()'), 'app has image context adapter');

for (const name of ['serializeImageAttachment', 'normalizeImageContextForStorage', 'getUserAttachmentContextFromNode', 'getLatestUploadedImageContext', 'setImageContext', 'getAssistantImageContext']) {
  const source = extract(name);
  assert.ok(source.includes('getImageContextWorkflow().'), `${name} delegates to image context workflow`);
}
for (const name of ['persistImageAttachmentRefs', 'buildUploadedImageContext', 'persistGenericAttachmentSrc', 'buildUserAttachmentContext', 'restoreUserAttachmentsFromContext', 'getLatestUploadedImageAttachments', 'restoreImageAttachmentsFromContext', 'getPreviousImageAttachments', 'getPreviousImageAsAttachment']) {
  const source = extract(name, true);
  assert.ok(source.includes('getImageContextWorkflow().'), `${name} delegates to image context workflow`);
}
assert.ok(!appJs.includes('function serializeImageAttachment(e){if(!e||!isImageFile(e))return null'), 'app no longer keeps serialize image attachment implementation');
assert.ok(!appJs.includes('function getLatestUploadedImageContext(e=state.activeSessionId){const t=state.sessions.find'), 'app no longer keeps latest uploaded image context implementation');
assert.ok(!appJs.includes('async function getPreviousImageAttachments(e=state.activeSessionId,t=null,s="",n=[]){const a=parseImageReferenceId'), 'app no longer keeps previous image attachments implementation');

console.log('app image context workflow adapter ok');
