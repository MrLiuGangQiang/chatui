#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const markdownUtilsPath = path.join(root, 'client/app/markdown-utils.js');
const displayItemsPath = path.join(root, 'client/app/display-items.js');
const browserAppPath = path.join(root, 'client/app/browser.js');
const markdownUtils = fs.readFileSync(markdownUtilsPath, 'utf8');
const displayItems = fs.readFileSync(displayItemsPath, 'utf8');
const browserApp = fs.readFileSync(browserAppPath, 'utf8');

assert.ok(!browserApp.includes('function compactDisplayItems'), 'browser app must not duplicate display item compaction');
assert.ok(!browserApp.includes('function makeDisplayItemId'), 'browser app must not duplicate display item id generation');
assert.ok(!browserApp.includes('function displayItemHasRichMedia'), 'browser app must not duplicate rich media detection');
assert.ok(browserApp.includes('window.ChatUIAppDisplayItems'), 'browser app should mount shared display items');

const context = { window: {}, AbortController };
vm.createContext(context);
vm.runInContext(markdownUtils, context, { filename: markdownUtilsPath });
vm.runInContext(displayItems, context, { filename: displayItemsPath });
vm.runInContext(browserApp, context, { filename: browserAppPath });

assert.strictEqual(context.window.ChatUIApp.displayItems, context.window.ChatUIAppDisplayItems, 'browser app reuses shared display items object');
assert.strictEqual(context.window.ChatUIApp.displayItems.displayItemHasRichMedia({ html: '<img class="generated-thumb" />' }), true);
assert.strictEqual(context.window.ChatUIApp.displayItems.displayItemHasRichMedia({ html: '<p>x</p>' }), false);
assert.strictEqual(context.window.ChatUIApp.displayItems.compactDisplayItems([{ role: 'assistant', rawText: 'x' }, { role: 'assistant', rawText: 'x' }]).length, 1);
console.log('app browser display items adapter ok');
