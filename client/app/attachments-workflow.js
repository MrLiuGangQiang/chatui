(function initChatUIAppAttachmentsWorkflow(root) {
  'use strict';

  const sharedFileInputs = root?.ChatUICore?.fileInputs
    || (typeof require === 'function' ? require('../../shared/file-inputs') : null);

  const DEFAULT_IMAGE_UPLOAD_LIMITS = Object.freeze({ maxLongEdge: 2048, maxBytes: 20 * 1024 * 1024, minQuality: 0.72 });
  const MIME_BY_EXT = Object.freeze({
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', csv: 'text/csv', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', js: 'text/javascript', ts: 'text/typescript', jsx: 'text/javascript', tsx: 'text/typescript', html: 'text/html', css: 'text/css', py: 'text/x-python', java: 'text/x-java', go: 'text/x-go', rs: 'text/x-rust', php: 'text/x-php', sql: 'text/x-sql', log: 'text/plain', conf: 'text/plain',
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp',
  });

  function inferMimeByName(name = '') {
    const sharedMime = sharedFileInputs?.inferMimeType?.(name);
    if (sharedMime && sharedMime !== 'application/octet-stream') return sharedMime;
    return MIME_BY_EXT[String(name || '').split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream';
  }

  function isBmpFile(file = {}) { return /image\/(bmp|x-ms-bmp)/i.test(file.type || '') || /\.bmp$/i.test(file.name || ''); }
  function replaceExt(name = 'image', ext = '') { const text = String(name || 'image'); return text.includes('.') ? text.replace(/\.[^.]*$/, ext) : `${text}${ext}`; }
  function canvasToBlob(canvas, type, quality) { return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片压缩失败')), type, quality)); }

  function createAttachmentsWorkflow(deps = {}) {
    const getState = deps.getState || (() => ({}));
    const getElement = deps.getElement || (() => null);
    const escapeHtml = deps.escapeHtml || (value => String(value || '').replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])));
    const autoResize = deps.autoResize || (() => {});
    const updateSendAvailability = deps.updateSendAvailability || (() => {});
    const openImagePreview = deps.openImagePreview || (() => {});
    const toast = deps.toast || (() => {});
    const isImageFile = deps.isImageFile || (() => false);
    const isCompressibleRasterImage = deps.isCompressibleRasterImage || (() => false);
    const formatBytes = deps.formatBytes || (value => `${Number(value) || 0} B`);
    const getImageBlob = deps.getImageBlob;
    const putImageBlob = deps.putImageBlob;
    const blobToDataUrl = deps.blobToDataUrl;
    const createImageBitmapImpl = deps.createImageBitmap || root.createImageBitmap?.bind(root);
    const documentRef = deps.document || root.document;
    const FileReaderCtor = deps.FileReader || root.FileReader;
    const FileCtor = deps.File || root.File;
    const limits = deps.imageUploadLimits || DEFAULT_IMAGE_UPLOAD_LIMITS;
    const fileInputs = deps.fileInputs || root?.ChatUICore?.fileInputs || sharedFileInputs || {};
    const input = getElement('fileInput');
    if (input && typeof fileInputs.acceptAttribute === 'function') input.accept = fileInputs.acceptAttribute({ includeImages: true });

    function inputFileMimeType(name = '', fallback = '') {
      const inferred = fileInputs.inferMimeType?.(name, fallback);
      return inferred && inferred !== 'application/octet-stream' ? inferred : inferMimeByName(name);
    }

    function ensureStateMap(state, key) {
      if (!(state[key] instanceof Map)) state[key] = new Map();
      return state[key];
    }

    function isDisposedSession(state, sessionId) {
      return !!sessionId && !!state.disposedSessionIds?.has?.(sessionId);
    }

    function sessionCanReceiveAttachments(state, sessionId) {
      if (isDisposedSession(state, sessionId)) return false;
      if (!sessionId) return true;
      return !Array.isArray(state.sessions) || !state.sessions.length || state.sessions.some(session => session?.id === sessionId);
    }

    function attachmentDraftFor(state, sessionId = state.activeSessionId) {
      if (isDisposedSession(state, sessionId)) return null;
      if (!sessionId) return Array.isArray(state.attachments) ? state.attachments : (state.attachments = []);
      const drafts = ensureStateMap(state, 'attachmentDrafts');
      if (!drafts.has(sessionId)) drafts.set(sessionId, sessionId === state.activeSessionId && Array.isArray(state.attachments) ? state.attachments : []);
      const draft = drafts.get(sessionId);
      if (Array.isArray(draft)) return draft;
      const empty = [];
      drafts.set(sessionId, empty);
      return empty;
    }

    function syncActiveAttachmentDraft(state) {
      const sessionId = state.activeSessionId;
      if (!sessionId || isDisposedSession(state, sessionId)) return Array.isArray(state.attachments) ? state.attachments : [];
      const drafts = ensureStateMap(state, 'attachmentDrafts');
      const attachments = Array.isArray(state.attachments) ? state.attachments : [];
      if (drafts.get(sessionId) !== attachments) drafts.set(sessionId, attachments);
      return attachments;
    }

    function attachmentDraftVersion(state, sessionId) {
      const versions = ensureStateMap(state, 'attachmentDraftVersions');
      return Number(versions.get(sessionId) || 0);
    }

    function uploadTaskSessionId(state, taskId, fallback = state.activeSessionId) {
      return ensureStateMap(state, 'uploadTaskSessionIds').get(taskId) || fallback;
    }

    function uploadTasksFor(state, sessionId = state.activeSessionId) {
      if (isDisposedSession(state, sessionId)) return [];
      if (!sessionId) return Array.isArray(state.uploadTasks) ? state.uploadTasks : (state.uploadTasks = []);
      const drafts = ensureStateMap(state, 'uploadTaskDrafts');
      if (!drafts.has(sessionId)) drafts.set(sessionId, sessionId === state.activeSessionId && Array.isArray(state.uploadTasks) ? state.uploadTasks : []);
      const tasks = drafts.get(sessionId);
      if (Array.isArray(tasks)) return tasks;
      const empty = [];
      drafts.set(sessionId, empty);
      return empty;
    }

    function syncActiveUploadTasks(state) {
      const sessionId = state.activeSessionId;
      if (!sessionId || isDisposedSession(state, sessionId)) return Array.isArray(state.uploadTasks) ? state.uploadTasks : [];
      const drafts = ensureStateMap(state, 'uploadTaskDrafts');
      const tasks = Array.isArray(state.uploadTasks) ? state.uploadTasks : [];
      if (drafts.get(sessionId) !== tasks) drafts.set(sessionId, tasks);
      return tasks;
    }

    function renderAttachments() {
      const state = getState();
      const attachments = syncActiveAttachmentDraft(state);
      const bar = getElement('attachmentBar');
      if (!bar) return;
      bar.innerHTML = attachments.map((item, index) => {
        const image = String(item.type || '').startsWith('image/');
        const preview = image
          ? `<button class="attachment-thumb-btn" type="button" data-preview-attachment="${index}" title="打开预览：${escapeHtml(item.name)}" aria-label="打开预览：${escapeHtml(item.name)}"><img src="${escapeHtml(item.dataUrl)}" alt="" /></button>`
          : `<span class="file-icon">${escapeHtml(String(item.name || '').split('.').pop() || 'FILE')}</span>`;
        const note = item.compressionNote
          ? `<em title="${escapeHtml(item.compressionNote)}">已压缩</em>`
          : item.inputFile || item.text || item.dataUrl ? '' : `<em title="${escapeHtml(item.unsupportedReason || '暂不支持解析')}">未解析</em>`;
        const detail = !image && fileInputs.isPdfFile?.(item)
          ? `<label class="attachment-pdf-detail" title="PDF 页面图像处理清晰度"><span>PDF</span><select data-pdf-detail="${index}" aria-label="${escapeHtml(item.name)} PDF 清晰度"><option value="auto"${item.pdfDetail === 'auto' || !item.pdfDetail ? ' selected' : ''}>自动</option><option value="low"${item.pdfDetail === 'low' ? ' selected' : ''}>低</option><option value="high"${item.pdfDetail === 'high' ? ' selected' : ''}>高</option></select></label>`
          : '';
        return `<div class="attachment-chip${image ? ' attachment-chip-image' : ''}"${image ? ` data-preview-attachment="${index}" role="button" tabindex="0" aria-label="打开预览：${escapeHtml(item.name)}"` : ''} title="${escapeHtml(item.compressionNote || item.unsupportedReason || item.name)}">${preview}<span>${escapeHtml(item.name)}</span>${note}${detail}<button type="button" data-remove-attachment="${index}">×</button></div>`;
      }).join('');
      bar.classList.toggle('show', attachments.length > 0);
      bar.querySelectorAll('[data-preview-attachment]').forEach(node => {
        const open = () => { const item = attachments[Number(node.dataset.previewAttachment)]; if (item?.dataUrl) openImagePreview(item.dataUrl); };
        node.addEventListener('click', event => { if (!event.target.closest('[data-remove-attachment]')) open(); });
        node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      });
      bar.querySelectorAll('[data-remove-attachment]').forEach(node => node.addEventListener('click', event => {
        event.stopPropagation();
        attachments.splice(Number(node.dataset.removeAttachment), 1);
        renderAttachments();
        autoResize();
      }));
      bar.querySelectorAll('[data-pdf-detail]').forEach(node => node.addEventListener('change', event => {
        event.stopPropagation();
        const item = attachments[Number(node.dataset.pdfDetail)];
        if (item) item.pdfDetail = fileInputs.normalizePdfDetail?.(node.value) || node.value || 'auto';
      }));
    }

    function focusComposerSubmitTarget() {
      const prompt = getElement('prompt');
      const send = getElement('sendBtn');
      const target = prompt && !prompt.disabled ? prompt : send;
      const focus = () => target?.focus?.();
      if (root.requestAnimationFrame) root.requestAnimationFrame.call(root, focus);
      else root.setTimeout?.call(root, focus, 0);
      root.setTimeout?.call(root, focus, 80);
    }

    function hasPendingUploads(sessionId = getState().activeSessionId) { return uploadTasksFor(getState(), sessionId).some(task => !task.done && !task.error); }
    function renderUploadProgress() {
      const state = getState();
      const node = getElement('uploadProgress');
      if (!node) return;
      const tasks = syncActiveUploadTasks(state);
      node.innerHTML = tasks.map(task => {
        const percent = Math.max(0, Math.min(100, Math.round(task.percent || 0)));
        const status = task.error ? String(task.status || '处理失败') : task.done ? '完成' : task.status || '处理中';
        const errorAttributes = task.error ? ' role="alert" aria-live="assertive"' : '';
        const dismissButton = task.error ? `<button type="button" class="upload-progress-dismiss" data-dismiss-upload-error="${escapeHtml(task.id || '')}" aria-label="关闭 ${escapeHtml(task.name || '文件')} 的上传错误" title="关闭错误提示">×</button>` : '';
        const errorDetail = task.error ? `<div class="upload-progress-error">${escapeHtml(status)}</div>` : '';
        const progressStatus = task.error ? '上传失败' : `${status} · ${percent}%`;
        return `<div class="upload-progress-item${task.error ? ' error' : ''}${task.done ? ' done' : ''}"${errorAttributes}><div class="upload-progress-row"><span class="upload-progress-name">${escapeHtml(task.name || '文件')}</span><span class="upload-progress-actions"><span class="upload-progress-percent">${escapeHtml(progressStatus)}</span>${dismissButton}</span></div>${errorDetail}<div class="upload-progress-track"><i style="width:${percent}%"></i></div></div>`;
      }).join('');
      node.classList.toggle('show', tasks.length > 0);
      node.querySelectorAll?.('[data-dismiss-upload-error]').forEach(button => button.addEventListener('click', () => {
        const taskId = String(button.dataset.dismissUploadError || '');
        const index = tasks.findIndex(task => String(task?.id || '') === taskId && task?.error);
        if (index < 0) return;
        const [removed] = tasks.splice(index, 1);
        ensureStateMap(state, 'uploadTaskSessionIds').delete(removed?.id);
        renderUploadProgress();
        autoResize();
      }));
      updateSendAvailability();
    }
    function setUploadTask(id, patch = {}, sessionId = null) {
      const state = getState();
      const targetSessionId = sessionId || uploadTaskSessionId(state, id);
      const task = uploadTasksFor(state, targetSessionId).find(item => item.id === id);
      if (!task) return;
      Object.assign(task, patch);
      if (targetSessionId === state.activeSessionId) { renderUploadProgress(); autoResize(); }
    }
    function finishUploadProgressSoon(sessionId = getState().activeSessionId) {
      const state = getState();
      const timers = ensureStateMap(state, 'uploadProgressTimers');
      const previous = timers.get(sessionId);
      if (previous !== undefined) {
        if (typeof root.clearTimeout === 'function') root.clearTimeout.call(root, previous);
        else clearTimeout(previous);
      }
      const finish = () => {
        timers.delete(sessionId);
        if (!sessionCanReceiveAttachments(state, sessionId)) return;
        const tasks = uploadTasksFor(state, sessionId);
        const taskSessionIds = ensureStateMap(state, 'uploadTaskSessionIds');
        const failedTasks = tasks.filter(task => task?.error);
        tasks.forEach(task => {
          if (!task?.error && taskSessionIds.get(task?.id) === sessionId) taskSessionIds.delete(task.id);
        });
        tasks.splice(0, tasks.length, ...failedTasks);
        if (sessionId === state.activeSessionId) {
          state.uploadTasks = tasks;
          renderUploadProgress();
          autoResize();
          updateSendAvailability();
        }
      };
      const timer = typeof root.setTimeout === 'function' ? root.setTimeout.call(root, finish, 250) : setTimeout(finish, 250);
      timers.set(sessionId, timer);
    }
    function setUploadPhase(id, phase, percent = 0, sessionId = getState().activeSessionId) { setUploadTask(id, { phase, percent: Math.max(0, Math.min(100, Math.round(percent))), status: phase }, sessionId); }
    function setUploadPhaseProgress(id, phase, loaded, total, sessionId = getState().activeSessionId) { const done = Number(loaded) || 0; const all = Number(total) || 0; setUploadPhase(id, phase, all > 0 ? 100 * done / all : 0, sessionId); }
    function startTimedUploadPhase(id, phase, start = 8, end = 96, intervalMs = 220, sessionId = getState().activeSessionId) { const started = root.performance?.now ? root.performance.now() : Date.now(); setUploadPhase(id, phase, start, sessionId); return setInterval(() => { const elapsed = (root.performance?.now ? root.performance.now() : Date.now()) - started; const value = start + (end - start) * (1 - Math.exp(-elapsed / 4200)); setUploadPhase(id, phase, Math.min(end, value), sessionId); }, intervalMs); }

    function readFileAsDataURL(file, taskId = null, phase = '读取文件') { return new Promise((resolve, reject) => { const reader = new FileReaderCtor(); reader.onload = () => { if (taskId) setUploadPhase(taskId, phase, 100); resolve(reader.result); }; reader.onerror = reject; reader.onprogress = event => { if (taskId && event.lengthComputable) setUploadPhaseProgress(taskId, phase, event.loaded, event.total); }; reader.readAsDataURL(file); }); }
    async function dataUrlToFile(url, name = 'previous-image.png') { const response = await fetch(url); const blob = await response.blob(); return new FileCtor([blob], name, { type: blob.type || 'image/png' }); }
    async function urlToImageFile(url, name = 'previous-image.png') { const response = await fetch(url); if (!response.ok) throw new Error('无法读取上一张图片作为编辑参考'); const blob = await response.blob(); return new FileCtor([blob], name, { type: blob.type || 'image/png' }); }
    async function imageRefToFile(ref, name = 'previous-image.png') { if (!ref) return null; if (ref.startsWith('indexeddb://')) { const blob = await getImageBlob(ref.replace('indexeddb://', '')); if (!blob) throw new Error('图片缓存不存在，无法继续编辑'); return new FileCtor([blob], name, { type: blob.type || 'image/png' }); } return ref.startsWith('data:') ? dataUrlToFile(ref, name) : urlToImageFile(ref, name); }
    async function imageRefToDataUrl(ref, name = 'image.png') { if (!ref) return ''; if (ref.startsWith('data:')) return ref; if (ref.startsWith('indexeddb://')) { const blob = await getImageBlob(ref.replace('indexeddb://', '')); if (!blob) throw new Error('图片缓存不存在，无法继续发送'); return blobToDataUrl(blob); } return ref; }

    function ensureAttachmentId(item = {}, index = 0) {
      const existing = item.attachmentId || item.attachment_id || item.id || '';
      if (existing) return String(existing);
      const safeName = String(item.name || item.file?.name || 'attachment').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'attachment';
      const id = `att_${Date.now().toString(36)}_${index + 1}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
      item.attachmentId = id;
      return id;
    }

    async function persistInputFile(item, index = 0) {
      if (!item?.file || typeof putImageBlob !== 'function') return '';
      const attachmentId = ensureAttachmentId(item, index);
      const safeId = String(attachmentId).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || `file-${index + 1}`;
      const key = `attachment-file-${safeId}`;
      await putImageBlob(key, item.file);
      item.persistedSrc = `indexeddb://${key}`;
      return item.persistedSrc;
    }

    async function attachmentFile(item = {}) {
      if (item.file) return item.file;
      const ref = String(item.persistedSrc || item.persisted_src || item.src || item.dataUrl || item.data_url || '');
      if (!ref) return null;
      return imageRefToFile(ref, item.name || 'attachment');
    }

    function needsInputFileData(item = {}) {
      return item.inputFile === true
        || item.input_file === true
        || /^data:[^,]+;base64,/i.test(String(item.fileData || item.file_data || ''))
        || !!String(item.text || '').trim()
        || !!(item.file || item.persistedSrc || item.persisted_src || item.src || item.dataUrl || item.data_url);
    }

    function withoutTransientFileMetadata(item = {}) {
      return Object.fromEntries(Object.entries(item).filter(([key]) => {
        if (key === 'status' || key === 'error' || key === 'fileData' || key === 'file_data') return false;
        return !key.startsWith('upstream');
      }));
    }

    function abortIfRequested(signal) {
      if (!signal?.aborted) return;
      const error = new Error('File input preparation was cancelled');
      error.name = 'AbortError';
      throw error;
    }

    function normalizeInputFileDataUrl(value, mimeType) {
      const raw = String(value || '');
      const comma = raw.indexOf(',');
      if (comma <= 0 || !/;base64$/i.test(raw.slice(0, comma))) {
        throw Object.assign(new Error('Failed to encode the file input as Base64'), { code: 'FILE_DATA_ENCODING_FAILED' });
      }
      return `data:${mimeType};base64,${raw.slice(comma + 1)}`;
    }

    async function readInputFileData(file, item = {}, signal) {
      abortIfRequested(signal);
      const filename = file.name || item.name || 'attachment';
      const mimeType = inputFileMimeType(filename, file.type || item.type);
      let dataUrl = '';
      if (typeof blobToDataUrl === 'function') {
        dataUrl = await blobToDataUrl(file);
      } else if (typeof FileReaderCtor === 'function') {
        dataUrl = await readFileAsDataURL(file);
      } else if (typeof file.arrayBuffer === 'function') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (typeof root?.btoa === 'function') {
          const chunks = [];
          const chunkSize = 0x8000;
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
          }
          dataUrl = `data:${mimeType};base64,${root.btoa(chunks.join(''))}`;
        } else if (typeof Buffer !== 'undefined') {
          dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
        }
      }
      abortIfRequested(signal);
      return normalizeInputFileDataUrl(dataUrl, mimeType);
    }

    function utf8Bytes(value = '') {
      const text = String(value || '');
      const Encoder = root?.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
      if (Encoder) return new Encoder().encode(text);
      if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'utf8'));
      const encoded = unescape(encodeURIComponent(text));
      return Uint8Array.from(encoded, char => char.charCodeAt(0));
    }

    function bytesToBase64(bytes = new Uint8Array()) {
      if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
      if (typeof root?.btoa !== 'function') {
        throw Object.assign(new Error('Failed to encode the extracted file text as Base64'), { code: 'FILE_DATA_ENCODING_FAILED' });
      }
      const chunks = [];
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
      }
      return root.btoa(chunks.join(''));
    }

    function extractedTextInputFile(item = {}) {
      const text = String(item.text || '');
      if (!text.trim()) return null;
      const name = String(item.name || 'attachment.txt');
      const type = inputFileMimeType(name, item.type || 'text/plain');
      const bytes = utf8Bytes(text);
      return {
        name,
        type,
        size: bytes.byteLength,
        fileData: `data:${type};base64,${bytesToBase64(bytes)}`,
      };
    }

    function inputFileDataSize(value = '') {
      const data = String(value || '').split(',', 2)[1] || '';
      if (!data) return 0;
      const normalized = data.replace(/\s+/g, '');
      const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
      return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding);
    }

    function chatVisionDetail(item = {}, options = {}) {
      const declared = String(item.imageDetail || item.image_detail || item.visionDetail || item.vision_detail || '').trim().toLowerCase();
      if (['low', 'high', 'auto'].includes(declared)) return declared;
      return String(options.operation || options.operationType || '').trim() === 'ocr' ? 'low' : '';
    }

    function prepareChatImageVision(item = {}, options = {}) {
      const detail = chatVisionDetail(item, options);
      return detail ? { ...item, imageDetail: detail } : item;
    }

    async function prepareChatAttachments(list = [], options = {}) {
      const prepared = await ensureChatAttachmentImageDataUrls(list);
      const documents = prepared.filter(item => !isImageFile(item));
      if (!documents.length) return prepared.map(item => prepareChatImageVision(item, options));
      const resolvedDocuments = new Map();
      for (const item of documents) {
        if (!needsInputFileData(item)) continue;
        abortIfRequested(options.signal);
        const existingFileData = String(item.fileData || item.file_data || '');
        if (/^data:[^,]+;base64,/i.test(existingFileData)) {
          resolvedDocuments.set(item, {
            kind: 'data',
            name: item.name || 'attachment',
            type: inputFileMimeType(item.name, item.type),
            size: Number(item.size) || inputFileDataSize(existingFileData),
            fileData: normalizeInputFileDataUrl(existingFileData, inputFileMimeType(item.name, item.type)),
          });
          continue;
        }
        const file = await attachmentFile(item);
        if (file) {
          resolvedDocuments.set(item, {
            kind: 'file',
            file,
            name: file.name || item.name || 'attachment',
            type: inputFileMimeType(file.name || item.name, file.type || item.type),
            size: Number(file.size) || 0,
          });
          continue;
        }
        const extracted = extractedTextInputFile(item);
        if (extracted) resolvedDocuments.set(item, { kind: 'text', ...extracted });
      }
      fileInputs.validateRequestFiles?.([...resolvedDocuments.values()].map(document => ({
        name: document.name,
        type: document.type,
        size: document.size,
      })));
      const result = [];
      for (const item of prepared) {
        if (isImageFile(item)) {
          result.push(prepareChatImageVision(item, options));
          continue;
        }
        if (!needsInputFileData(item)) {
          result.push(withoutTransientFileMetadata(item));
          continue;
        }
        const document = resolvedDocuments.get(item);
        if (!document) throw Object.assign(new Error(`附件内容不可用，请重新上传：${item.name || 'attachment'}`), { code: 'FILE_CONTENT_UNAVAILABLE' });
        const fileData = document.kind === 'file'
          ? await readInputFileData(document.file, item, options.signal)
          : document.fileData;
        result.push({
          ...withoutTransientFileMetadata(item),
          ...(document.file ? { file: document.file } : {}),
          name: document.name,
          type: document.type,
          size: document.size,
          inputFile: true,
          fileData,
          text: '',
        });
      }
      return result;
    }
    async function prepareChatImageAttachments(list = []) {
      const result = [];
      for (const source of list || []) {
        if (!isImageFile(source)) { result.push(source); continue; }
        try {
          let file = source.file || await imageRefToFile(String(source.dataUrl || source.previewSrc || source.src || ''), source.name || 'image.png');
          if (isBmpFile({ name: file.name, type: file.type || inferMimeByName(file.name) })) file = await convertBmpToPng(file);
          const compressed = await compressImageIfNeeded(file);
          file = compressed.file;
          result.push({ ...source, file, name: file.name, type: file.type || inferMimeByName(file.name), size: file.size, dataUrl: await readFileAsDataURL(file), compressionNote: compressed.changed ? (source.compressionNote ? `${source.compressionNote}；${compressed.note}` : compressed.note) : (source.compressionNote || '') });
        } catch (err) {
          console.warn('prepare chat image attachment failed', err);
          result.push({ ...source, dataUrl: '', unsupportedReason: source.unsupportedReason || '图片缓存不存在，无法发送给聊天模型' });
        }
      }
      return result;
    }

    async function ensureChatAttachmentImageDataUrls(list = []) {
      const result = [];
      for (const item of list || []) {
        if (!isImageFile(item)) { result.push(item); continue; }
        const ref = String(item.dataUrl || item.previewSrc || item.src || '');
        if (/^data:image\//i.test(ref)) { result.push({ ...item, dataUrl: ref }); continue; }
        try {
          if (ref.startsWith('indexeddb://')) result.push({ ...item, dataUrl: await imageRefToDataUrl(ref, item.name || 'image.png') });
          else if (item.file) result.push({ ...item, dataUrl: await readFileAsDataURL(item.file) });
          else result.push({ ...item, dataUrl: '', unsupportedReason: item.unsupportedReason || '图片未成功读取，无法发送给聊天模型' });
        } catch (err) { console.warn('restore chat image data url failed', err); result.push({ ...item, dataUrl: '', unsupportedReason: item.unsupportedReason || '图片缓存不存在，无法发送给聊天模型' }); }
      }
      return result;
    }

    async function compressImageIfNeeded(file, currentLimits = limits) {
      if (!isCompressibleRasterImage(file)) return { file, changed: false };
      let bitmap = null;
      try {
        bitmap = await createImageBitmapImpl(file);
        const longEdge = Math.max(bitmap.width, bitmap.height);
        const needsResize = longEdge > currentLimits.maxLongEdge;
        const needsSize = file.size > currentLimits.maxBytes;
        if (!needsResize && !needsSize) return { file, changed: false };
        const scale = Math.min(1, currentLimits.maxLongEdge / longEdge);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = documentRef.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d', { alpha: true }).drawImage(bitmap, 0, 0, width, height);
        const sourceType = file.type || inferMimeByName(file.name);
        const type = /image\/png/i.test(sourceType) ? 'image/png' : /image\/webp/i.test(sourceType) ? 'image/webp' : 'image/jpeg';
        let blob = await canvasToBlob(canvas, type, 0.9);
        if (blob.size > currentLimits.maxBytes && type !== 'image/png') for (const quality of [0.82, 0.76, currentLimits.minQuality]) { blob = await canvasToBlob(canvas, type, quality); if (blob.size <= currentLimits.maxBytes) break; }
        if (blob.size > currentLimits.maxBytes && type === 'image/png') for (const quality of [0.88, 0.8, currentLimits.minQuality]) { blob = await canvasToBlob(canvas, 'image/jpeg', quality); if (blob.size <= currentLimits.maxBytes) break; }
        const outputType = blob.type || type;
        const ext = outputType.includes('webp') ? '.webp' : outputType.includes('jpeg') ? '.jpg' : '.png';
        const output = new FileCtor([blob], replaceExt(file.name, ext), { type: outputType, lastModified: Date.now() });
        const reasons = [];
        if (needsResize) reasons.push(`分辨率 ${bitmap.width}×${bitmap.height}`);
        if (needsSize) reasons.push(`大小 ${formatBytes(file.size)}`);
        return { file: output, changed: true, note: `${reasons.join('、')} 较大，已自动压缩为 ${width}×${height} / ${formatBytes(output.size)}` };
      } catch (err) {
        console.warn('compress image failed', err);
        return { file, changed: false };
      } finally { bitmap?.close?.(); }
    }
    async function convertBmpToPng(file) { const bitmap = await createImageBitmapImpl(file); try { const canvas = documentRef.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); const blob = await new Promise((resolve, reject) => canvas.toBlob(item => item ? resolve(item) : reject(new Error('BMP 转 PNG 失败')), 'image/png')); return new FileCtor([blob], replaceExt(file.name, '.png'), { type: 'image/png' }); } finally { bitmap.close?.(); } }

    async function addFiles(files) {
      const incoming = [...files];
      if (!incoming.length) return;
      const state = getState();
      const sessionId = state.activeSessionId;
      if (!sessionCanReceiveAttachments(state, sessionId)) return;
      const draftVersion = attachmentDraftVersion(state, sessionId);
      state.uploadTasks = incoming.map((file, index) => ({ id: `upload_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`, name: file.name || '文件', percent: 0, status: '等待中', phase: '等待中', done: false, error: false }));
      const uploadTasks = state.uploadTasks;
      ensureStateMap(state, 'uploadTaskDrafts').set(sessionId, uploadTasks);
      const taskSessionIds = ensureStateMap(state, 'uploadTaskSessionIds');
      uploadTasks.forEach(task => taskSessionIds.set(task.id, sessionId));
      renderUploadProgress();

      const documentErrors = new Map();
      const acceptedIncomingDocuments = [];
      incoming.forEach((file, index) => {
        const descriptor = { name: file.name, type: file.type || inferMimeByName(file.name), size: file.size };
        if (isImageFile(descriptor)) return;
        try {
          fileInputs.validateFile?.(descriptor);
          acceptedIncomingDocuments.push({ index, file: descriptor });
        } catch (err) {
          documentErrors.set(index, err);
        }
      });
      if (acceptedIncomingDocuments.length && typeof fileInputs.validateRequestFiles === 'function') {
        const existingDocuments = (attachmentDraftFor(state, sessionId) || [])
          .filter(item => !isImageFile(item))
          .map(item => ({ name: item.name, type: item.type, size: item.size || item.file?.size }));
        try {
          fileInputs.validateRequestFiles([...existingDocuments, ...acceptedIncomingDocuments.map(item => item.file)]);
        } catch (err) {
          acceptedIncomingDocuments.forEach(item => documentErrors.set(item.index, err));
        }
      }

      for (let index = 0; index < incoming.length; index += 1) {
        const taskId = uploadTasks[index]?.id;
        try {
          let file = incoming[index];
          let originalName = '';
          setUploadPhase(taskId, '准备文件', 8);
          const inputType = file.type || inferMimeByName(file.name);
          if (isBmpFile({ name: file.name, type: inputType })) try { setUploadPhase(taskId, '转换 BMP', 10); file = await convertBmpToPng(file); setUploadPhase(taskId, '转换 BMP', 100); originalName = incoming[index].name; } catch { file = incoming[index]; }
          let compressionNote = '';
          const type = file.type || inferMimeByName(file.name);
          if (isImageFile({ name: file.name, type })) { setUploadPhase(taskId, '检查图片', 18); const compressed = await compressImageIfNeeded(file); setUploadPhase(taskId, '检查图片', 100); file = compressed.file; compressionNote = compressed.changed ? compressed.note : ''; }
          const item = { file, name: file.name, originalName: originalName || (compressionNote ? incoming[index].name : ''), type: file.type || inferMimeByName(file.name), size: file.size, dataUrl: '', text: '', unsupportedReason: '', compressionNote };
          if (isImageFile(item)) {
            item.dataUrl = await readFileAsDataURL(file, taskId, '读取图片');
          } else {
            const validationError = documentErrors.get(index);
            if (validationError) throw validationError;
            fileInputs.validateFile?.(item);
            item.attachmentId = ensureAttachmentId(item, index);
            item.inputFile = true;
            if (fileInputs.isPdfFile?.(item)) item.pdfDetail = 'auto';
            setUploadPhase(taskId, '保存文件', 35);
            await persistInputFile(item, index);
            setUploadPhase(taskId, '保存文件', 100);
          }
          setUploadPhase(taskId, '添加到附件', 80);
          const draft = attachmentDraftFor(state, sessionId);
          if (draft && sessionCanReceiveAttachments(state, sessionId) && attachmentDraftVersion(state, sessionId) === draftVersion) {
            draft.push(item);
            if (sessionId === state.activeSessionId) {
              state.attachments = draft;
              renderAttachments();
              autoResize();
            }
          }
          setUploadTask(taskId, { percent: 100, status: '已添加', phase: '添加到附件', done: true });
          if (item.compressionNote) toast(item.compressionNote);
        } catch (err) {
          console.warn('add file failed', err);
          setUploadTask(taskId, { percent: 100, status: err?.message || '处理失败', error: true, done: true });
        }
      }
      autoResize();
      finishUploadProgressSoon(sessionId);
      focusComposerSubmitTarget();
    }

    function clearAttachments(sessionId = getState().activeSessionId) {
      const state = getState();
      const draft = attachmentDraftFor(state, sessionId);
      if (!draft) return;
      draft.splice(0, draft.length);
      const versions = ensureStateMap(state, 'attachmentDraftVersions');
      versions.set(sessionId, attachmentDraftVersion(state, sessionId) + 1);
      if (sessionId === state.activeSessionId) {
        state.attachments = draft;
        renderAttachments();
      }
    }

    return Object.freeze({
      renderAttachments, hasPendingUploads, renderUploadProgress, setUploadTask, finishUploadProgressSoon, setUploadPhase, setUploadPhaseProgress, startTimedUploadPhase,
      readFileAsDataURL, dataUrlToFile, urlToImageFile, imageRefToFile, imageRefToDataUrl, prepareChatImageAttachments, ensureChatAttachmentImageDataUrls,
      ensureAttachmentId, persistInputFile, attachmentFile, prepareChatAttachments,
      compressImageIfNeeded, convertBmpToPng, addFiles, clearAttachments,
    });
  }

  const api = Object.freeze({
    DEFAULT_IMAGE_UPLOAD_LIMITS, inferMimeByName, isBmpFile, replaceExt, canvasToBlob, createAttachmentsWorkflow,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppAttachmentsWorkflow = api;
  if (root?.window) root.window.ChatUIAppAttachmentsWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
