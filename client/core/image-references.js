(function initChatUICoreImageReferences(root) {
  'use strict';

const IMAGE_REFERENCE_PREFIX = 'imgref_';
const IMAGE_ITEM_PREFIX = 'img_';

function sanitizeImageReferencePart(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'latest';
}

function makeImageReferenceId(value = 'latest') {
  const text = String(value || 'latest');
  return text.startsWith(IMAGE_REFERENCE_PREFIX) ? text : `${IMAGE_REFERENCE_PREFIX}${sanitizeImageReferencePart(text)}`;
}

function parseImageReferenceId(value = '') {
  const text = String(value || '');
  if (!text || text === 'latest' || text === `${IMAGE_REFERENCE_PREFIX}latest`) return 'latest';
  return text.startsWith(IMAGE_REFERENCE_PREFIX) ? text.slice(IMAGE_REFERENCE_PREFIX.length) : text;
}

function makeImageItemId(reference = 'latest', index = 1) {
  return `${IMAGE_ITEM_PREFIX}${makeImageReferenceId(reference)}_${Number(index) || 1}`;
}

function parseImageItemId(value = '') {
  const match = String(value || '').match(/^img_(imgref_.+)_(\d+)$/);
  if (!match) return null;
  const index = Number(match[2]);
  if (!Number.isInteger(index) || index < 1) return null;
  return {
    referenceId: match[1],
    reference: parseImageReferenceId(match[1]),
    index,
  };
}

function normalizeSelectedImageIds(value = []) {
  const ids = Array.isArray(value)
    ? value
    : Array.isArray(value && value.image_ids)
      ? value.image_ids
      : Array.isArray(value && value.imageIds)
        ? value.imageIds
        : [];
  return ids.map(item => String(item || '').trim()).filter(item => item.startsWith(IMAGE_ITEM_PREFIX)).filter((item, index, list) => list.indexOf(item) === index);
}

function resolveImageSelectionFromIds(ids = [], reference = 'latest', maxCount = 0) {
  const referenceId = makeImageReferenceId(reference);
  const indexes = [];
  for (const id of ids) {
    const match = String(id || '').match(/^img_(.+)_(\d+)$/);
    if (!match || match[1] !== referenceId) continue;
    const index = Number(match[2]);
    if (Number.isInteger(index) && index >= 1 && (!maxCount || index <= maxCount)) indexes.push(index);
  }
  return indexes.filter((item, index, list) => list.indexOf(item) === index);
}

function normalizeImageSelection(value, maxCount = 0) {
  if (!value) return null;
  let indexes = [];
  if (Array.isArray(value)) indexes = value;
  else if (Array.isArray(value.indexes)) indexes = value.indexes;
  else if (Array.isArray(value.indices)) indexes = value.indices;
  else if (Number.isFinite(Number(value.index))) indexes = [value.index];
  else if (Number.isFinite(Number(value.image_index))) indexes = [value.image_index];
  else if (Number.isFinite(Number(value.imageIndex))) indexes = [value.imageIndex];
  return indexes.map(Number).filter(item => Number.isInteger(item) && item >= 1 && (!maxCount || item <= maxCount)).filter((item, index, list) => list.indexOf(item) === index);
}

const api = Object.freeze({
  IMAGE_REFERENCE_PREFIX,
  IMAGE_ITEM_PREFIX,
  sanitizeImageReferencePart,
  makeImageReferenceId,
  parseImageReferenceId,
  makeImageItemId,
  parseImageItemId,
  normalizeSelectedImageIds,
  resolveImageSelectionFromIds,
  normalizeImageSelection,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUICoreImageReferences = api;
if (root?.window) root.window.ChatUICoreImageReferences = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
