#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const browserUiPath = path.join(root, 'client/ui/browser.js');
const browserUi = fs.readFileSync(browserUiPath, 'utf8');

assert.ok(browserUi.includes('ChatUIFileActions'), 'browser ui adapter reads shared file actions');
assert.ok(browserUi.includes('ChatUIRealtimeRenderer'), 'browser ui adapter reads shared realtime renderer');
assert.ok(browserUi.includes('ChatUIScrollController'), 'browser ui adapter reads shared scroll helpers');
assert.ok(browserUi.includes('ChatUIMessageRenderer'), 'browser ui adapter reads shared message renderer');
assert.ok(browserUi.includes('ChatUIMessageActions'), 'browser ui adapter reads shared message actions');
assert.ok(browserUi.includes('ChatUIImageActions'), 'browser ui adapter reads shared image actions');
assert.ok(!browserUi.includes('function answerFilename'), 'browser ui adapter does not duplicate file action logic');
assert.ok(!browserUi.includes('function createRealtimeRenderer'), 'browser ui adapter does not duplicate realtime logic');
assert.ok(!browserUi.includes('function activeOutputBottomTarget'), 'browser ui adapter does not duplicate scroll logic');
assert.ok(!browserUi.includes('function copyText'), 'browser ui adapter does not duplicate message action logic');
assert.ok(!browserUi.includes('function copyImageButtonHtml'), 'browser ui adapter does not duplicate image action logic');

const context = {
  window: {
    ChatUIFileActions: { answerFilename: () => 'answer.md' },
    ChatUIRealtimeRenderer: { createRealtimeRenderer: () => ({}) },
    ChatUIScrollController: { activeOutputBottomTarget: () => 100 },
    ChatUIMessageRenderer: { renderUserMessageParts: () => '<p>ok</p>' },
    ChatUIMessageActions: { copyText: async () => {} },
    ChatUIImageActions: {
      downloadImageButtonHtml: () => '<button data-download-image="1"></button>',
      shareImageButtonHtml: () => '<button data-share-image="1"></button>',
      copyImageButtonHtml: (href, filename) => `<button data-copy-image="1" data-persisted-href="${href}" data-filename="${filename}" aria-label="复制图片"></button>`,
    },
  },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(browserUi, context, { filename: browserUiPath });

assert.ok(context.window.ChatUI, 'browser ui namespace exists');
assert.strictEqual(context.window.ChatUI.fileActions.answerFilename(), 'answer.md');
assert.ok(context.window.ChatUI.realtime?.createRealtimeRenderer, 'realtime renderer is exported');
assert.strictEqual(context.window.ChatUI.scroll.activeOutputBottomTarget(), 100);
assert.strictEqual(context.window.ChatUI.messages.renderUserMessageParts(), '<p>ok</p>');
assert.ok(context.window.ChatUI.actions?.copyText, 'message actions are exported');
assert.ok(context.window.ChatUI.imageActions?.downloadImageButtonHtml, 'image download helper is exported');
assert.ok(context.window.ChatUI.imageActions?.shareImageButtonHtml, 'image share helper is exported');
assert.ok(context.window.ChatUI.imageActions?.copyImageButtonHtml, 'image copy helper is exported');

const copyHtml = context.window.ChatUI.imageActions.copyImageButtonHtml('indexeddb://img1', 'a.png');
assert.ok(copyHtml.includes('data-copy-image="1"'));
assert.ok(copyHtml.includes('data-persisted-href="indexeddb://img1"'));
assert.ok(copyHtml.includes('data-filename="a.png"'));
assert.ok(copyHtml.includes('aria-label="复制图片"'));

console.log('browser ui bundle ok');
