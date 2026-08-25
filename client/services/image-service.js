(function initChatUIImageService(root) {
  'use strict';

  const MODULE_REGISTRY_SYMBOL = Symbol.for('chatui.module-registry.v1');
  const dispatchContractModule = root?.[MODULE_REGISTRY_SYMBOL]?.get('dispatchContract')
    || root?.ChatUIDispatchContract
    || (typeof require === 'function' ? require('../../shared/dispatch-contract') : {});

  function currentDispatchContractModule() {
    return root?.[MODULE_REGISTRY_SYMBOL]?.get('dispatchContract')
      || root?.ChatUIDispatchContract
      || dispatchContractModule;
  }

  function routeBindingTransportFields(attachment = {}) {
    const contract = currentDispatchContractModule();
    if (typeof contract?.routeBindingTransportFields !== 'function') {
      const hasBinding = [
        attachment?.routeResourceKey, attachment?.route_resource_key,
        attachment?.routeRole, attachment?.route_role,
        attachment?.routeResourceId, attachment?.route_resource_id,
        attachment?.routeSource, attachment?.route_source,
      ].some(value => String(value || '').trim());
      if (hasBinding) throw new TypeError('Dispatch-contract binding serializer is unavailable');
      return {};
    }
    return contract.routeBindingTransportFields(attachment);
  }

function stringValue(value = '') {
  return typeof value === 'string' ? value.trim() : '';
}

function nestedImageValue(value, fields = []) {
  if (typeof value === 'string') return stringValue(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const field of fields) {
    const candidate = value[field];
    const normalized = typeof candidate === 'string'
      ? stringValue(candidate)
      : nestedImageValue(candidate, fields);
    if (normalized) return normalized;
  }
  return '';
}

function imageUrlFromItem(rawItem = {}) {
  return nestedImageValue(rawItem, ['url', 'src', 'image_url', 'image', 'href']);
}

function imageBase64FromItem(rawItem = {}) {
  return nestedImageValue(rawItem, ['b64_json', 'image_base64', 'base64', 'data']);
}

function imageMimeType(rawItem = {}) {
  const explicit = nestedImageValue(rawItem, ['mime_type', 'mimeType', 'media_type', 'content_type', 'contentType', 'type']);
  return /^image\/[a-z0-9.+-]+$/i.test(explicit) ? explicit.toLowerCase() : 'image/png';
}

function imageDataUrlFromBase64(value, mimeType = 'image/png') {
  const encoded = stringValue(value);
  if (!encoded) return '';
  if (/^data:image\//i.test(encoded)) return encoded;
  return `data:${mimeType};base64,${encoded}`;
}

function imageItemToResult(item) {
  const rawItem = typeof item === 'string' ? { url: item } : item || {};
  const url = imageUrlFromItem(rawItem);
  const b64 = imageBase64FromItem(rawItem);
  const src = url || imageDataUrlFromBase64(b64, imageMimeType(rawItem));
  const revisedPrompt = String(rawItem.revised_prompt || rawItem.revisedPrompt || rawItem.prompt || '').trim();
  return src ? { src, url, b64, raw: url || '[base64 image]', revisedPrompt } : null;
}

function extractImageResult(result) {
  const rawItems = Array.isArray(result)
    ? result
    : Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.images)
        ? result.images
        : Array.isArray(result?.output)
          ? result.output
          : [];
  const items = rawItems.map(imageItemToResult).filter(Boolean);
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
  let file = attachment?.file;
  if (file && typeof root?.compressImageIfNeeded === 'function') {
    try {
      const compressed = await root.compressImageIfNeeded(file);
      if (compressed?.file) {
        file = compressed.file;
        attachment = { ...attachment, file, name: file.name || attachment.name, type: file.type || attachment.type };
      }
    } catch {}
  }
  const existingDataUrl = String(attachment?.dataUrl || attachment?.src || attachment?.previewUrl || '');
  const dataUrl = file ? await readFileAsDataURL(file) : existingDataUrl;
  if (!String(dataUrl || '').startsWith('data:')) return null;
  const data = String(dataUrl || '').split(',')[1] || '';
  if (!data) return null;
  const binding = routeBindingTransportFields(attachment);
  const routeId = String(attachment.routeId || attachment.imageId || attachment.image_id || attachment.id || '').trim();
  const routeReferenceId = String(attachment.routeReferenceId || attachment.referenceId || attachment.reference_id || '').trim();
  return {
    name: attachment.name || file?.name || 'image.png',
    type: attachment.type || file?.type || String(dataUrl).match(/^data:([^;,]+)/)?.[1] || 'image/png',
    data,
    ...binding,
    ...(routeId ? { routeId } : {}),
    ...(routeReferenceId ? { routeReferenceId } : {}),
  };
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
