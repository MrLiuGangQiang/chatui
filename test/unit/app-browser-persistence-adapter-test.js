#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const markdownUtilsPath = path.join(root, 'client/app/markdown-utils.js');
const displayItemsPath = path.join(root, 'client/app/display-items.js');
const persistencePath = path.join(root, 'client/app/persistence.js');
const browserAppPath = path.join(root, 'client/app/browser.js');
const markdownUtils = fs.readFileSync(markdownUtilsPath, 'utf8');
const displayItems = fs.readFileSync(displayItemsPath, 'utf8');
const persistence = fs.readFileSync(persistencePath, 'utf8');
const browserApp = fs.readFileSync(browserAppPath, 'utf8');

for (const name of [
  'stripLargeDataUrlsFromText',
  'sanitizeAttachmentContextForStorage',
  'sanitizeStoredDisplayItem',
  'sanitizeStoredMessage',
  'stripLargePayloadData',
  'compactJobForStorage',
]) {
  assert.ok(!browserApp.includes(`function ${name}`), `browser app must not duplicate ${name}`);
}
assert.ok(browserApp.includes('window.ChatUIAppPersistence'), 'browser app should mount shared persistence');

const context = { window: {}, AbortController };
vm.createContext(context);
vm.runInContext(markdownUtils, context, { filename: markdownUtilsPath });
vm.runInContext(displayItems, context, { filename: displayItemsPath });
vm.runInContext(persistence, context, { filename: persistencePath });
vm.runInContext(browserApp, context, { filename: browserAppPath });

const api = context.window.ChatUIApp.persistence;
assert.ok(api.sanitizeStoredMessage, 'browser app exports persistence api');
assert.strictEqual(api.stripLargeDataUrlsFromText('x data:image/png;base64,' + 'A'.repeat(2050)), 'x [attachment-data-omitted]');
assert.strictEqual(api.sanitizeStoredMessage({ content: 'ok', html: 'data:image/png;base64,' + 'A'.repeat(2050) }).html, '[attachment-data-omitted]');
const storage = { data: {}, setItem(k, v) { this.data[k] = v; }, removeItem(k) { delete this.data[k]; } };
assert.strictEqual(JSON.stringify(api.safeSetJsonStorage('k', [1, 2, 3], 2, storage)), '[2,3]');
assert.strictEqual(storage.data.k, '[2,3]');
api.safeSetJobStorage('job', { id: 'j1', payload: { big: 'data:image/png;base64,' + 'A'.repeat(2050) } }, storage);
assert.ok(storage.data.job.includes('[attachment-data-omitted]'));
console.log('app browser persistence adapter ok');
