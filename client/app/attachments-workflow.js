(function initChatUIAppAttachmentsWorkflow(root) {
  'use strict';

  const DEFAULT_IMAGE_UPLOAD_LIMITS = Object.freeze({ maxLongEdge: 2048, maxBytes: 20 * 1024 * 1024, minQuality: 0.72 });
  const MIME_BY_EXT = Object.freeze({
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', csv: 'text/csv', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', js: 'text/javascript', ts: 'text/typescript', jsx: 'text/javascript', tsx: 'text/typescript', html: 'text/html', css: 'text/css', py: 'text/x-python', java: 'text/x-java', go: 'text/x-go', rs: 'text/x-rust', php: 'text/x-php', sql: 'text/x-sql', log: 'text/plain', conf: 'text/plain',
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp',
  });

  function inferMimeByName(name = '') {
    return MIME_BY_EXT[String(name || '').split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream';
  }

  function isPdfFile(file = {}) { return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''); }
  function isOfficeFile(file = {}) { return /\.(docx?|xlsx?|pptx?)$/i.test(file.name || '') || /(wordprocessingml|spreadsheetml|presentationml|msword|ms-excel|ms-powerpoint)/.test(file.type || ''); }
  function isExcelFile(file = {}) { return /\.(xlsx|xlsm)$/i.test(file.name || '') || /spreadsheetml\.sheet|spreadsheetml|ms-excel/.test(file.type || ''); }
  function canExtractOfficeText(file = {}) { return /\.(xlsx|xlsm|xls|pptx|ppt|docx|doc)$/i.test(file.name || '') || /(spreadsheetml|presentationml|wordprocessingml|msword|ms-excel|ms-powerpoint)/.test(file.type || ''); }
  function canExtractAttachmentText(file = {}) { return isPdfFile(file) || canExtractOfficeText(file); }
  function isProbablyTextFile(file = {}) { return /text|json|xml|csv|markdown|javascript|typescript|yaml|html|css|sql/.test(file.type || '') || /\.(txt|md|markdown|json|csv|xml|yaml|yml|js|ts|jsx|tsx|html|css|py|java|go|rs|php|sql|log|conf|ini|env|sh|bash|zsh|toml|lock)$/i.test(file.name || ''); }
  function isBmpFile(file = {}) { return /image\/(bmp|x-ms-bmp)/i.test(file.type || '') || /\.bmp$/i.test(file.name || ''); }
  function replaceExt(name = 'image', ext = '') { const text = String(name || 'image'); return text.includes('.') ? text.replace(/\.[^.]*$/, ext) : `${text}${ext}`; }
  function looksBinary(text = '') { if (!text) return false; const sample = String(text).slice(0, 2000); if (sample.includes('\0')) return true; return (sample.match(/[\u0000-\u0008\u000E-\u001F\uFFFD]/g) || []).length / sample.length > 0.05; }
  function decodeArrayBufferText(buffer, encoding, fatal = false) { if (typeof TextDecoder === 'undefined') return ''; try { return new TextDecoder(encoding, { fatal }).decode(buffer); } catch { return ''; } }
  function decodedTextQuality(text = '') { const sample = String(text || '').slice(0, 8000); if (!sample) return -1000; const bad = (sample.match(/\uFFFD/g) || []).length; const control = (sample.match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length; return 3 * (sample.match(/[\u3400-\u9fff]/g) || []).length + (sample.match(/[A-Za-z0-9]/g) || []).length + 0.2 * (sample.match(/\s/g) || []).length - 80 * bad - 40 * control; }
  function canvasToBlob(canvas, type, quality) { return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片压缩失败')), type, quality)); }

  function createAttachmentsWorkflow(deps = {}) {
    const getState = deps.getState || (() => ({}));
    const getElement = deps.getElement || (() => null);
    const escapeHtml = deps.escapeHtml || (value => String(value || '').replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])));
    const autoResize = deps.autoResize || (() => {});
    const updateSendAvailability = deps.updateSendAvailability || (() => {});
    const openImagePreview = deps.openImagePreview || (() => {});
    const toast = deps.toast || (() => {});
    const parseResponseJson = deps.parseResponseJson;
    const normalizeError = deps.normalizeError || ((_err, payload) => payload?.message || '请求失败');
    const isImageFile = deps.isImageFile || (() => false);
    const isCompressibleRasterImage = deps.isCompressibleRasterImage || (() => false);
    const formatBytes = deps.formatBytes || (value => `${Number(value) || 0} B`);
    const getImageBlob = deps.getImageBlob;
    const putImageBlob = deps.putImageBlob;
    const dataUrlToBlob = deps.dataUrlToBlob || (url => fetch(url).then(res => res.blob()));
    const blobToDataUrl = deps.blobToDataUrl;
    const createImageBitmapImpl = deps.createImageBitmap || root.createImageBitmap?.bind(root);
    const documentRef = deps.document || root.document;
    const FileReaderCtor = deps.FileReader || root.FileReader;
    const FileCtor = deps.File || root.File;
    const limits = deps.imageUploadLimits || DEFAULT_IMAGE_UPLOAD_LIMITS;

    function renderAttachments() {
      const state = getState();
      const bar = getElement('attachmentBar');
      if (!bar) return;
      bar.innerHTML = state.attachments.map((item, index) => {
        const image = String(item.type || '').startsWith('image/');
        const preview = image ? `<button class="attachment-thumb-btn" type="button" data-preview-attachment="${index}" title="打开预览：${escapeHtml(item.name)}" aria-label="打开预览：${escapeHtml(item.name)}"><img src="${escapeHtml(item.dataUrl)}" alt="" /></button>` : `<span class="file-icon">${escapeHtml(String(item.name || '').split('.').pop() || 'FILE')}</span>`;
        const note = item.compressionNote ? `<em title="${escapeHtml(item.compressionNote)}">已压缩</em>` : item.text || item.dataUrl ? '' : `<em title="${escapeHtml(item.unsupportedReason || '暂不支持解析')}">未解析</em>`;
        return `<div class="attachment-chip${image ? ' attachment-chip-image' : ''}"${image ? ` data-preview-attachment="${index}" role="button" tabindex="0" aria-label="打开预览：${escapeHtml(item.name)}"` : ''} title="${escapeHtml(item.compressionNote || item.unsupportedReason || item.name)}">${preview}<span>${escapeHtml(item.name)}</span>${note}<button type="button" data-remove-attachment="${index}">×</button></div>`;
      }).join('');
      bar.classList.toggle('show', state.attachments.length > 0);
      bar.querySelectorAll('[data-preview-attachment]').forEach(node => {
        const open = () => { const item = state.attachments[Number(node.dataset.previewAttachment)]; if (item?.dataUrl) openImagePreview(item.dataUrl); };
        node.addEventListener('click', event => { if (!event.target.closest('[data-remove-attachment]')) open(); });
        node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      });
      bar.querySelectorAll('[data-remove-attachment]').forEach(node => node.addEventListener('click', event => {
        event.stopPropagation();
        state.attachments.splice(Number(node.dataset.removeAttachment), 1);
        renderAttachments();
        autoResize();
      }));
    }

    function hasPendingUploads() { return (getState().uploadTasks || []).some(task => !task.done && !task.error); }
    function renderUploadProgress() {
      const state = getState();
      const node = getElement('uploadProgress');
      if (!node) return;
      const tasks = state.uploadTasks || [];
      node.innerHTML = tasks.map(task => {
        const percent = Math.max(0, Math.min(100, Math.round(task.percent || 0)));
        const status = task.error ? '失败' : task.done ? '完成' : task.status || '处理中';
        return `<div class="upload-progress-item${task.error ? ' error' : ''}${task.done ? ' done' : ''}"><div class="upload-progress-row"><span class="upload-progress-name">${escapeHtml(task.name || '文件')}</span><span class="upload-progress-percent">${escapeHtml(status)} · ${percent}%</span></div><div class="upload-progress-track"><i style="width:${percent}%"></i></div></div>`;
      }).join('');
      node.classList.toggle('show', tasks.length > 0);
      updateSendAvailability();
    }
    function setUploadTask(id, patch = {}) { const task = (getState().uploadTasks || []).find(item => item.id === id); if (task) { Object.assign(task, patch); renderUploadProgress(); autoResize(); } }
    function finishUploadProgressSoon() { const state = getState(); clearTimeout(state.uploadProgressTimer); state.uploadProgressTimer = setTimeout(() => { state.uploadTasks = []; renderUploadProgress(); autoResize(); updateSendAvailability(); }, 250); }
    function setUploadPhase(id, phase, percent = 0) { setUploadTask(id, { phase, percent: Math.max(0, Math.min(100, Math.round(percent))), status: phase }); }
    function setUploadPhaseProgress(id, phase, loaded, total) { const done = Number(loaded) || 0; const all = Number(total) || 0; setUploadPhase(id, phase, all > 0 ? 100 * done / all : 0); }
    function startTimedUploadPhase(id, phase, start = 8, end = 96, intervalMs = 220) { const started = root.performance?.now ? root.performance.now() : Date.now(); setUploadPhase(id, phase, start); return setInterval(() => { const elapsed = (root.performance?.now ? root.performance.now() : Date.now()) - started; const value = start + (end - start) * (1 - Math.exp(-elapsed / 4200)); setUploadPhase(id, phase, Math.min(end, value)); }, intervalMs); }

    function readFileAsDataURL(file, taskId = null, phase = '读取文件') { return new Promise((resolve, reject) => { const reader = new FileReaderCtor(); reader.onload = () => { if (taskId) setUploadPhase(taskId, phase, 100); resolve(reader.result); }; reader.onerror = reject; reader.onprogress = event => { if (taskId && event.lengthComputable) setUploadPhaseProgress(taskId, phase, event.loaded, event.total); }; reader.readAsDataURL(file); }); }
    function readFileAsArrayBuffer(file, taskId = null, phase = '读取文件') { return new Promise((resolve, reject) => { const reader = new FileReaderCtor(); reader.onload = () => { if (taskId) setUploadPhase(taskId, phase, 100); resolve(reader.result); }; reader.onerror = reject; reader.onprogress = event => { if (taskId && event.lengthComputable) setUploadPhaseProgress(taskId, phase, event.loaded, event.total); }; reader.readAsArrayBuffer(file); }); }
    async function readFileAsText(file, taskId = null) {
      const buffer = await readFileAsArrayBuffer(file, taskId);
      const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
      if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) return decodeArrayBufferText(buffer, 'utf-16le');
      if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) return decodeArrayBufferText(buffer, 'utf-16be');
      if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) return decodeArrayBufferText(buffer, 'utf-8');
      const strict = decodeArrayBufferText(buffer, 'utf-8', true);
      if (strict && !looksBinary(strict)) return strict;
      const candidates = ['utf-8', 'gb18030', 'gbk', 'big5', 'utf-16le'].map(encoding => ({ encoding, text: decodeArrayBufferText(buffer, encoding) })).filter(item => item.text && !looksBinary(item.text));
      candidates.sort((a, b) => decodedTextQuality(b.text) - decodedTextQuality(a.text));
      return candidates[0]?.text || decodeArrayBufferText(buffer, 'utf-8') || '';
    }

    async function dataUrlToFile(url, name = 'previous-image.png') { const response = await fetch(url); const blob = await response.blob(); return new FileCtor([blob], name, { type: blob.type || 'image/png' }); }
    async function urlToImageFile(url, name = 'previous-image.png') { const response = await fetch(url); if (!response.ok) throw new Error('无法读取上一张图片作为编辑参考'); const blob = await response.blob(); return new FileCtor([blob], name, { type: blob.type || 'image/png' }); }
    async function imageRefToFile(ref, name = 'previous-image.png') { if (!ref) return null; if (ref.startsWith('indexeddb://')) { const blob = await getImageBlob(ref.replace('indexeddb://', '')); if (!blob) throw new Error('图片缓存不存在，无法继续编辑'); return new FileCtor([blob], name, { type: blob.type || 'image/png' }); } return ref.startsWith('data:') ? dataUrlToFile(ref, name) : urlToImageFile(ref, name); }
    async function imageRefToDataUrl(ref, name = 'image.png') { if (!ref) return ''; if (ref.startsWith('data:')) return ref; if (ref.startsWith('indexeddb://')) { const blob = await getImageBlob(ref.replace('indexeddb://', '')); if (!blob) throw new Error('图片缓存不存在，无法继续发送'); return blobToDataUrl(blob); } return ref; }
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

    async function extractAttachmentText(item, taskId = null) {
      if (!item?.dataUrl) return '';
      let timer = null;
      try {
        if (taskId) timer = startTimedUploadPhase(taskId, '解析文本', 8, 96);
        const response = await fetch('/api/extract-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: item.name, type: item.type, dataUrl: item.dataUrl }) });
        if (timer) { clearInterval(timer); timer = null; }
        if (taskId) setUploadPhase(taskId, '解析文本', 97);
        const payload = await parseResponseJson(response);
        if (!response.ok) throw new Error(normalizeError(null, payload));
        if (taskId) setUploadPhase(taskId, '解析文本', 100);
        return String(payload.text || '').trim();
      } catch (err) {
        item.unsupportedReason = `本地解析失败：${err.message || String(err)}。为避免接口报错，不会直接发送二进制原文件。`;
        return '';
      } finally { if (timer) clearInterval(timer); }
    }

    async function addFiles(files) {
      const incoming = [...files];
      if (!incoming.length) return;
      const state = getState();
      state.uploadTasks = incoming.map((file, index) => ({ id: `upload_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`, name: file.name || '文件', percent: 0, status: '等待中', phase: '等待中', done: false, error: false }));
      renderUploadProgress();
      for (let index = 0; index < incoming.length; index += 1) {
        const taskId = state.uploadTasks[index]?.id;
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
          if (isImageFile(item)) item.dataUrl = await readFileAsDataURL(file, taskId, '读取图片');
          else if (isPdfFile(item) || isOfficeFile(item)) { item.dataUrl = await readFileAsDataURL(file, taskId, '读取文件'); if (canExtractAttachmentText(item)) { const text = await extractAttachmentText(item, taskId); if (text) item.text = text; } }
          else if (isProbablyTextFile(item)) { item.text = await readFileAsText(file, taskId, '读取文本'); if (looksBinary(item.text)) { item.text = ''; item.unsupportedReason = '文件看起来是二进制内容，未内联解析'; } }
          else try { const text = await readFileAsText(file, taskId, '读取文本'); if (looksBinary(text)) item.dataUrl = await readFileAsDataURL(file, taskId, '读取文件'); else item.text = text; } catch { item.dataUrl = await readFileAsDataURL(file, taskId, '读取文件'); }
          setUploadPhase(taskId, '添加到附件', 80);
          state.attachments.push(item);
          renderAttachments();
          autoResize();
          setUploadTask(taskId, { percent: 100, status: '已添加', phase: '添加到附件', done: true });
          if (item.compressionNote) toast(item.compressionNote);
        } catch (err) {
          console.warn('add file failed', err);
          setUploadTask(taskId, { percent: 100, status: err?.message || '处理失败', error: true, done: true });
        }
      }
      autoResize();
      finishUploadProgressSoon();
    }

    function clearAttachments() { const state = getState(); state.attachments = []; renderAttachments(); }

    return Object.freeze({
      renderAttachments, hasPendingUploads, renderUploadProgress, setUploadTask, finishUploadProgressSoon, setUploadPhase, setUploadPhaseProgress, startTimedUploadPhase,
      readFileAsDataURL, readFileAsArrayBuffer, readFileAsText, dataUrlToFile, urlToImageFile, imageRefToFile, imageRefToDataUrl, ensureChatAttachmentImageDataUrls,
      compressImageIfNeeded, convertBmpToPng, extractAttachmentText, addFiles, clearAttachments,
    });
  }

  const api = Object.freeze({
    DEFAULT_IMAGE_UPLOAD_LIMITS, inferMimeByName, isPdfFile, isOfficeFile, isExcelFile, canExtractOfficeText, canExtractAttachmentText, isProbablyTextFile, isBmpFile, replaceExt, looksBinary, decodeArrayBufferText, decodedTextQuality, canvasToBlob, createAttachmentsWorkflow,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppAttachmentsWorkflow = api;
  if (root?.window) root.window.ChatUIAppAttachmentsWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
