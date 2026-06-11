(function initChatUIImageService(root) {
  'use strict';

function imageItemToResult(item) {
  const rawItem = typeof item === 'string' ? { url: item } : (item || {});
  const url = rawItem.url || rawItem.image_url || rawItem.output_url || '';
  const b64 = rawItem.b64_json || rawItem.image_base64 || rawItem.base64 || rawItem.b64 || '';
  const src = url || (b64 ? `data:image/png;base64,${b64}` : '');
  return src ? { src, url, b64, raw: url || '[base64 image]' } : null;
}

function extractImageResult(result) {
  const candidates = [result?.data, result?.images, result?.output, result?.result, result?.results].find(Array.isArray) || (Array.isArray(result) ? result : []);
  const items = candidates.map(imageItemToResult).filter(Boolean);
  if (!items.length) {
    const raw = JSON.stringify(result, null, 2);
    return result?.data?.length ? { kind: 'raw', url: '', b64: '', raw } : { kind: 'empty', url: '', b64: '', raw };
  }
  const first = items[0];
  return {
    kind: 'image',
    src: first.src,
    url: first.url,
    b64: first.b64,
    raw: items.map(item => item.raw).join('\n'),
    images: items,
  };
}

function buildImageCompletionMessage({ prompt = '', mode = 'image' } = {}) {
  return mode === 'edit_image' ? `[图片编辑完成] ${prompt}` : `[图片生成完成] ${prompt}`;
}

async function imageFileToJobPayload(attachment, readFileAsDataURL) {
  const file = attachment?.file;
  const existingDataUrl = String(attachment?.dataUrl || attachment?.src || attachment?.previewUrl || '');
  const dataUrl = file ? await readFileAsDataURL(file) : existingDataUrl;
  if (!String(dataUrl || '').startsWith('data:')) return null;
  const data = String(dataUrl || '').split(',')[1] || '';
  return data ? {
    name: attachment.name || file?.name || 'image.png',
    type: attachment.type || file?.type || String(dataUrl).match(/^data:([^;,]+)/)?.[1] || 'image/png',
    data,
  } : null;
}

async function imageFilesToJobPayload(attachments = [], readFileAsDataURL) {
  const result = [];
  for (const attachment of attachments) {
    const payload = await imageFileToJobPayload(attachment, readFileAsDataURL);
    if (payload) result.push(payload);
  }
  return result;
}

const api = Object.freeze({ extractImageResult, buildImageCompletionMessage, imageFileToJobPayload, imageFilesToJobPayload });

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIImageService = api;
if (root?.window) root.window.ChatUIImageService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
