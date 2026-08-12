(function initChatUIAppImageContextWorkflow(root) {
  'use strict';

  const coreAttachments = typeof require === 'function'
    ? require('../core/attachments')
    : root?.ChatUICoreAttachments || {};

  function createImageContextWorkflow(deps = {}) {
    const getState = deps.getState || (() => ({}));
    const getActiveSession = deps.getActiveSession || (() => ({}));
    const isImageFile = deps.isImageFile || (() => false);
    const dataUrlToBlob = deps.dataUrlToBlob || (url => fetch(url).then(res => res.blob()));
    const putImageBlob = deps.putImageBlob;
    const imageRefToFile = deps.imageRefToFile;
    const imageRefToDataUrl = deps.imageRefToDataUrl;
    const FileCtor = deps.File || root?.File;
    const normalizeLastGeneratedImage = deps.normalizeLastGeneratedImage || (value => value);
    const findImageReferenceById = deps.findImageReferenceById || (() => null);
    const makeImageReferenceId = deps.makeImageReferenceId;
    const parseImageReferenceId = deps.parseImageReferenceId;
    const makeImageItemId = deps.makeImageItemId;
    const parseImageItemId = deps.parseImageItemId;
    const normalizeImageSelection = deps.normalizeImageSelection;
    const normalizeSelectedImageIds = deps.normalizeSelectedImageIds;
    const normalizeStoredImageAttachment = deps.normalizeStoredImageAttachment || coreAttachments.normalizeStoredImageAttachment;
    const parseImageContext = deps.parseImageContext || (value => {
      if (!value) return null;
      if (typeof value === 'object') return value;
      try { return JSON.parse(value); } catch { return null; }
    });

    function serializeAttachmentEntry(item, index = 0) {
      const name = item?.name || item?.file?.name || 'attachment';
      const type = item?.type || item?.file?.type || 'application/octet-stream';
      const size = item?.size || item?.file?.size || 0;
      const existingId = item?.attachmentId || item?.attachment_id || item?.imageId || item?.image_id || item?.fileId || item?.file_id || item?.id || '';
      const safeName = String(name || 'attachment').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'attachment';
      const id = existingId || `att_${Date.now().toString(36).slice(-6)}_${index + 1}_${safeName}`;
      if (item && typeof item === 'object' && !item.attachmentId) item.attachmentId = id;
      return { id, name, type, size };
    }

    function attachmentPlaceholdersMarkdown(attachments = []) {
      return (attachments || []).map((item, index) => {
        const meta = serializeAttachmentEntry(item, index);
        const kind = isImageFile(item) ? 'image' : 'file';
        return `[${kind} id=${meta.id} name=${meta.name} type=${meta.type} size=${meta.size}]`;
      }).join('\n');
    }

    function buildUserContentWithAttachmentPlaceholders(prompt = '', attachments = []) {
      const text = String(prompt || '').trim();
      const placeholders = attachmentPlaceholdersMarkdown(attachments).trim();
      return [text, placeholders].filter(Boolean).join('\n\n') || (attachments.length ? '[attachments]' : text);
    }

    function durableAttachmentRef(value = '') {
      const ref = String(value || '').trim();
      return ref && !/^(?:data:|blob:)/i.test(ref) ? ref : '';
    }

    function preferredImageAttachmentSrc(item = {}) {
      const candidates = [
        item.persistedSrc,
        item.persisted_src,
        item.previewSrc,
        item.preview_src,
        item.src,
        item.url,
        item.dataUrl,
        item.data_url,
      ];
      return candidates.map(durableAttachmentRef).find(Boolean)
        || candidates.map(value => String(value || '').trim()).find(Boolean)
        || '';
    }

    function serializeImageAttachment(item) {
      if (!item || !isImageFile(item)) return null;
      const base = serializeAttachmentEntry(item);
      const src = preferredImageAttachmentSrc(item);
      if (!src) return null;
      if (typeof normalizeStoredImageAttachment !== 'function') throw new Error('Image attachment storage normalizer is unavailable');
      return normalizeStoredImageAttachment({
        ...item,
        id: base.id,
        name: base.name || 'image.png',
        type: base.type || 'image/png',
        size: base.size || 0,
        src,
      });
    }

    async function persistImageAttachmentRefs(list = []) {
      const result = [];
      for (let index = 0; index < list.length; index += 1) {
        const item = list[index];
        const attachmentId = item?.attachmentId || item?.attachment_id || item?.id || item?.imageId || item?.image_id || serializeAttachmentEntry(item, index).id;
        const serialized = serializeImageAttachment({ ...item, attachmentId });
        if (!serialized) continue;
        let src = serialized.src;
        if (src.startsWith('data:')) {
          try {
            const blob = await dataUrlToBlob(src);
            const safeId = String(serialized.id || attachmentId || `image-${index + 1}`).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || `image-${index + 1}`;
            const key = `attachment-${safeId}`;
            await putImageBlob(key, blob);
            src = `indexeddb://${key}`;
          } catch { src = serialized.src; }
        }
        if (item && typeof item === 'object' && durableAttachmentRef(src)) {
          item.persistedSrc = src;
          item.previewSrc = src;
        }
        result.push({ ...serialized, src });
      }
      return result;
    }

    function normalizeImageAttachmentList(list = [], fallbackRole = '', context = {}) {
      return (Array.isArray(list) ? list : []).map(item => serializeImageAttachment({
        ...item,
        routeRole: item?.routeRole || item?.route_role || item?.role || fallbackRole,
      })).filter(Boolean).map((item, index) => ({
        ...item,
        routeRole: item.routeRole || fallbackRole,
        referenceId: item.referenceId || context.referenceId || context.selectedReferenceId || '',
        imageId: item.imageId || makeImageItemId(item.referenceId || context.referenceId || context.selectedReferenceId || 'latest', item.sourceIndex || index + 1),
        sourceIndex: Number(item.sourceIndex) || index + 1,
      }));
    }

    function normalizeImageContextForStorage(context = {}) {
      const attachments = normalizeImageAttachmentList(context.attachments, '', context);
      const masks = normalizeImageAttachmentList(context.masks || context.maskAttachments || context.mask_attachments, 'mask', context);
      return {
        ...(context.schema_version || context.schemaVersion ? { schema_version: context.schema_version || context.schemaVersion } : {}),
        ...(context.resultId || context.result_id ? { resultId: context.resultId || context.result_id } : {}),
        prompt: context.prompt || '',
        routePrompt: context.routePrompt || context.route_prompt || '',
        content: context.content || '',
        mode: context.mode || 'image',
        target: context.target || 'new',
        usePreviousImage: !!context.usePreviousImage,
        updatedAt: context.updatedAt || context.updated_at || null,
        imageCount: attachments.length,
        maskCount: masks.length,
        referenceId: context.referenceId || '',
        selectedReferenceId: context.selectedReferenceId || '',
        selectedIndexes: normalizeImageSelection(context.selectedIndexes || context.selected_indexes || []) || [],
        selectedImageIds: normalizeSelectedImageIds(context.selectedImageIds || context.selected_image_ids || []),
        attachments,
        masks,
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
        const key = `attachment-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}-${name || 'file'}`;
        await putImageBlob(key, blob);
        return `indexeddb://${key}`;
      } catch { return ''; }
    }

    function preferredGenericAttachmentSrc(item = {}) {
      const candidates = [
        item.persistedSrc,
        item.persisted_src,
        item.src,
        item.dataUrl,
        item.data_url,
      ].map(value => String(value || '').trim()).filter(Boolean);
      return candidates.map(durableAttachmentRef).find(Boolean) || candidates[0] || '';
    }

    function isPdfAttachment(item = {}) {
      return String(item.type || item.file?.type || '').toLowerCase() === 'application/pdf'
        || /\.pdf$/i.test(String(item.name || item.file?.name || ''));
    }

    function normalizePdfDetail(value = '') {
      const detail = String(value || '').trim().toLowerCase();
      return detail === 'low' || detail === 'high' ? detail : 'auto';
    }

    function isNativeInputFile(item = {}) {
      return item.inputFile === true || item.input_file === true;
    }

    async function persistGenericAttachmentRef(item, meta, index = 0) {
      const source = preferredGenericAttachmentSrc(item);
      const durable = durableAttachmentRef(source);
      if (durable) {
        if (item && typeof item === 'object') item.persistedSrc = durable;
        return durable;
      }
      if (typeof putImageBlob !== 'function') return '';
      let blob = item?.file || null;
      if (!blob && /^(?:data:|blob:)/i.test(source)) {
        try { blob = await dataUrlToBlob(source); } catch { blob = null; }
      }
      if (!blob) return '';
      try {
        const safeId = String(meta?.id || `file-${index + 1}`).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || `file-${index + 1}`;
        const key = `attachment-file-${safeId}`;
        await putImageBlob(key, blob);
        const persistedSrc = `indexeddb://${key}`;
        if (item && typeof item === 'object') item.persistedSrc = persistedSrc;
        return persistedSrc;
      } catch { return ''; }
    }

    function rawAttachmentContext(value) {
      if (!value) return null;
      if (typeof value === 'object') return value;
      try { return JSON.parse(value); } catch { return null; }
    }

    function attachmentContextForRestore(value) {
      const normalized = parseImageContext(value);
      const raw = rawAttachmentContext(value);
      if (!Array.isArray(raw?.attachments)) return normalized;
      const normalizedAttachments = Array.isArray(normalized?.attachments) ? normalized.attachments : [];
      const byId = new Map(normalizedAttachments.map(item => [String(item?.id || item?.attachmentId || item?.attachment_id || ''), item]).filter(([id]) => id));
      const attachments = raw.attachments.map((item, index) => {
        const localId = String(item?.id || item?.attachmentId || item?.attachment_id || item?.fileId || item?.file_id || '');
        const base = byId.get(localId) || normalizedAttachments[index] || {};
        return {
          ...base,
          ...item,
          src: item?.persistedSrc || item?.persisted_src || item?.src || base.src || '',
        };
      });
      return { ...(normalized || {}), ...raw, attachments };
    }

    function restoredDocumentFile(file, item = {}) {
      if (!file || typeof FileCtor !== 'function') return file;
      const name = item.name || file.name || 'attachment';
      const type = item.type || file.type || 'application/octet-stream';
      if (file.name === name && (!item.type || file.type === type)) return file;
      try {
        return new FileCtor([file], name, {
          type,
          lastModified: Number(item.lastModified || item.last_modified || file.lastModified) || Date.now(),
        });
      } catch { return file; }
    }

    async function buildUserAttachmentContext(prompt, attachments = []) {
      const generic = [];
      for (let index = 0; index < attachments.length; index += 1) {
        const item = attachments[index];
        if (isImageFile(item)) continue;
        const meta = serializeAttachmentEntry(item, index);
        const inputFile = isNativeInputFile(item);
        const entry = {
          id: meta.id,
          name: meta.name,
          type: meta.type,
          size: meta.size,
          text: inputFile ? '' : item.text || '',
          unsupportedReason: item.unsupportedReason || '',
          compressionNote: item.compressionNote || '',
        };
        const src = await persistGenericAttachmentRef(item, meta, index);
        if (src) {
          entry.src = src;
          entry.persistedSrc = src;
        }
        if (inputFile) entry.inputFile = true;
        if (isPdfAttachment(item)) entry.pdfDetail = normalizePdfDetail(item.pdfDetail || item.pdf_detail);
        generic.push(entry);
      }
      const images = await persistImageAttachmentRefs(attachments.filter(item => isImageFile(item)));
      return images.length || generic.length ? { prompt: prompt || '', content: buildUserContentWithAttachmentPlaceholders(prompt, attachments), attachments: [...images, ...generic] } : null;
    }

    async function restoreUserAttachmentsFromContext(value) {
      const context = attachmentContextForRestore(value);
      const attachments = Array.isArray(context?.attachments) ? context.attachments : [];
      const result = [];
      for (const item of attachments) {
        try {
          const src = preferredGenericAttachmentSrc(item);
          const inputFile = isNativeInputFile(item);
          const localAttachmentId = item.id || item.attachmentId || item.attachment_id || item.fileId || item.file_id || '';
          if (src) {
            let file = await imageRefToFile(src, item.name || 'attachment');
            const image = isImageFile({ name: item.name || file.name, type: item.type || file.type });
            if (!image) file = restoredDocumentFile(file, item);
            const durableSrc = durableAttachmentRef(src);
            const restored = {
              file,
              name: item.name || file.name,
              type: item.type || file.type || 'application/octet-stream',
              size: item.size || file.size,
              dataUrl: image ? await imageRefToDataUrl(src, item.name || file.name) : src,
              previewSrc: image ? durableSrc : '',
              persistedSrc: durableSrc,
              src: durableSrc,
              text: inputFile ? '' : item.text || '',
              attachmentId: localAttachmentId,
              unsupportedReason: item.unsupportedReason || '',
              compressionNote: item.compressionNote || '',
              fromPrevious: !!item.fromPrevious,
            };
            if (inputFile) restored.inputFile = true;
            if (isPdfAttachment(item)) restored.pdfDetail = normalizePdfDetail(item.pdfDetail || item.pdf_detail);
            result.push(restored);
            continue;
          }
          const restored = { file: null, name: item.name || 'attachment', type: item.type || 'application/octet-stream', size: item.size || 0, dataUrl: '', text: inputFile ? '' : item.text || '', attachmentId: localAttachmentId, unsupportedReason: item.unsupportedReason || '', compressionNote: item.compressionNote || '' };
          if (inputFile) restored.inputFile = true;
          if (isPdfAttachment(item)) restored.pdfDetail = normalizePdfDetail(item.pdfDetail || item.pdf_detail);
          result.push(restored);
        } catch (err) {
          console.warn('restore attachment failed', err);
          if (isNativeInputFile(item)) {
            const restoreError = new Error(`附件内容不可用，请重新上传：${item.name || 'attachment'}`);
            restoreError.code = 'FILE_CONTENT_UNAVAILABLE';
            restoreError.cause = err;
            throw restoreError;
          }
        }
      }
      return result;
    }

    function getUserAttachmentContextFromNode(node) {
      if (!node) return null;
      const activeSession = getActiveSession();
      const candidates = [node.dataset.attachmentContext || '', node.__displayItem?.attachmentContext || ''];
      const imageCandidates = [node.dataset.imageContext || '', node.__displayItem?.imageContext || ''];
      const messageIndex = node.dataset.messageIndex || node.__displayItem?.messageIndex || '';
      if (messageIndex !== '') {
        const context = activeSession?.messages?.[Number(messageIndex)]?.attachmentContext;
        if (context) candidates.push(context);
        const imageContext = activeSession?.messages?.[Number(messageIndex)]?.imageContext;
        if (imageContext) imageCandidates.push(imageContext);
      }
      const displayItemId = node.dataset.displayItemId || node.__displayItem?.id || '';
      if (displayItemId) {
        const item = (activeSession?.display || []).find(item => item.id === displayItemId);
        if (item?.attachmentContext) candidates.push(item.attachmentContext);
        if (item?.imageContext) imageCandidates.push(item.imageContext);
      }
      for (const candidate of candidates) if (candidate) try { return typeof candidate === 'string' ? JSON.parse(candidate) : candidate; } catch {}
      for (const candidate of imageCandidates) if (candidate) try { return typeof candidate === 'string' ? JSON.parse(candidate) : candidate; } catch {}
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

    function getUploadedImageContextByReference(sessionId = getState().activeSessionId, referenceId = '') {
      const rawReference = parseImageReferenceId(referenceId);
      if (!rawReference || !String(rawReference).startsWith('uploaded_')) return null;
      const messageIndex = Number(String(rawReference).replace(/^uploaded_/, '')) - 1;
      if (!Number.isFinite(messageIndex) || messageIndex < 0) return null;
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId) || getActiveSession();
      const context = parseImageContext(session?.messages?.[messageIndex]?.imageContext);
      return context?.attachments?.length && (context.target === 'uploaded' || context.mode === 'edit_image') ? context : null;
    }

    function getUploadedImageContext(sessionId = getState().activeSessionId, referenceId = '') {
      return getUploadedImageContextByReference(sessionId, referenceId) || getLatestUploadedImageContext(sessionId);
    }

    async function restoreImageAttachmentsFromContext(context, { role = 'target' } = {}) {
      const sourceAttachments = role === 'mask'
        ? (context?.masks || context?.maskAttachments || context?.mask_attachments || [])
        : context?.attachments || [];
      const attachments = Array.isArray(sourceAttachments) ? sourceAttachments : [];
      const result = [];
      for (const item of attachments) {
        if (!item?.src) continue;
        const file = await imageRefToFile(item.src, item.name || 'image.png');
        result.push({ file, name: item.name || file.name, type: item.type || file.type || 'image/png', size: file.size, dataUrl: item.src, text: '', fromPrevious: !!item.fromPrevious, sourceIndex: Number(item.sourceIndex) || 0, imageId: item.imageId || '', referenceId: item.referenceId || '', routeResourceKey: item.routeResourceKey || '', routeRole: item.routeRole || (role === 'mask' ? 'mask' : ''), routeSource: item.routeSource || '' });
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

    function generatedImageForReference(sessionId, referenceId = '') {
      const state = getState();
      const session = (state.sessions || []).find(item => item.id === sessionId);
      const reference = parseImageReferenceId(referenceId);
      const historical = reference && reference !== 'latest'
        ? findImageReferenceById(sessionId, reference)
        : null;
      return normalizeLastGeneratedImage(
        historical
        || (reference === 'latest'
          ? (sessionId === state.activeSessionId ? state.lastGeneratedImage : session?.lastGeneratedImage)
          : null)
      );
    }

    function uploadedImageForReference(sessionId, referenceId = '') {
      const context = getUploadedImageContextByReference(sessionId, referenceId);
      if (!context?.attachments?.length) return null;
      return {
        images: context.attachments.map(item => ({
          src: item.src,
          filename: item.name || item.filename || 'previous-image.png',
          label: item.label || item.subject || '',
        })),
      };
    }

    function historicalImageForReference(sessionId, referenceId = '') {
      return uploadedImageForReference(sessionId, referenceId)
        || generatedImageForReference(sessionId, referenceId);
    }

    async function previousAttachmentFromImage(image, sourceIndex, referenceId, imageId = '') {
      const images = Array.isArray(image?.images) && image.images.length
        ? image.images
        : image?.src
          ? [{ src: image.src, filename: image.filename || 'previous-image.png' }]
          : [];
      const item = images[sourceIndex - 1];
      if (!item?.src) return null;
      const file = await imageRefToFile(item.src, item.filename || item.name || `previous-image-${sourceIndex}.png`);
      return {
        file,
        name: file.name,
        type: file.type || 'image/png',
        size: file.size,
        dataUrl: item.src,
        text: '',
        fromPrevious: true,
        sourceIndex,
        imageId: imageId || makeImageItemId(referenceId, sourceIndex),
        referenceId,
        label: item.label || item.subject || '',
      };
    }

    async function getPreviousImageAttachments(sessionId = getState().activeSessionId, selectedIndexes = null, referenceId = '', selectedImageIds = []) {
      const ids = normalizeSelectedImageIds(selectedImageIds);
      if (ids.length) {
        const result = [];
        const references = new Map();
        for (const imageId of ids) {
          const parsed = parseImageItemId?.(imageId);
          if (!parsed) continue;
          if (!references.has(parsed.referenceId)) {
            references.set(parsed.referenceId, historicalImageForReference(sessionId, parsed.referenceId));
          }
          const attachment = await previousAttachmentFromImage(
            references.get(parsed.referenceId),
            parsed.index,
            parsed.referenceId,
            imageId
          );
          if (attachment) result.push(attachment);
        }
        if (result.length !== ids.length) {
          throw new Error('\u9009\u62e9\u7684\u5386\u53f2\u56fe\u7247\u5df2\u4e22\u5931\uff0c\u8bf7\u91cd\u65b0\u9009\u62e9\u8981\u5408\u5e76\u7684\u56fe\u7247');
        }
        return result;
      }

      const reference = parseImageReferenceId(referenceId);
      const normalizedReferenceId = makeImageReferenceId(reference || 'latest');
      const image = historicalImageForReference(sessionId, normalizedReferenceId);
      const images = Array.isArray(image?.images) && image.images.length
        ? image.images
        : image?.src
          ? [{ src: image.src, filename: image.filename || 'previous-image.png' }]
          : [];
      const selection = normalizeImageSelection(selectedIndexes, images.length);
      const result = [];
      for (let index = 0; index < images.length; index += 1) {
        if (selection?.length && !selection.includes(index + 1)) continue;
        const attachment = await previousAttachmentFromImage(image, index + 1, normalizedReferenceId);
        if (attachment) result.push(attachment);
      }
      return result;
    }

    async function getPreviousImageAsAttachment(sessionId = getState().activeSessionId) { return (await getPreviousImageAttachments(sessionId))[0] || null; }

    function cleanAssistantImagePromptText(text = '') {
      return String(text || '')
        .replace(/\[base64 image\]/gi, '')
        .replace(/耗时：[^\n]+/g, '')
        .replace(/RT\s+[^\n]+/gi, '')
        .replace(/TTFT\s+[^\n]+/gi, '')
        .replace(/^\[图片(?:生成|编辑|修改)完成\]\s*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function previousUserPromptForAssistantNode(node) {
      const responseIndex = Number(node?.dataset?.responseIndex || node?.__displayItem?.responseIndex);
      const session = getActiveSession();
      const messages = Array.isArray(session?.messages) ? session.messages : [];
      if (Number.isFinite(responseIndex)) {
        for (let index = Math.min(responseIndex - 1, messages.length - 1); index >= 0; index -= 1) {
          const item = messages[index];
          if (item?.role === 'user') return cleanAssistantImagePromptText(item.rawText || item.content || '');
          if (item?.role === 'assistant') break;
        }
      }
      let prev = node?.previousElementSibling || null;
      while (prev) {
        if (prev.classList?.contains('user')) return cleanAssistantImagePromptText(prev.dataset.rawText || prev.innerText || prev.textContent || '');
        if (prev.classList?.contains('assistant')) break;
        prev = prev.previousElementSibling;
      }
      return '';
    }

    function getAssistantImageContext(node) {
      if (!node) return null;
      // Numbered clarification cards only mirror existing image candidates.
      // Quoting that assistant message must not turn the previews into a new
      // multi-image attachment source.
      if (node.matches?.('[data-clarification-image-choices="1"]') || node.querySelector?.('[data-clarification-image-choices="1"]')) return null;
      const candidates = [node.dataset.imageContext || '', node.__displayItem?.imageContext || ''];
      const session = getActiveSession();
      const displayItemId = node.dataset.displayItemId || node.__displayItem?.id || '';
      const responseIndex = Number(node.dataset.responseIndex || node.__displayItem?.responseIndex);
      if (displayItemId) {
        const item = (session.display || []).find(item => item.id === displayItemId);
        if (item?.imageContext) candidates.push(item.imageContext);
      }
      if (Number.isFinite(responseIndex)) {
        const message = Array.isArray(session?.messages) ? session.messages[responseIndex] : null;
        if (message?.imageContext) candidates.push(message.imageContext);
        const displayByResponse = (session.display || []).find(item => item?.role === 'assistant' && String(item.responseIndex || '') === String(responseIndex));
        if (displayByResponse?.imageContext) candidates.push(displayByResponse.imageContext);
      }
      for (const candidate of candidates) if (candidate) try {
        const context = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
        if (context && typeof context === 'object' && Array.isArray(context.attachments) && context.attachments.length) return context;
      } catch {}
      const images = [...node.querySelectorAll?.('img.generated-thumb, .generated-image-item img, img[data-persisted-src], img[data-original-src], img[data-persisted-url], img[data-object-url]') || []]
        .map((img, index) => {
          const src = img.dataset.persistedSrc || img.dataset.originalSrc || img.dataset.persistedUrl || img.dataset.objectUrl || img.currentSrc || img.src || '';
          if (!src) return null;
          const sourceIndex = Number(img.dataset.imageIndex) || index + 1;
          const imageId = img.dataset.imageId || '';
          const referenceFromImageId = imageId.match(/^img_(imgref_.+)_\d+$/)?.[1] || '';
          return {
            name: img.dataset.filename || `quoted-image-${sourceIndex}.png`,
            type: 'image/png',
            src,
            imageId: imageId || makeImageItemId('quote', sourceIndex),
            referenceId: img.dataset.referenceId || referenceFromImageId || makeImageReferenceId(displayItemId || 'quote'),
            sourceIndex,
          };
        })
        .filter(Boolean);
      if (images.length) {
        const referenceId = images[0].referenceId || makeImageReferenceId(displayItemId || 'quote');
        const contextPrompt = cleanAssistantImagePromptText(node.dataset.rawText || node.querySelector?.('.content')?.innerText || '') || previousUserPromptForAssistantNode(node);
        return normalizeImageContextForStorage({
          prompt: contextPrompt,
          mode: 'image',
          target: 'previous',
          referenceId,
          selectedReferenceId: referenceId,
          usePreviousImage: true,
          updatedAt: Date.now(),
          attachments: images,
        });
      }
      return null;
    }

    return Object.freeze({ serializeAttachmentEntry, attachmentPlaceholdersMarkdown, buildUserContentWithAttachmentPlaceholders, durableAttachmentRef, preferredImageAttachmentSrc, serializeImageAttachment, persistImageAttachmentRefs, normalizeImageContextForStorage, buildUploadedImageContext, persistGenericAttachmentSrc, buildUserAttachmentContext, restoreUserAttachmentsFromContext, getUserAttachmentContextFromNode, getLatestUploadedImageContext, getUploadedImageContextByReference, getUploadedImageContext, getLatestUploadedImageAttachments, setImageContext, restoreImageAttachmentsFromContext, getPreviousImageAttachments, getPreviousImageAsAttachment, getAssistantImageContext });
  }

  const api = Object.freeze({ createImageContextWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageContextWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageContextWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
