#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const context = { window: {}, console };
context.window.window = context.window;
vm.createContext(context);
for (const file of [
  'client/core/http.js',
  'client/core/reasoning.js',
  'client/core/models.js',
  'client/core/image-references.js',
  'client/core/image-route-context.js',
  'client/core/attachments.js',
  'client/core/browser.js',
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

const route = context.window.ChatUICore.imageRouteContext.inferLocalImageRoute('生成两张图片：一个红色圆点，一个黑色圆点');
assert.strictEqual(route.mode, 'image');
assert.strictEqual(route.target, 'new');
assert.strictEqual(route.contextualImagePrompt, '生成两张图片：一个红色圆点，一个黑色圆点');
assert.strictEqual(context.window.ChatUICore.imageRouteContext.inferLocalImageRoute('不要生成图片，只描述方案'), null);
const editRoute = context.window.ChatUICore.imageRouteContext.inferLocalImageRoute('修改上一张图的背景');
assert.strictEqual(editRoute.mode, 'edit_image');
assert.strictEqual(editRoute.target, 'previous');
console.log('browser core local image route ok');
