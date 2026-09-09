'use strict';
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createImagePreviewWorkflow } = require('../../client/app/image-preview-workflow');

function environment({ mime = 'image/png', ratio = '75%', encodeSize = () => 900, outputMime, fail = false } = {}) {
  const dom = new JSDOM('<body><img id="imagePreviewImg"><button id="imagePreviewCompressDownload"></button></body>');
  const document = dom.window.document;
  const image = document.getElementById('imagePreviewImg');
  image.dataset.persistedSrc = 'indexeddb://original';
  image.dataset.filename = 'original.' + mime.split('/')[1];
  const original = { type: mime, size: 2000 };
  const objects = new Map(), revoked = [], encodes = [], alerts = [], downloads = [];
  let reads = 0;
  const canvas = { width: 0, height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob(callback, type, quality) {
      encodes.push({ type, quality });
      callback(fail ? null : { type: outputMime || type, size: encodeSize(quality) });
    },
  };
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    if (tag === 'canvas') return canvas;
    const element = create(tag);
    if (tag === 'a') element.click = () => downloads.push({ blob: objects.get(element.href), filename: element.download });
    return element;
  };
  const workflow = createImagePreviewWorkflow({
    document, getElement: id => document.getElementById(id),
    getImageBlob: async () => { reads += 1; return original; },
    prompt: () => ratio, alert: value => alerts.push(value),
    Image: class { constructor() { this.naturalWidth = 1600; this.naturalHeight = 900; } set src(value) { queueMicrotask(() => this.onload()); } },
    URL: { createObjectURL(blob) { const url = 'blob:test-' + objects.size; objects.set(url, blob); return url; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout: callback => callback(),
  });
  return { workflow, original, canvas, encodes, alerts, downloads, objects, revoked, reads: () => reads };
}
async function testPngCompressionPreservesFormatAndDimensions() {
  const env = environment();
  await env.workflow.compressDownloadImage();
  assert.strictEqual(env.downloads[0].blob.type, 'image/png');
  assert.match(env.downloads[0].filename, /\.png$/);
  assert.deepStrictEqual([env.canvas.width, env.canvas.height], [1600, 900]);
  assert.strictEqual(env.encodes.length, 1);
  assert.strictEqual(env.revoked.length, env.objects.size);
}
async function testJpegCompressionSearchesForTargetBytesInsteadOfUsingRatioAsQuality() {
  const env = environment({ mime: 'image/jpeg', encodeSize: quality => Math.round(2000 * quality * quality) });
  await env.workflow.compressDownloadImage();
  assert.ok(Math.abs(env.downloads[0].blob.size - 1500) <= 40);
  assert.strictEqual(env.downloads[0].blob.type, 'image/jpeg');
  assert.deepStrictEqual([env.canvas.width, env.canvas.height], [1600, 900]);
}
async function testCompressionDoesNotSilentlyConvertUnsupportedEncoderFormat() {
  const env = environment({ mime: 'image/avif', outputMime: 'image/png' });
  await env.workflow.compressDownloadImage();
  assert.strictEqual(env.downloads.length, 0);
  assert.ok(env.alerts.length > 0);
  assert.strictEqual(env.revoked.length, env.objects.size);
}
async function testFullSizeAndLargerPngResultsPreserveOriginalFile() {
  for (const options of [{ ratio: '100%' }, { encodeSize: () => 4000 }]) {
    const env = environment(options);
    await env.workflow.compressDownloadImage();
    assert.strictEqual(env.downloads[0].blob, env.original);
  }
}
async function testCancelledCompressionDoesNotReadOrDownload() {
  const env = environment({ ratio: null });
  await env.workflow.compressDownloadImage();
  assert.strictEqual(env.reads(), 0);
  assert.strictEqual(env.downloads.length, 0);
}
async function testCompressionFailureReportsActionableErrorAndReleasesResources() {
  const env = environment({ fail: true });
  await env.workflow.compressDownloadImage();
  assert.strictEqual(env.downloads.length, 0);
  assert.ok(env.alerts.some(text => text.includes('原图下载')));
  assert.strictEqual(env.revoked.length, env.objects.size);
}
module.exports = [testPngCompressionPreservesFormatAndDimensions, testJpegCompressionSearchesForTargetBytesInsteadOfUsingRatioAsQuality,
  testCompressionDoesNotSilentlyConvertUnsupportedEncoderFormat, testFullSizeAndLargerPngResultsPreserveOriginalFile,
  testCancelledCompressionDoesNotReadOrDownload, testCompressionFailureReportsActionableErrorAndReleasesResources];
