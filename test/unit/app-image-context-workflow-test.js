#!/usr/bin/env node
const assert = require('assert');
const { createImageContextWorkflow } = require('../../client/app/image-context-workflow');

const blobs = new Map();
const fileFrom = (src, name = 'image.png') => ({ name, type: 'image/png', size: 12, src });
const state = {
  activeSessionId: 's1',
  lastGeneratedImage: { images: [{ src: 'indexeddb://g1', filename: 'g1.png' }, { src: 'indexeddb://g2', filename: 'g2.png' }] },
  sessions: [{ id: 's1', display: [], messages: [] }],
};
const workflow = createImageContextWorkflow({
  getState: () => state,
  getActiveSession: () => state.sessions[0],
  isImageFile: item => /^image\//.test(item.type || '') || /\.png$/i.test(item.name || ''),
  dataUrlToBlob: async src => ({ src, type: 'image/png', size: 10 }),
  putImageBlob: async (key, blob) => { blobs.set(key, blob); },
  imageRefToFile: async (src, name) => fileFrom(src, name),
  imageRefToDataUrl: async src => `data:${src}`,
  normalizeLastGeneratedImage: value => value,
  findImageReferenceById: () => null,
  makeImageReferenceId: value => String(value || 'latest').startsWith('imgref_') ? value : `imgref_${String(value || 'latest').replace(/\s+/g, '_')}`,
  parseImageReferenceId: value => !value || value === 'imgref_latest' ? 'latest' : String(value).replace(/^imgref_/, ''),
  makeImageItemId: (ref, index) => `img_${String(ref).startsWith('imgref_') ? ref : `imgref_${ref}`}_${index}`,
  normalizeImageSelection: (value, max = 0) => Array.isArray(value) ? value.map(Number).filter(item => item >= 1 && (!max || item <= max)) : null,
  normalizeSelectedImageIds: value => Array.isArray(value) ? value.filter(item => String(item).startsWith('img_')) : [],
  resolveImageSelectionFromIds: (ids, ref) => ids.includes(`img_${ref}_2`) ? [2] : [],
  parseImageContext: value => typeof value === 'string' ? JSON.parse(value) : value,
});

(async () => {
  assert.deepStrictEqual(workflow.serializeImageAttachment({ name: 'a.png', type: 'image/png', dataUrl: 'data:x', sourceIndex: 2 }).sourceIndex, 2);
  const persisted = await workflow.persistImageAttachmentRefs([{ name: 'a.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==' }]);
  assert.strictEqual(persisted.length, 1);
  assert.ok(persisted[0].src.startsWith('indexeddb://'));
  assert.strictEqual(blobs.size, 1);
  const normalized = workflow.normalizeImageContextForStorage({ selectedIndexes: ['2'], selectedImageIds: ['img_imgref_latest_2'], attachments: [{ name: 'a.png', type: 'image/png', src: 'indexeddb://x' }] });
  assert.strictEqual(normalized.imageCount, 1);
  assert.strictEqual(normalized.attachments[0].imageId, 'img_imgref_latest_1');
  const uploaded = await workflow.buildUploadedImageContext('edit', [{ name: 'a.png', type: 'image/png', dataUrl: 'data:x' }]);
  assert.strictEqual(uploaded.target, 'uploaded');
  const userContext = await workflow.buildUserAttachmentContext('p', [{ name: 'a.txt', type: 'text/plain', dataUrl: 'data:text/plain,hi', text: 'hi' }, { name: 'a.png', type: 'image/png', dataUrl: 'data:x' }]);
  assert.strictEqual(userContext.attachments.length, 2);
  const restored = await workflow.restoreUserAttachmentsFromContext(userContext);
  assert.strictEqual(restored.length, 2);
  state.sessions[0].display.push({ imageContext: JSON.stringify(uploaded) });
  assert.strictEqual(workflow.getLatestUploadedImageContext('s1').target, 'uploaded');
  const latest = await workflow.getLatestUploadedImageAttachments('s1');
  assert.strictEqual(latest.length, 1);
  const node = { dataset: {}, __displayItem: {} };
  workflow.setImageContext(node, uploaded);
  assert.ok(node.dataset.imageContext.includes('uploaded'));
  assert.ok(node.__displayItem.imageContext.includes('uploaded'));
  const previous = await workflow.getPreviousImageAttachments('s1', [2], '', []);
  assert.strictEqual(previous.length, 1);
  assert.strictEqual(previous[0].sourceIndex, 2);
  assert.strictEqual((await workflow.getPreviousImageAsAttachment('s1')).sourceIndex, 1);
  assert.strictEqual(workflow.getAssistantImageContext({ dataset: { imageContext: JSON.stringify(uploaded) } }).target, 'uploaded');
  console.log('app image context workflow ok');
})().catch(err => { console.error(err); process.exit(1); });
