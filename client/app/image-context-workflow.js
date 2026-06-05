(function initChatUIAppImageContextWorkflow(root) {
  'use strict';

  function createImageContextWorkflow(deps = {}) {
    const getState = deps.getState || (() => ({}));
    const getActiveSession = deps.getActiveSession || (() => ({}));
    const isImageFile = deps.isImageFile || (() => false);
    const dataUrlToBlob = deps.dataUrlToBlob || (url => fetch(url).then(res => res.blob()));
    const putImageBlob = deps.putImageBlob;
    const imageRefToFile = deps.imageRefToFile;
    const imageRefToDataUrl = deps.imageRefToDataUrl;
    const normalizeLastGeneratedImage = deps.normalizeLastGeneratedImage || (value => value);
    const findImageReferenceById = deps.findImageReferenceById || (() => null);
    const makeImageReferenceId = deps.makeImageReferenceId;
    const parseImageReferenceId = deps.parseImageReferenceId;
    const makeImageItemId = deps.makeImageItemId;
    const normalizeImageSelection = deps.normalizeImageSelection;
    const normalizeSelectedImageIds = deps.normalizeSelectedImageIds;
    const resolveImageSelectionFromIds = deps.resolveImageSelectionFromIds;
    const parseImageContext = deps.parseImageContext;

    function serializeImageAttachment(item) {
      if (!item || !isImageFile(item)) return null;
      const src = item.dataUrl || item.src || '';
      return src ? {
        name: item.name || item.file?.name || 'image.png',
        type: item.type || item.file?.type || 'image/png',
        src,
        fromPrevious: !!item.fromPrevious,
        sourceIndex: Number(item.sourceIndex) || 0,
        imageId: item.imageId || item.image_id || '',
        referenceId: item.referenceId || item.reference_id || '',
      } : null;
    }

    async function persistImageAttachmentRefs(list = []) {
      const result = [];
      for (const item of list) {
        const serialized = serializeImageAttachment(item);
        if (!serialized) continue;
        let src = serialized.src;
        if (src.startsWith('data:')) {
          try {
            const blob = await dataUrlToBlob(src);
            const key = `edit-attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
            await putImageBlob(key, blob);
            src = `indexeddb://${key}`;
          } catch { src = serialized.src; }
        }
        result.push({ ...serialized, src });
      }
      return result;
    }

    function normalizeImageContextForStorage(context = {}) {
      const attachments = (context.attachments || []).map(serializeImageAttachment).filter(Boolean).map((item, index) => ({
        ...item,
        referenceId: item.referenceId || context.referenceId || context.selectedReferenceId || '',
        imageId: item.imageId || makeImageItemId(item.referenceId || context.referenceId || context.selectedReferenceId || 'latest', item.sourceIndex || index + 1),
        sourceIndex: Number(item.sourceIndex) || index + 1,
      }));
      return {
        prompt: context.prompt || '',
        mode: context.mode || 'image',
        target: context.target || 'new',
        usePreviousImage: !!context.usePreviousImage,
        updatedAt: context.updatedAt || context.updated_at || null,
        imageCount: attachments.length,
        referenceId: context.referenceId || '',
        selectedReferenceId: context.selectedReferenceId || '',
        selectedIndexes: normalizeImageSelection(context.selectedIndexes || context.selected_indexes || []) || [],
        selectedImageIds: normalizeSelectedImageIds(context.selectedImageIds || context.selected_image_ids || []),
        attachments,
      };
    }

    async function buildUploadedImageContext(prompt, attachments = []) {
      const imageAttachments = attachments.filter(item => isImageFile(item));
      if (!imageAttachments.length) return null;
      const refs = await persistImageAttachmentRefs(imageAttachments);
      return refs.length ? normalizeImageContextForStorage({ prompt, mode: 'edit_image', target: 'uploaded', usePreviousImage: false, updatedAt: Date.now(), attachments: refs }) : null;
    }

    async function persistGenericAttachmentSrc(src, name = 'attachment') {
      if (!src) return '';
      if (!String(src).startsWith('data:')) return src;
      try {
        const blob = await dataUrlToBlob(src);
        const key = `attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${name || 'file'}`;
        await putImageBlob(key, blob);
        return `indexeddb://${key}`;
      } catch { return ''; }
    }

    async function buildUserAttachmentContext(prompt, attachments = []) {
      const generic = [];
      for (const item of attachments) {
        if (isImageFile(item)) continue;
        const entry = {
          name: item.name || item.file?.name || 'attachment',
          type: item.type || item.file?.type || 'application/octet-stream',
          size: item.size || item.file?.size || 0,
          text: item.text || '',
          unsupportedReason: item.unsupportedReason || '',
          compressionNote: item.compressionNote || '',
        };
        if (item.dataUrl) {
          const src = await persistGenericAttachmentSrc(item.dataUrl, entry.name);
          if (src) entry.src = src;
        }
        generic.push(entry);
      }
      const images = await persistImageAttachmentRefs(attachments.filter(item => isImageFile(item)));
      return images.length || generic.length ? { prompt: prompt || '', attachments: [...images, ...generic] } : null;
    }

    async function restoreUserAttachmentsFromContext(value) {
      const context = parseImageContext(value);
      const attachments = Array.isArray(context?.attachments) ? context.attachments : [];
      const result = [];
      for (const item of attachments) {
        try {
          if (item.src) {
            const file = await imageRefToFile(item.src, item.name || 'attachment');
            result.push({
              file,
              name: item.name || file.name,
              type: item.type || file.type || 'application/octet-stream',
              size: item.size || file.size,
              dataUrl: isImageFile({ name: item.name || file.name, type: item.type || file.type }) ? await imageRefToDataUrl(item.src, item.name || file.name) : item.src,
              text: item.text || '',
              unsupportedReason: item.unsupportedReason || '',
              compressionNote: item.compressionNote || '',
              fromPrevious: !!item.fromPrevious,
            });
            continue;
          }
          result.push({ file: null, name: item.name || 'attachment', type: item.type || 'application/octet-stream', size: item.size || 0, dataUrl: '', text: item.text || '', unsupportedReason: item.unsupportedReason || '', compressionNote: item.compressionNote || '' });
        } catch (err) { console.warn('restore attachment failed', err); }
      }
      return result;
    }

    function getUserAttachmentContextFromNode(node) {
      if (!node) return null;
      const activeSession = getActiveSession();
      const candidates = [node.dataset.attachmentContext || '', node.__displayItem?.attachmentContext || ''];
      const messageIndex = node.dataset.messageIndex || node.__displayItem?.messageIndex || '';
      if (messageIndex !== '') {
        const context = activeSession?.messages?.[Number(messageIndex)]?.attachmentContext;
        if (context) candidates.push(context);
      }
      const displayItemId = node.dataset.displayItemId || node.__displayItem?.id || '';
      if (displayItemId) {
        const item = (activeSession?.display || []).find(item => item.id === displayItemId);
        if (item?.attachmentContext) candidates.push(item.attachmentContext);
      }
      for (const candidate of candidates) if (candidate) try { return typeof candidate === 'string' ? JSON.parse(candidate) : candidate; } catch {}
      return null;
    }

    function getLatestUploadedImageContext(sessionId = getState().activeSessionId) {
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId) || getActiveSession();
      for (const item of [...(session?.display || [])].reverse()) {
        const context = parseImageContext(item?.imageContext);
        if (context?.attachments?.length && (context.target === 'uploaded' || context.mode === 'edit_image')) return context;
      }
      for (const item of [...(session?.messages || [])].reverse()) {
        const context = parseImageContext(item?.imageContext);
        if (context?.attachments?.length && (context.target === 'uploaded' || context.mode === 'edit_image')) return context;
      }
      return null;
    }

    async function restoreImageAttachmentsFromContext(context) {
      const attachments = Array.isArray(context?.attachments) ? context.attachments : [];
      const result = [];
      for (const item of attachments) {
        if (!item?.src) continue;
        const file = await imageRefToFile(item.src, item.name || 'image.png');
        result.push({ file, name: item.name || file.name, type: item.type || file.type || 'image/png', size: file.size, dataUrl: item.src, text: '', fromPrevious: !!item.fromPrevious, sourceIndex: Number(item.sourceIndex) || 0, imageId: item.imageId || '', referenceId: item.referenceId || '' });
      }
      return result;
    }

    async function getLatestUploadedImageAttachments(sessionId = getState().activeSessionId) {
      const context = getLatestUploadedImageContext(sessionId);
      return context?.attachments?.length ? restoreImageAttachmentsFromContext(context) : [];
    }

    function setImageContext(node, context) {
      if (!node || !context) return;
      const text = JSON.stringify(normalizeImageContextForStorage(context));
      node.dataset.imageContext = text;
      if (node.__displayItem) node.__displayItem.imageContext = text;
    }

    async function getPreviousImageAttachments(sessionId = getState().activeSessionId, selectedIndexes = null, referenceId = '', selectedImageIds = []) {
      const state = getState();
      const reference = parseImageReferenceId(referenceId);
      const session = state.sessions.find(item => item.id === sessionId);
      const image = normalizeLastGeneratedImage(findImageReferenceById(sessionId, reference) || (sessionId === state.activeSessionId ? state.lastGeneratedImage : session?.lastGeneratedImage));
      const images = Array.isArray(image?.images) && image.images.length ? image.images : image?.src ? [{ src: image.src, filename: image.filename || 'previous-image.png' }] : [];
      const normalizedReferenceId = makeImageReferenceId(reference || 'latest');
      const explicitIndexes = normalizeImageSelection(selectedIndexes, images.length);
      const ids = normalizeSelectedImageIds(selectedImageIds);
      const indexesFromIds = ids.length ? resolveImageSelectionFromIds(ids, normalizedReferenceId, images.length) : null;
      const selection = explicitIndexes && explicitIndexes.length ? explicitIndexes : indexesFromIds;
      const result = [];
      for (let index = 0; index < images.length; index += 1) {
        if (selection && selection.length && !selection.includes(index + 1)) continue;
        const item = images[index];
        if (!item?.src) continue;
        const file = await imageRefToFile(item.src, item.filename || `previous-image-${index + 1}.png`);
        const imageId = makeImageItemId(normalizedReferenceId, index + 1);
        result.push({ file, name: file.name, type: file.type || 'image/png', size: file.size, dataUrl: item.src, text: '', fromPrevious: true, sourceIndex: index + 1, imageId, label: item.label || item.subject || '' });
      }
      return result;
    }

    async function getPreviousImageAsAttachment(sessionId = getState().activeSessionId) { return (await getPreviousImageAttachments(sessionId))[0] || null; }

    function getAssistantImageContext(node) {
      if (!node) return null;
      const candidates = [node.dataset.imageContext || '', node.__displayItem?.imageContext || ''];
      const displayItemId = node.dataset.displayItemId || node.__displayItem?.id || '';
      if (displayItemId) {
        const item = (getActiveSession().display || []).find(item => item.id === displayItemId);
        if (item?.imageContext) candidates.push(item.imageContext);
      }
      for (const candidate of candidates) if (candidate) try { const context = typeof candidate === 'string' ? JSON.parse(candidate) : candidate; if (context && typeof context === 'object') return context; } catch {}
      return null;
    }

    return Object.freeze({ serializeImageAttachment, persistImageAttachmentRefs, normalizeImageContextForStorage, buildUploadedImageContext, persistGenericAttachmentSrc, buildUserAttachmentContext, restoreUserAttachmentsFromContext, getUserAttachmentContextFromNode, getLatestUploadedImageContext, getLatestUploadedImageAttachments, setImageContext, restoreImageAttachmentsFromContext, getPreviousImageAttachments, getPreviousImageAsAttachment, getAssistantImageContext });
  }

  const api = Object.freeze({ createImageContextWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageContextWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageContextWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
