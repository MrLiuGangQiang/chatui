#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function extractFunctionSource(name) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const bodyStart = appJs.indexOf('{', start);
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

const attachmentDelegates = ['formatBytes', 'isCompressibleRasterImage', 'isImageFile', 'parseImageContext'];
for (const name of attachmentDelegates) {
  const source = extractFunctionSource(name);
  assert.ok(source.includes('window.ChatUICore.attachments.'), `${name} delegates to core attachments`);
  assert.ok(!source.includes('window.ChatUICore?.'), `${name} does not keep optional fallback path`);
}

const imageReferenceDelegates = ['normalizeImageSelection', 'sanitizeImageReferencePart', 'makeImageReferenceId', 'parseImageReferenceId', 'makeImageItemId', 'normalizeSelectedImageIds', 'resolveImageSelectionFromIds'];
for (const name of imageReferenceDelegates) {
  const source = extractFunctionSource(name);
  assert.ok(source.includes('window.ChatUICore.imageReferences.'), `${name} delegates to core image references`);
  assert.ok(!source.includes('window.ChatUICore?.'), `${name} does not keep optional fallback path`);
}

assert.ok(appJs.includes('const IMAGE_REFERENCE_PREFIX=window.ChatUICore.imageReferences.IMAGE_REFERENCE_PREFIX'), 'image reference constants come from core module');
assert.ok(!appJs.includes('String(e||"").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,96)||"latest"'), 'app no longer keeps sanitize image reference fallback');
assert.ok(!appJs.includes('e.type.startsWith("image/")||/\\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(e.name)'), 'app no longer keeps isImageFile fallback');
assert.ok(!appJs.includes('s.map(e=>Number(e)).filter(e=>Number.isInteger(e)&&e>=1'), 'app no longer keeps normalizeImageSelection fallback');

console.log('app image attachment helper adapter ok');
