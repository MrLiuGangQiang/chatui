'use strict';

const assert = require('assert');
const { createImageActionsWorkflow } = require('../../client/app/image-actions-workflow');

function actionElement(href = 'indexeddb://image-1') {
  return {
    dataset: { persistedHref: href },
    getAttribute(name) {
      return name === 'href' ? href : '';
    },
  };
}

function createClipboardItemClass() {
  return class FakeClipboardItem {
    constructor(representations) {
      this.representations = representations;
    }
  };
}

function createWorkflow({ getImageBlob, write, toast, extra = {} }) {
  const ClipboardItem = createClipboardItemClass();
  const navigator = { clipboard: { write } };
  const window = { isSecureContext: true };
  const workflow = createImageActionsWorkflow({
    document: {},
    window,
    navigator,
    ClipboardItem,
    getImageBlob,
    toast,
    URL: {},
    fetch: async () => { throw new Error('unexpected fetch'); },
    ...extra,
  });
  return { workflow, ClipboardItem };
}

async function testImageClipboardWriteStartsBeforeIndexedDbReadSettles() {
  let resolveImage;
  const imagePromise = new Promise(resolve => { resolveImage = resolve; });
  let writeCalls = 0;
  let representation;
  const toasts = [];
  const { workflow } = createWorkflow({
    getImageBlob: () => imagePromise,
    write: async items => {
      writeCalls += 1;
      representation = items[0].representations['image/png'];
      await representation;
    },
    toast: message => toasts.push(message),
  });

  const copyPromise = workflow.copyImageActionElement(actionElement());
  assert.strictEqual(writeCalls, 1, 'clipboard.write must start during the click task, before IndexedDB resolves');
  assert.ok(representation && typeof representation.then === 'function', 'clipboard representation should be a promise');

  resolveImage(new Blob(['png-bytes'], { type: 'image/png' }));
  await copyPromise;
  assert.strictEqual(toasts.at(-1), '图片已复制');
}

async function testImageClipboardNormalizesNonPngToPng() {
  const writes = [];
  const toasts = [];
  let sequence = 0;
  const URL = {
    createObjectURL() { sequence += 1; return `blob:test-${sequence}`; },
    revokeObjectURL() {},
  };
  class FakeImage {
    constructor() {
      this.naturalWidth = 2;
      this.naturalHeight = 1;
    }
    set src(value) {
      this._src = value;
      queueMicrotask(() => this.onload?.());
    }
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext() { return { drawImage() {} }; },
    toBlob(callback, type) { callback(new Blob(['converted-png'], { type })); },
  };
  const { workflow } = createWorkflow({
    getImageBlob: async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    write: async items => {
      const item = items[0];
      writes.push({ type: Object.keys(item.representations)[0], blob: await item.representations['image/png'] });
    },
    toast: message => toasts.push(message),
    extra: {
      Image: FakeImage,
      URL,
      document: { createElement(tag) { assert.strictEqual(tag, 'canvas'); return canvas; } },
    },
  });

  await workflow.copyImageActionElement(actionElement());
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].type, 'image/png');
  assert.strictEqual(writes[0].blob.type, 'image/png');
  assert.strictEqual(toasts.at(-1), '图片已复制');
}

async function testImageClipboardRemainsDisabledOnInsecureHttp() {
  let writeCalls = 0;
  const toasts = [];
  const { workflow } = createWorkflow({
    getImageBlob: async () => new Blob(['png-bytes'], { type: 'image/png' }),
    write: async () => { writeCalls += 1; },
    toast: message => toasts.push(message),
    extra: { window: { isSecureContext: false } },
  });

  assert.strictEqual(workflow.canWriteImageClipboard(), false);
  await workflow.copyImageActionElement(actionElement());
  assert.strictEqual(writeCalls, 0);
  assert.strictEqual(toasts.at(-1), '复制图片需要 HTTPS 或 localhost，当前局域网 HTTP 地址不支持');
}

module.exports = [
  testImageClipboardWriteStartsBeforeIndexedDbReadSettles,
  testImageClipboardNormalizesNonPngToPng,
  testImageClipboardRemainsDisabledOnInsecureHttp,
];
