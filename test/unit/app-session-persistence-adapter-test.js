#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const moduleSource = fs.readFileSync(path.join(root, 'client/app/session-persistence.js'), 'utf8');

function extract(name) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const ps = appJs.indexOf('(', start); let pd = 0, bs = -1;
  for (let i = ps; i < appJs.length; i += 1) {
    if (appJs[i] === '(') pd += 1;
    else if (appJs[i] === ')') { pd -= 1; if (pd === 0) { bs = appJs.indexOf('{', i); break; } }
  }
  let d = 0;
  for (let i = bs; i < appJs.length; i += 1) {
    if (appJs[i] === '{') d += 1;
    else if (appJs[i] === '}') { d -= 1; if (d === 0) return appJs.slice(start, i + 1); }
  }
  throw new Error(`failed ${name}`);
}

assert.ok(indexHtml.includes('client/app/session-persistence.js'), 'session persistence module is loaded');
assert.ok(indexHtml.indexOf('client/app/session-persistence.js') < indexHtml.indexOf('./app.js'), 'session persistence loads before app.js');
assert.ok(moduleSource.includes('compactAdjacentDuplicateMessages'), 'module owns persistence helpers');

for (const name of ['normalizeMessageOrderFields','messageSortIndex','roleSortWeight','sortCanonicalMessages','cloneMessageList','mergeMessageMeta','compactAdjacentDuplicateMessages','compactDisplayItems','stripGeneratedImageActionMarkup','stripTransientBlobUrlsFromHtml','sanitizeAttachmentContextForStorage','sanitizeStoredDisplayItem','sanitizeStoredMessage','safeSetJsonStorage','stripLargePayloadData','compactJobForStorage','safeSetJobStorage']) {
  const source = extract(name);
  assert.ok(source.includes('window.ChatUIAppSessionPersistence.'), `${name} delegates to session persistence`);
}
assert.ok(!appJs.includes('function safeSetJsonStorage(e,t,s=80){if(window.ChatUIApp?.persistence'), 'app no longer keeps safeSetJsonStorage fallback');
assert.ok(!appJs.includes('function compactAdjacentDuplicateMessages(e=[]){const t=[]'), 'app no longer keeps compact adjacent implementation');
assert.ok(!appJs.includes('function stripTransientBlobUrlsFromHtml(e=""){return stripGeneratedImageActionMarkup'), 'app no longer keeps strip transient blob implementation');

console.log('app session persistence adapter ok');
