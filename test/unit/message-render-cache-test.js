#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const appPath = path.join(root, 'app.js');
const app = fs.readFileSync(appPath, 'utf8');

function extractFunctionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in app.js`);
  const bodyStart = app.indexOf('){', start) + 1;
  assert.ok(bodyStart > 0, `${name} body starts`);
  let depth = 0;
  for (let i = bodyStart; i < app.length; i += 1) {
    const ch = app[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, i + 1);
    }
  }
  throw new Error(`failed to extract ${name}`);
}

class ContentNode {
  constructor() { this.innerHTML = ''; this.textContent = ''; }
}

class MessageNode {
  constructor() {
    this.dataset = {};
    this.content = new ContentNode();
    this.classList = { contains: name => name === 'assistant' };
    this.isConnected = true;
  }
  querySelector(selector) { return selector === '.content' ? this.content : null; }
}

const calls = { render: 0, enhance: 0, hydrate: 0, reset: 0 };
const context = {
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: cb => cb(),
  performance: { now: () => 0 },
  state: { activeSessionId: 's1', userScrollLocked: false, activeOutputNode: null, streamFocusLocked: false, scrollVersion: 0 },
  shouldSuppressRunUi: () => false,
  preserveMessageViewport: () => () => {},
  preserveMessageBottomAnchor: () => () => {},
  chatuiContentHash(value = '') {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
  },
  renderMarkdown(value) { calls.render += 1; return `<p>${value}</p>`; },
  renderUserMessageContent(value) { calls.render += 1; return `<p>user:${value}</p>`; },
  stripTransientBlobUrlsFromHtml: value => String(value || ''),
  bindInlineCopyButtons: () => {},
  enhanceRenderedMarkdown: () => { calls.enhance += 1; },
  hydrateMessageMedia: () => { calls.hydrate += 1; },
  resetMessageActionStates: () => { calls.reset += 1; },
  setMessageMetaText: () => {},
  chatuiShouldLazyRender: () => false,
  chatuiIsNearViewport: () => true,
  chatuiQueueLazyMessage: () => {},
  chatuiPerfNow: () => 0,
  chatuiLogLongTask: () => {},
  scrollToActiveOutput: () => {},
  scrollToBottom: () => {},
  updateResumeStreamButton: () => {},
  scrollTimer: null,
};
vm.createContext(context);
vm.runInContext([
  extractFunctionSource('updateMessage'),
  extractFunctionSource('updateMessageContentLight'),
].join('\n'), context, { filename: 'app.js#render-cache' });

const node = new MessageNode();
context.updateMessage(node, 'hello **world**', { rawText: 'hello **world**' });
assert.strictEqual(calls.render, 1, 'first final update renders markdown');
assert.strictEqual(calls.enhance, 1, 'first final update enhances markdown');
const renderedHash = node.dataset.renderedHash;
assert.strictEqual(node.dataset.enhancedHash, renderedHash, 'enhance cache stores content hash');

context.updateMessage(node, 'hello **world**', { rawText: 'hello **world**' });
assert.strictEqual(calls.render, 1, 'same final content does not render again');
assert.strictEqual(calls.enhance, 1, 'same final content does not enhance again');

context.updateMessage(node, 'changed', { rawText: 'changed' });
assert.strictEqual(calls.render, 2, 'changed content renders again');
assert.strictEqual(calls.enhance, 2, 'changed content enhances again');
assert.notStrictEqual(node.dataset.renderedHash, renderedHash, 'changed content updates hash');

const finalNode = new MessageNode();
finalNode.__markdownStreamingRenderer = {
  final(container, text) { container.innerHTML = `<p>${text}</p>`; return { enhanced: true, mode: 'full-rerender-final' }; },
};
context.updateMessage(finalNode, 'stream final', { rawText: 'stream final' });
assert.strictEqual(calls.render, 2, 'streaming final result is not rendered by outer update');
assert.strictEqual(calls.enhance, 2, 'streaming final enhanced marker skips outer enhance');
assert.strictEqual(finalNode.dataset.enhancedHash, finalNode.dataset.rawHash, 'streaming final enhanced marker stores final hash');

context.updateMessageContentLight(finalNode, 'stream final', { rawText: 'stream final', streamKind: 'status' });
assert.strictEqual(calls.render, 2, 'light update skips unchanged finalized assistant content');
assert.strictEqual(calls.enhance, 2, 'light update skips unchanged enhance');

console.log('message render cache ok');
