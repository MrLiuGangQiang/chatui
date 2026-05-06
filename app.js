const $ = (id) => document.getElementById(id);

const state = {
  mode: 'chat',
  messages: [],
  sessions: [],
  activeSessionId: '',
  busy: false,
  busySessions: new Set(),
  liveRuns: new Map(),
  models: [],
  modelMeta: {},
  editingIndex: null,
  editingNode: null,
  attachments: [],
  lastGeneratedImage: null,
  autoMode: true,
  reasoningPersist: false,
  pageUnloading: false,
  resumingJobs: new Set(),
  autoScrollLocked: true,
};

const CONFIG_KEY = 'openapi-chat-image-config-v2';
const CHAT_KEY = 'openapi-chat-image-chat-v1';
const UI_KEY = 'openapi-chat-image-ui-v1';
const SESSIONS_KEY = 'openapi-chat-image-sessions-v1';
const ACTIVE_SESSION_KEY = 'openapi-chat-image-active-session-v1';
const LEGACY_CHAT_KEY = CHAT_KEY;
const LEGACY_UI_KEY = UI_KEY;
const LAST_IMAGE_KEY = 'openapi-chat-image-last-image-v1';
const REASONING_PERSIST_KEY = 'openapi-chat-reasoning-persist-v1';
const SESSION_SIDEBAR_COLLAPSED_KEY = 'openapi-chat-image-session-sidebar-collapsed-v1';
const IMAGE_JOB_KEY = 'openapi-chat-image-job-v1';
const CHAT_JOB_KEY = 'openapi-chat-image-chat-job-v1';
const IMAGE_DB = 'openapi-chat-image-db-v1';
const IMAGE_STORE = 'images';
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const IMAGE_UPLOAD_LIMITS = {
  maxLongEdge: 2048,
  maxBytes: 20 * 1024 * 1024,
  minQuality: 0.72,
};
let doneAudioCtx = null;

async function unlockDoneSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!doneAudioCtx || doneAudioCtx.state === 'closed') {
      doneAudioCtx = new AudioContext();
    }
    if (doneAudioCtx.state === 'suspended') await doneAudioCtx.resume();
  } catch (err) {
    console.warn('unlock done sound failed', err);
  }
}

async function playDoneSound() {
  try {
    await unlockDoneSound();
    const ctx = doneAudioCtx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    master.connect(ctx.destination);

    [740, 988].forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + index * 0.13;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.9, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + 0.2);
      setTimeout(() => gain.disconnect(), 500);
    });
    setTimeout(() => master.disconnect(), 700);
  } catch (err) {
    console.warn('play done sound failed', err);
  }
}

function openImageDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMAGE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IMAGE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function putImageBlob(key, blob) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, 'readwrite');
    tx.objectStore(IMAGE_STORE).put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function getImageBlob(key) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, 'readonly');
    const req = tx.objectStore(IMAGE_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function clearImageDb() {
  try {
    const db = await openImageDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE, 'readwrite');
      tx.objectStore(IMAGE_STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('clear image db failed', err);
  }
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}
async function persistImageSrc(src, filename, options = {}) {
  if (!src) return options.returnDisplayUrl ? { persistedSrc: src, displaySrc: src } : src;
  let blob = null;
  if (src.startsWith('data:')) {
    blob = await dataUrlToBlob(src);
  } else if (/^https?:\/\//i.test(src)) {
    blob = await fetchImageBlob(src, options);
  } else {
    return options.returnDisplayUrl ? { persistedSrc: src, displaySrc: src } : src;
  }
  const key = `img-${Date.now()}-${Math.random().toString(16).slice(2)}-${filename || 'image.png'}`;
  await putImageBlob(key, blob);
  const persistedSrc = `indexeddb://${key}`;
  if (options.returnDisplayUrl) {
    return { persistedSrc, displaySrc: URL.createObjectURL(blob) };
  }
  return persistedSrc;
}

async function fetchImageBlob(url, { baseUrl = '', apiKey = '', directMode = true } = {}) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  try {
    const res = await fetch(url, { headers });
    if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) return await res.blob();
  } catch {
    // 直接拉取可能被 CORS、鉴权或局域网访问限制拦截，下面自动走本地代理。
  }

  if (!baseUrl) throw new Error('图片地址无法直接加载，请检查 Endpoint 配置，或使用返回 base64 图片的接口');
  const res = await fetch('/api/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl, apiKey, url }),
  });
  if (!res.ok) {
    const data = await parseResponseJson(res);
    throw new Error(normalizeError(null, data));
  }
  return res.blob();
}
async function resolvePersistedImages(scope = document) {
  const nodes = [...scope.querySelectorAll('img[data-persisted-src], img[src^="indexeddb://"], a[data-persisted-href], a[href^="indexeddb://"], button[data-persisted-href]')];
  for (const node of nodes) {
    const isImage = node.tagName === 'IMG';
    const attr = isImage ? 'src' : 'href';
    const persisted = isImage
      ? (node.dataset.persistedSrc || node.getAttribute('src') || '')
      : (node.dataset.persistedHref || node.getAttribute('href') || '');
    if (!persisted.startsWith('indexeddb://')) continue;
    const key = persisted.replace('indexeddb://', '');
    if (isImage) {
      node.dataset.persistedSrc = persisted;
      node.classList.add('image-restoring');
      node.alt = node.alt || '图片加载中';
      if ((node.getAttribute('src') || '').startsWith('indexeddb://')) node.setAttribute('src', TRANSPARENT_PIXEL);
    }
    try {
      const blob = await getImageBlob(key);
      if (!blob) {
        if (isImage) {
          node.classList.remove('image-restoring');
          node.classList.add('image-missing');
          node.alt = '图片缓存不存在，请重新生成';
        }
        continue;
      }
      const oldObjectUrl = node.dataset.objectUrl;
      if (oldObjectUrl?.startsWith('blob:')) URL.revokeObjectURL(oldObjectUrl);
      const objectUrl = URL.createObjectURL(blob);
      node.dataset.persistedUrl = persisted;
      node.dataset.objectUrl = objectUrl;
      if (isImage) {
        node.onload = () => node.classList.remove('image-restoring');
        node.onerror = () => {
          node.classList.remove('image-restoring');
          node.classList.add('image-missing');
        };
        node.setAttribute('src', objectUrl);
        if (node.complete && node.naturalWidth > 0) node.classList.remove('image-restoring');
      } else if (node.tagName === 'A') {
        node.dataset.persistedHref = persisted;
        node.setAttribute('href', objectUrl);
      } else {
        node.dataset.persistedHref = persisted;
      }
    } catch (err) {
      if (isImage) node.classList.remove('image-restoring');
      console.warn('restore image failed', err);
    }
  }
}

const defaults = {
  baseUrl: '',
  apiKey: '',
  chatModel: '',
  imageModel: '',
  imageSize: 'auto',
  directMode: false,
  models: [],
  editingIndex: null,
  editingNode: null,
  attachments: [],
};

function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function normalizeModelMeta(models, savedMeta = {}) {
  const meta = {};
  (Array.isArray(models) ? models : []).forEach(id => {
    const prev = savedMeta?.[id] || {};
    meta[id] = {
      id,
      type: String(prev.type || '').trim(),
      unrecognized: prev.unrecognized === true || !String(prev.type || '').trim(),
    };
  });
  return meta;
}


function setApiKeyVisible(visible) {
  const input = $('apiKey');
  const btn = $('toggleApiKeyVisibility');
  if (!input || !btn) return;
  input.type = visible ? 'text' : 'password';
  btn.textContent = visible ? '隐藏' : '显示';
  btn.setAttribute('aria-label', visible ? '隐藏 API Key' : '显示 API Key');
  btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
}

function toggleApiKeyVisibility() {
  const input = $('apiKey');
  if (!input) return;
  setApiKeyVisible(input.type === 'password');
  input.focus();
}

function loadConfig() {
  const saved = readJsonStorage(CONFIG_KEY, readJsonStorage('openapi-chat-image-config', {}));
  const cfg = { ...defaults, ...saved };
  $('baseUrl').value = cfg.baseUrl || '';
  $('apiKey').value = cfg.apiKey || '';
  $('imageSize').value = cfg.imageSize || defaults.imageSize;
  state.models = Array.isArray(cfg.models) ? cfg.models : [];
  state.modelMeta = normalizeModelMeta(state.models, cfg.modelMeta || {});
  const knownModels = new Set(state.models);
  const chatModel = knownModels.has(cfg.chatModel) ? cfg.chatModel : '';
  const imageModel = knownModels.has(cfg.imageModel) ? cfg.imageModel : '';
  renderModelOptions(chatModel, imageModel);
  if (cfg.chatModel !== chatModel || cfg.imageModel !== imageModel) saveConfig(true);
}

function getConfig() {
  return {
    baseUrl: $('baseUrl').value.trim().replace(/\/$/, ''),
    apiKey: $('apiKey').value.trim(),
    chatModel: $('chatModel').value.trim(),
    imageModel: $('imageModel').value.trim(),
    imageSize: $('imageSize').value,
    directMode: false,
    models: state.models,
  };
}

function cleanupLegacyConfigCache() {
  // 清理旧版本配置，避免之前默认模型、手动输入字段残留影响当前下拉选择。
  localStorage.removeItem('openapi-chat-image-config');
  localStorage.removeItem('openapi-chat-image-config-v1');
}

function saveConfig(silent = false) {
  cleanupLegacyConfigCache();
  const cfg = getConfig();
  // 只保存当前 UI 里真实存在的配置项，不保存旧的 custom model 字段。
  localStorage.setItem(CONFIG_KEY, JSON.stringify({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    chatModel: cfg.chatModel,
    imageModel: cfg.imageModel,
    imageSize: cfg.imageSize,
    directMode: false,
    models: Array.isArray(state.models) ? state.models : [],
    modelMeta: state.modelMeta || {}, 
  }));
  if (!silent) {
    closeConfigModal();
  }
}

function toast(text) {
  let el = document.querySelector('.toast-popup');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast-popup';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 1800);
}


function clearEmpty() {
  const empty = document.querySelector('.empty');
  if (empty) empty.remove();
}

let scrollTimer = null;
function isNearMessagesBottom(threshold = 180) {
  const el = $('messages');
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function updateAutoScrollLock() {
  state.autoScrollLocked = isNearMessagesBottom(220);
}

function markManualMessageScroll() {
  state.autoScrollLocked = isNearMessagesBottom(80);
}

function scrollToBottom(force = true) {
  const el = $('messages');
  if (!el) return;
  if (!force && !state.autoScrollLocked && !isNearMessagesBottom(220)) return;

  const isMobile = window.matchMedia('(max-width: 640px)').matches;
  const apply = () => {
    // .messages 是唯一主滚动容器；移动端不要滚 window，避免抢手势和键盘抖动。
    el.scrollTop = el.scrollHeight;
    if (!isMobile) {
      const doc = document.scrollingElement || document.documentElement;
      doc.scrollTop = doc.scrollHeight;
      document.documentElement.scrollTop = document.documentElement.scrollHeight;
      document.body.scrollTop = document.body.scrollHeight;
    }
  };

  state.autoScrollLocked = true;
  apply();
  requestAnimationFrame(apply);

  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(apply, isMobile ? 80 : 160);
}

function addMessage(role, content, options = {}) {
  clearEmpty();
  const tpl = $('messageTemplate');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector('.avatar').textContent = role === 'user' ? '我' : role === 'error' ? '!' : 'AI';
  const box = node.querySelector('.content');
  const rawText = options.rawText ?? content;
  node.dataset.rawText = rawText;
  if (options.skipSave) node.dataset.persist = '0';
  if (options.messageIndex !== undefined && options.messageIndex !== null) node.dataset.messageIndex = String(options.messageIndex);

  if (options.html) box.innerHTML = content;
  else box.innerHTML = renderMarkdown(String(content || ''));

  const editBtn = node.querySelector('.edit-btn');
  if (role === 'user') {
    editBtn.addEventListener('click', () => editUserMessage(node));
  } else {
    editBtn.remove();
  }

  const refreshBtn = node.querySelector('.refresh-btn');
  if (role === 'assistant') {
    refreshBtn.addEventListener('click', () => regenerateAssistantMessage(node));
  } else {
    refreshBtn.remove();
  }

  node.querySelector('.copy-btn')?.addEventListener('click', async () => {
    await copyText(node.dataset.rawText || box.innerText);
    showCopySuccess(node.querySelector('.copy-btn'));
  });

  bindInlineCopyButtons(node);
  hydrateMessageMedia(node, { save: !options.skipSave });

  $('messages').appendChild(node);
  scrollToBottom(true);
  if (!options.skipSave && !options.deferSave) saveDisplayHistory();
  return node;
}

function showCopySuccess(btn) {
  if (!btn) return;
  const oldHtml = btn.innerHTML;
  btn.classList.add('copied');
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.5 17 19 7"></path></svg>';
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.innerHTML = oldHtml;
    btn.classList.remove('copied');
  }, 900);
}

function bindInlineCopyButtons(node) {
  node.querySelectorAll('[data-copy-text]').forEach(btn => {
    if (btn.dataset.copyBound === '1') return;
    btn.dataset.copyBound = '1';
    btn.addEventListener('click', async () => {
      await copyText(btn.dataset.copyText || '');
      showCopySuccess(btn);
    });
  });
}


function updateMessageContentLight(node, content, options = {}) {
  const box = node?.querySelector('.content');
  if (!box) return;
  const text = String(options.rawText ?? content ?? '');
  node.dataset.rawText = text;
  if (options.skipSave) node.dataset.persist = '0';
  const html = options.html ? String(content || '') : renderMarkdown(text);
  if (box.innerHTML !== html) {
    box.innerHTML = html;
    bindInlineCopyButtons(node);
  }
  // 流式阶段只做 Markdown 渲染，不做图片 IndexedDB 恢复、媒体按钮搬运、历史保存等重操作。
  // 如果用户没有主动上滑，移动端也要持续跟随到底部。
  scrollToBottom(options.forceScroll ?? false);
}

function updateMessage(node, content, options = {}) {
  const box = node.querySelector('.content');
  node.dataset.rawText = options.rawText ?? content;
  if (options.skipSave) node.dataset.persist = '0';
  else delete node.dataset.persist;
  if (options.html) box.innerHTML = content;
  else box.innerHTML = renderMarkdown(String(content || ''));
  bindInlineCopyButtons(node);
  hydrateMessageMedia(node, { save: options.skipSave !== true });
  scrollToBottom(true);
}

function hydrateMessageMedia(node, { save = false } = {}) {
  const finalize = () => {
    bindImagePreview(node);
    moveImageActionsToMessageActions(node);
    if (save && node.isConnected) saveDisplayHistory();
  };

  const hasPersisted = node.querySelector('img[data-persisted-src], img[src^="indexeddb://"], a[data-persisted-href], a[href^="indexeddb://"], button[data-persisted-href]');
  if (!hasPersisted) {
    finalize();
    return;
  }

  resolvePersistedImages(node).then(finalize).catch(err => {
    console.warn('restore image failed', err);
    finalize();
  });
}


function updateReasoning(node, text, options = {}) {
  if (!node) return;
  const contentText = String(text || '');
  let panel = node.querySelector('.reasoning-panel');
  if (!contentText && !options.keepEmpty) {
    panel?.remove();
    delete node.dataset.reasoningText;
    if (node.isConnected) saveDisplayHistory();
    return;
  }
  if (contentText) node.dataset.reasoningText = contentText;
  if (options.keepReasoning) node.dataset.keepReasoning = '1';
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'reasoning-panel';
    panel.innerHTML = `<div class="reasoning-title">思考中…</div><div class="reasoning-content"></div>`;
    node.querySelector('.bubble')?.prepend(panel);
  }
  panel.classList.toggle('reasoning-done', options.done === true);
  panel.querySelector('.reasoning-title').textContent = options.done ? '思考完成' : '思考中…';
  const content = panel.querySelector('.reasoning-content');
  content.textContent = contentText;
  content.hidden = !contentText;
  scrollToBottom(options.forceScroll ?? false);
  if (options.persistSave && node.isConnected) saveDisplayHistory();
}

function finishReasoning(node, text) {
  const contentText = String(text || node?.dataset.reasoningText || '').trim();
  if (contentText) updateReasoning(node, contentText, { done: true, persistSave: state.reasoningPersist, keepReasoning: state.reasoningPersist });
  else updateReasoning(node, '', { keepEmpty: true, done: true });
  if (!state.reasoningPersist) setTimeout(() => clearReasoning(node), 2000);
}

function pendingFeedbackHtml(text) {
  return `<div class="pending-feedback"><span class="pending-orb" aria-hidden="true"></span><span class="pending-text">${escapeHtml(text)}</span><span class="pending-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
}

function setPendingFeedback(node, text) {
  if (!node) return;
  node.dataset.pendingFeedback = '1';
  updateMessage(node, pendingFeedbackHtml(text), { html: true, rawText: text, skipSave: true });
}

function clearPendingFeedback(node) {
  if (!node || node.dataset.pendingFeedback !== '1') return;
  delete node.dataset.pendingFeedback;
}

function clearReasoning(node) {
  updateReasoning(node, '');
}

function moveImageActionsToMessageActions(node) {
  const hasGeneratedImage = node.classList.contains('assistant') && !!node.querySelector('img.generated-thumb');
  if (!hasGeneratedImage) return;
  ensureImageDownloadRow(node);
  const row = node.querySelector('.image-download-row');
  const actions = node.querySelector('.msg-actions');
  if (!row || !actions) return;

  // AI 生成图片结果只保留图片相关操作和刷新按钮，不显示“复制消息”按钮。
  actions.querySelector('.copy-btn')?.remove();

  // msg-actions 不会进入历史缓存；每次渲染/恢复都从内容区的原始按钮克隆一份。
  actions.querySelectorAll('[data-image-action-clone]').forEach(el => el.remove());
  const refreshBtn = actions.querySelector('.refresh-btn');
  row.querySelectorAll('a,button').forEach(action => {
    const cloned = action.cloneNode(true);
    cloned.dataset.imageActionClone = '1';
    cloned.classList.add('icon-action-btn');
    if (cloned.dataset.downloadImage) bindImageDownload(cloned);
    if (cloned.dataset.shareImage) bindImageShare(cloned);
    if (refreshBtn) actions.insertBefore(cloned, refreshBtn);
    else actions.appendChild(cloned);
  });
}

function downloadImageButtonHtml(persistedSrc, filename) {
  const persisted = escapeAttr(persistedSrc);
  const safeFilename = escapeAttr(filename);
  return `<button class="image-icon-btn" type="button" data-download-image="1" data-persisted-href="${persisted}" data-filename="${safeFilename}" title="下载图片" aria-label="下载图片"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg></button>`;
}

function shareImageButtonHtml(persistedSrc, filename) {
  const persisted = escapeAttr(persistedSrc);
  const safeFilename = escapeAttr(filename);
  return `<button class="image-icon-btn" type="button" data-share-image="1" data-persisted-href="${persisted}" data-filename="${safeFilename}" title="分享图片" aria-label="分享图片"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6 15.4 6.4"/><path d="M8.6 13.4 15.4 17.6"/></svg></button>`;
}

function imageActionButtonsHtml(persistedSrc, filename) {
  return downloadImageButtonHtml(persistedSrc, filename) + shareImageButtonHtml(persistedSrc, filename);
}

function ensureImageDownloadRow(node) {
  const img = node.querySelector('img.generated-thumb[data-persisted-src]');
  if (!img?.dataset.persistedSrc) return;
  const filename = img.dataset.filename || `generated-${Date.now()}.png`;
  let row = node.querySelector('.image-download-row');
  if (!row) {
    row = document.createElement('div');
    row.className = 'image-download-row';
    img.insertAdjacentElement('afterend', row);
  }
  if (!row.querySelector('[data-download-image]')) {
    row.insertAdjacentHTML('afterbegin', downloadImageButtonHtml(img.dataset.persistedSrc, filename));
  }
  if (!row.querySelector('[data-share-image]')) {
    const downloadBtn = row.querySelector('[data-download-image]');
    downloadBtn?.insertAdjacentHTML('afterend', shareImageButtonHtml(img.dataset.persistedSrc, filename));
  }
}

async function getImageActionBlob(btn) {
  const persisted = btn.dataset.persistedHref || '';
  const key = persisted.replace('indexeddb://', '');
  const blob = await getImageBlob(key);
  if (!blob) throw new Error('图片缓存不存在，请重新生成');
  return blob;
}

function bindImageDownload(btn) {
  if (btn.dataset.downloadBound) return;
  btn.dataset.downloadBound = '1';
  btn.addEventListener('click', async () => {
    const filename = btn.dataset.filename || 'generated-image.png';
    try {
      const blob = await getImageActionBlob(btn);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.rel = 'noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    } catch (err) {
      toast(err.message || String(err));
    }
  });
}

function bindImageShare(btn) {
  if (btn.dataset.shareBound) return;
  btn.dataset.shareBound = '1';
  btn.addEventListener('click', async () => {
    const filename = btn.dataset.filename || 'generated-image.png';
    try {
      const blob = await getImageActionBlob(btn);
      const file = new File([blob], filename, { type: blob.type || 'image/png' });
      if (!navigator.share || !navigator.canShare?.({ files: [file] })) throw new Error('当前浏览器不支持文件分享');
      await navigator.share({ files: [file], title: filename });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      toast(err.message || String(err));
    }
  });
}

function bindImagePreview(scope) {
  scope.querySelectorAll('.content img').forEach(img => {
    // 历史 HTML 里可能保存过 data-preview-bound，但事件监听刷新后不会保留；
    // 所以这里每次渲染/恢复后都覆盖 onclick，保证图片始终可预览。
    img.dataset.previewBound = '1';
    img.onclick = () => openImagePreview(img.currentSrc || img.src);
  });
}

function openImagePreview(src) {
  $('imagePreviewImg').src = src;
  $('imagePreview').classList.add('show');
  $('imagePreview').setAttribute('aria-hidden', 'false');
}

function closeImagePreview() {
  $('imagePreview').classList.remove('show');
  $('imagePreview').setAttribute('aria-hidden', 'true');
  $('imagePreviewImg').src = '';
}


function editUserMessage(node) {
  let idx = Number(node.dataset.messageIndex);
  const text = node.dataset.rawText || '';
  if (!Number.isFinite(idx)) {
    const userNodes = [...$('messages').querySelectorAll('.message.user')];
    const userOrdinal = userNodes.indexOf(node);
    let seen = -1;
    idx = state.messages.findIndex(msg => {
      if (msg?.role !== 'user') return false;
      seen += 1;
      return seen === userOrdinal;
    });
    if (idx < 0 && text) idx = state.messages.findIndex(msg => msg?.role === 'user' && String(msg.content || '') === text);
    if (idx >= 0) node.dataset.messageIndex = String(idx);
  }
  if (!Number.isFinite(idx) || idx < 0) {
    toast('找不到这条消息的上下文，无法编辑重发');
    return;
  }

  if (state.editingNode) state.editingNode.classList.remove('editing');
  state.editingIndex = idx;
  state.editingNode = node;
  node.classList.add('editing');

  $('prompt').value = text;
  $('prompt').dataset.editing = '1';
  autoResize();
  $('prompt').focus();
}

function applyPendingEdit(newText) {
  if (state.editingIndex === null || !state.editingNode) return null;
  const idx = state.editingIndex;
  const node = state.editingNode;
  const session = getActiveSession();

  // 发送时再清理：原位替换当前用户消息，删除它后面的旧回复/旧分支，并回退上下文。
  state.messages = state.messages.slice(0, idx);
  if (state.messages[idx]?.role === 'user') state.messages[idx].content = newText;
  else state.messages.push({ role: 'user', content: newText });
  node.dataset.rawText = newText;
  const box = node.querySelector('.content');
  box.innerHTML = renderMarkdown(newText);

  let current = node.nextElementSibling;
  while (current) {
    const next = current.nextElementSibling;
    current.remove();
    current = next;
  }

  if (session?.display) {
    const keepCount = [...$('messages').querySelectorAll('.message')].indexOf(node) + 1;
    session.display = session.display.slice(0, Math.max(keepCount, 0));
    const userItem = session.display[keepCount - 1];
    if (userItem) {
      userItem.rawText = newText;
      userItem.html = renderMarkdown(newText);
    }
    persistSessionDisplay(session.id);
  }

  node.classList.remove('editing');
  state.editingIndex = null;
  state.editingNode = null;
  delete $('prompt').dataset.editing;
  return { index: idx, node };
}

function findPreviousUserMessageNode(node) {
  let current = node?.previousElementSibling;
  while (current) {
    if (current.classList.contains('user')) return current;
    current = current.previousElementSibling;
  }
  return null;
}

async function regenerateAssistantMessage(node) {
  if (isSessionBusy(state.activeSessionId)) return;
  const userNode = findPreviousUserMessageNode(node);
  const prompt = (userNode?.dataset.rawText || '').trim();
  if (!prompt) {
    toast('找不到上一条提示词，无法重新生成');
    return;
  }

  let userIndex = Number(userNode.dataset.messageIndex);
  if (!Number.isFinite(userIndex)) userIndex = Math.max(0, state.messages.length - 2);
  const hadGeneratedImage = !!node.querySelector('img.generated-thumb');
  let imageContext = null;
  if (node.dataset.imageContext) {
    try { imageContext = JSON.parse(node.dataset.imageContext); } catch {}
  }
  const hadImageContext = !!(imageContext && Array.isArray(imageContext.attachments) && imageContext.attachments.length);

  // 删除当前回复及其后的旧分支，并把上下文回退到对应用户消息之前，随后复用同一条提示重新请求。
  let current = node;
  while (current) {
    const next = current.nextElementSibling;
    current.remove();
    current = next;
  }
  state.messages = state.messages.slice(0, userIndex);
  saveChatHistory();
  saveDisplayHistory();

  const runSessionId = state.activeSessionId;
  setSessionBusy(runSessionId, true);
  const immediateFeedback = addMessage('assistant', pendingFeedbackHtml('已收到，马上处理'), { html: true, rawText: '已收到，马上处理', skipSave: true });
  const liveItem = appendSessionDisplayMessage(runSessionId, 'assistant', pendingFeedbackHtml('已收到，马上处理'), { html: true, rawText: '已收到，马上处理', pending: true });
  immediateFeedback.__displayItem = liveItem;
  try {
    const restoredAttachments = hadImageContext ? await restoreImageAttachmentsFromContext(imageContext) : [];
    const route = (hadGeneratedImage || hadImageContext)
      ? normalizeRoute({
          mode: restoredAttachments.length ? 'edit_image' : 'image',
          target: restoredAttachments.length ? (imageContext?.target || 'uploaded') : 'new',
          use_previous_image: !!imageContext?.usePreviousImage,
          confidence: 1,
          evidence: restoredAttachments.length ? '刷新复用原图片上下文' : '',
        }, 'image')
      : await getEffectiveRoute(prompt, []);
    const mode = route.mode;
    updateModeUi(mode, state.autoMode);
    if (warnMissingModel(mode, true)) {
      immediateFeedback.remove();
      return;
    }
    if (mode === 'chat') await sendChat(prompt, [], immediateFeedback, { sessionId: runSessionId, liveItem });
    else await sendImage(prompt, {
      loadingNode: immediateFeedback,
      editMode: mode === 'edit_image',
      editTarget: route.target,
      usePreviousImage: false,
      attachments: restoredAttachments,
      imageContext,
      sessionId: runSessionId,
      liveItem,
    });
  } catch (err) {
    showRunError(runSessionId, err, liveItem, immediateFeedback);
  } finally {
    setSessionBusy(runSessionId, false);
    $('prompt').focus();
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function normalizeError(err, data) {
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  if (data?.raw) return data.raw;
  return err?.message || '请求失败';
}

function toProxyUrl(url, baseUrl) {
  return url.startsWith(baseUrl) ? `/api${url.slice(baseUrl.length)}` : url;
}

async function parseResponseJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; }
  catch { return { raw: text }; }
}

async function requestJson(url, payload, apiKey, method = 'POST') {
  const cfg = getConfig();
  const direct = cfg.directMode;
  const finalUrl = direct ? url : toProxyUrl(url, cfg.baseUrl);
  const finalPayload = direct ? payload : { baseUrl: cfg.baseUrl, apiKey, payload, method };
  let res;
  try {
    res = await fetch(finalUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(direct && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(finalPayload) }),
    });
  } catch (err) {
    throw new Error(`连接接口失败：${err?.message || '网络请求失败'}`);
  }
  const data = await parseResponseJson(res);
  if (!res.ok) throw new Error(normalizeError(null, data));
  return data;
}

async function requestModels() {
  const cfg = getConfig();
  if (!cfg.baseUrl) throw new Error('请先配置 Endpoint Base URL');

  let res;
  try {
    res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, payload: {}, method: 'GET' }),
    });
  } catch (err) {
    throw new Error(`连接接口失败：${err?.message || '网络请求失败'}`);
  }
  const data = await parseResponseJson(res);
  if (!res.ok) throw new Error(normalizeError(null, data));
  return data;
}

function normalizeModelType(type = '') {
  const raw = String(type || '').trim().toLowerCase();
  if (!raw) return '';
  if (/image|image_generation|image-generation|imagegeneration|vision|picture|img|dall|gpt-image|flux|sd|stable|midjourney|wan|kling/.test(raw)) return 'image';
  if (/chat|text|llm|language|completion|reason|assistant|gpt|claude|gemini|qwen|deepseek|llama|mistral/.test(raw)) return 'chat';
  return raw;
}

function extractModelType(item) {
  if (!item || typeof item === 'string') return '';
  const candidates = [
    item.type,
    item.model_type,
    item.modelType,
    item.mode,
    item.category,
    item.task,
    item.capability,
    Array.isArray(item.capabilities) ? item.capabilities.join(',') : '',
  ];
  return normalizeModelType(candidates.find(v => String(v || '').trim()) || '');
}

function extractModels(data) {
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const meta = {};
  const models = [];
  arr.forEach(item => {
    const id = typeof item === 'string' ? item : item?.id || item?.name;
    if (!id) return;
    const modelId = String(id);
    const type = extractModelType(item);
    meta[modelId] = { id: modelId, type, unrecognized: !type };
    models.push(modelId);
  });
  const unique = [...new Set(models)].sort();
  return { models: unique, meta };
}

function isModelAllowedFor(id, target) {
  const type = state.modelMeta?.[id]?.type || '';
  if (!type) return true;
  if (target === 'image') return type === 'image';
  if (target === 'chat') return type !== 'image';
  return true;
}

function modelOptionHtml(id) {
  const unrecognized = state.modelMeta?.[id]?.unrecognized;
  const label = unrecognized ? `${id}（未知类型）` : id;
  return `<option value="${escapeHtml(id)}" data-unrecognized="${unrecognized ? '1' : '0'}">${escapeHtml(label)}</option>`;
}

function setSelectValue(select, value) {
  const hasValue = [...select.options].some(opt => opt.value === value);
  select.value = hasValue ? value : '';
  updateCustomSelect(select);
}

function renderModelOptions(chatValue = $('chatModel')?.value || '', imageValue = $('imageModel')?.value || '') {
  const models = [...new Set(state.models)].filter(Boolean);
  const chatModels = models.filter(id => isModelAllowedFor(id, 'chat'));
  const imageModels = models.filter(id => isModelAllowedFor(id, 'image'));
  const empty = `<option value="">请选择模型</option>`;
  $('chatModel').innerHTML = empty + chatModels.map(modelOptionHtml).join('');
  $('imageModel').innerHTML = empty + imageModels.map(modelOptionHtml).join('');
  setSelectValue($('chatModel'), chatValue);
  setSelectValue($('imageModel'), imageValue);
  refreshCustomSelectOptions($('chatModel'));
  refreshCustomSelectOptions($('imageModel'));
}

function warnMissingModel(mode = state.mode, openSettings = false) {
  const cfg = getConfig();
  const missingChat = mode === 'chat' && !cfg.chatModel;
  const missingImage = (mode === 'image' || mode === 'edit_image') && !cfg.imageModel;
  if (missingChat || missingImage) {
    toast(missingChat ? '请先在设置里选择聊天模型' : '请先在设置里选择生图模型');
    if (openSettings) openConfigModal();
    return true;
  }
  return false;
}


async function loadModels() {
  const btn = $('loadModelsBtn');
  const status = $('modelLoadStatus');
  btn.disabled = true;
  status.textContent = '加载中…';
  try {
    const data = await requestModels();
    const { models, meta } = extractModels(data);
    if (!models.length) throw new Error('未从 /models 返回中识别到模型列表');
    state.models = models;
    state.modelMeta = meta;
    renderModelOptions($('chatModel').value, $('imageModel').value);
    saveConfig(true);
    const unknownCount = models.filter(id => state.modelMeta?.[id]?.unrecognized).length;
    if (unknownCount) {
      status.textContent = `已加载 ${models.length} 个，${unknownCount} 个未知类型`;
    } else {
      status.textContent = `已加载 ${models.length} 个`;
    }
  } catch (err) {
    status.textContent = err.message || String(err);
  } finally {
    btn.disabled = false;
  }
}

function renderAttachments() {
  const bar = $('attachmentBar');
  if (!bar) return;
  bar.innerHTML = state.attachments.map((file, index) => {
    const isImage = file.type.startsWith('image/');
    const thumb = isImage ? `<img src="${escapeHtml(file.dataUrl)}" alt="" />` : `<span class="file-icon">${escapeHtml(file.name.split('.').pop() || 'FILE')}</span>`;
    const status = file.compressionNote
      ? `<em title="${escapeHtml(file.compressionNote)}">已压缩</em>`
      : (file.text || file.dataUrl ? '' : `<em title="${escapeHtml(file.unsupportedReason || '暂不支持解析')}">未解析</em>`);
    return `<div class="attachment-chip" title="${escapeHtml(file.compressionNote || file.unsupportedReason || file.name)}">${thumb}<span>${escapeHtml(file.name)}</span>${status}<button type="button" data-remove-attachment="${index}">×</button></div>`;
  }).join('');
  bar.classList.toggle('show', state.attachments.length > 0);
  bar.querySelectorAll('[data-remove-attachment]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.attachments.splice(Number(btn.dataset.removeAttachment), 1);
      renderAttachments();
      autoResize();
    });
  });
}

function isBmpFile(item) {
  return /image\/(bmp|x-ms-bmp)/i.test(item.type || '') || /\.bmp$/i.test(item.name || '');
}

function replaceExt(name, ext) {
  const source = String(name || 'image');
  return source.includes('.') ? source.replace(/\.[^.]*$/, ext) : `${source}${ext}`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function isCompressibleRasterImage(file) {
  const type = file.type || inferMimeByName(file.name);
  return /image\/(png|jpe?g|webp)/i.test(type) || /\.(png|jpe?g|webp)$/i.test(file.name || '');
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result) : reject(new Error('图片压缩失败')), type, quality);
  });
}

async function compressImageIfNeeded(file, limits = IMAGE_UPLOAD_LIMITS) {
  if (!isCompressibleRasterImage(file)) return { file, changed: false };
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const overResolution = longEdge > limits.maxLongEdge;
    const overBytes = file.size > limits.maxBytes;
    if (!overResolution && !overBytes) return { file, changed: false };

    const scale = Math.min(1, limits.maxLongEdge / longEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d', { alpha: true }).drawImage(bitmap, 0, 0, width, height);

    const originalType = file.type || inferMimeByName(file.name);
    const outputType = /image\/png/i.test(originalType) ? 'image/png' : /image\/webp/i.test(originalType) ? 'image/webp' : 'image/jpeg';
    let blob = await canvasToBlob(canvas, outputType, 0.9);
    if (blob.size > limits.maxBytes && outputType !== 'image/png') {
      for (const quality of [0.82, 0.76, limits.minQuality]) {
        blob = await canvasToBlob(canvas, outputType, quality);
        if (blob.size <= limits.maxBytes) break;
      }
    }
    if (blob.size > limits.maxBytes && outputType === 'image/png') {
      for (const quality of [0.88, 0.8, limits.minQuality]) {
        blob = await canvasToBlob(canvas, 'image/jpeg', quality);
        if (blob.size <= limits.maxBytes) break;
      }
    }

    const finalType = blob.type || outputType;
    const ext = finalType.includes('webp') ? '.webp' : finalType.includes('jpeg') ? '.jpg' : '.png';
    const nextFile = new File([blob], replaceExt(file.name, ext), { type: finalType, lastModified: Date.now() });
    const reasons = [];
    if (overResolution) reasons.push(`分辨率 ${bitmap.width}×${bitmap.height}`);
    if (overBytes) reasons.push(`大小 ${formatBytes(file.size)}`);
    return {
      file: nextFile,
      changed: true,
      note: `${reasons.join('、')} 较大，已自动压缩为 ${width}×${height} / ${formatBytes(nextFile.size)}`,
    };
  } catch (err) {
    console.warn('compress image failed', err);
    return { file, changed: false };
  } finally {
    bitmap?.close?.();
  }
}

async function convertBmpToPng(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('BMP 转 PNG 失败')), 'image/png');
    });
    const name = replaceExt(file.name, '.png');
    return new File([blob], name, { type: 'image/png' });
  } finally {
    bitmap.close?.();
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function dataUrlToFile(dataUrl, filename = 'previous-image.png') {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || 'image/png' });
}

async function urlToImageFile(url, filename = 'previous-image.png') {
  const res = await fetch(url);
  if (!res.ok) throw new Error('无法读取上一张图片作为编辑参考');
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || 'image/png' });
}

async function imageRefToFile(src, filename = 'previous-image.png') {
  if (!src) return null;
  if (src.startsWith('indexeddb://')) {
    const blob = await getImageBlob(src.replace('indexeddb://', ''));
    if (!blob) throw new Error('图片缓存不存在，无法继续编辑');
    return new File([blob], filename, { type: blob.type || 'image/png' });
  }
  return src.startsWith('data:')
    ? await dataUrlToFile(src, filename)
    : await urlToImageFile(src, filename);
}

async function getPreviousImageAsAttachment(sessionId = state.activeSessionId) {
  const img = sessionId === state.activeSessionId
    ? state.lastGeneratedImage
    : state.sessions.find(item => item.id === sessionId)?.lastGeneratedImage;
  if (!img?.src) return null;
  const file = await imageRefToFile(img.src, img.filename || 'previous-image.png');
  return {
    file,
    name: file.name,
    type: file.type || 'image/png',
    size: file.size,
    dataUrl: img.src,
    text: '',
    fromPrevious: true,
  };
}

function serializeImageAttachment(item) {
  if (!item || !isImageFile(item)) return null;
  const src = item.dataUrl || item.src || '';
  if (!src) return null;
  return {
    name: item.name || item.file?.name || 'image.png',
    type: item.type || item.file?.type || 'image/png',
    src,
    fromPrevious: !!item.fromPrevious,
  };
}

function setImageContext(node, context) {
  if (!node || !context) return;
  node.dataset.imageContext = JSON.stringify({
    prompt: context.prompt || '',
    mode: context.mode || 'image',
    target: context.target || 'new',
    usePreviousImage: !!context.usePreviousImage,
    attachments: (context.attachments || []).map(serializeImageAttachment).filter(Boolean),
  });
}

async function restoreImageAttachmentsFromContext(context) {
  const refs = Array.isArray(context?.attachments) ? context.attachments : [];
  const restored = [];
  for (const ref of refs) {
    if (!ref?.src) continue;
    const file = await imageRefToFile(ref.src, ref.name || 'image.png');
    restored.push({
      file,
      name: ref.name || file.name,
      type: ref.type || file.type || 'image/png',
      size: file.size,
      dataUrl: ref.src,
      text: '',
      fromPrevious: !!ref.fromPrevious,
    });
  }
  return restored;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result || '');
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

async function addFiles(files) {
  for (const file of files) {
    let uploadFile = file;
    let convertedFrom = '';
    const initialType = file.type || inferMimeByName(file.name);
    if (isBmpFile({ name: file.name, type: initialType })) {
      try {
        uploadFile = await convertBmpToPng(file);
        convertedFrom = file.name;
      } catch {
        uploadFile = file;
      }
    }
    let compressionNote = '';
    const maybeImageType = uploadFile.type || inferMimeByName(uploadFile.name);
    if (isImageFile({ name: uploadFile.name, type: maybeImageType })) {
      const compressed = await compressImageIfNeeded(uploadFile);
      uploadFile = compressed.file;
      compressionNote = compressed.changed ? compressed.note : '';
    }
    const item = {
      file: uploadFile,
      name: uploadFile.name,
      originalName: convertedFrom || (compressionNote ? file.name : ''),
      type: uploadFile.type || inferMimeByName(uploadFile.name),
      size: uploadFile.size,
      dataUrl: '',
      text: '',
      unsupportedReason: '',
      compressionNote,
    };

    if (isImageFile(item)) {
      item.dataUrl = await readFileAsDataURL(uploadFile);
    } else if (isProbablyTextFile(item)) {
      item.text = await readFileAsText(file);
      if (looksBinary(item.text)) {
        item.text = '';
        item.unsupportedReason = '文件看起来是二进制内容，未内联解析';
      }
    } else if (isPdfFile(item)) {
      item.unsupportedReason = 'PDF 已添加，但纯前端暂不解析正文；需要后端或 PDF 解析库支持';
    } else if (isOfficeFile(item)) {
      item.unsupportedReason = 'Office 文件已添加，但纯前端暂不解析正文；需要后端解析支持';
    } else {
      // 最后一层兜底：很多代码文件在浏览器里 type 为空，尝试按文本读取一小类安全文件。
      try {
        const text = await readFileAsText(file);
        if (!looksBinary(text)) item.text = text;
        else item.unsupportedReason = '文件格式暂不支持直接识别';
      } catch {
        item.unsupportedReason = '文件格式暂不支持直接识别';
      }
    }
    state.attachments.push(item);
    if (item.compressionNote) toast(item.compressionNote);
  }
  renderAttachments();
  autoResize();
}

function inferMimeByName(name) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map = {
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json',
    csv: 'text/csv', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
    js: 'text/javascript', ts: 'text/typescript', jsx: 'text/javascript', tsx: 'text/typescript',
    html: 'text/html', css: 'text/css', py: 'text/x-python', java: 'text/x-java', go: 'text/x-go',
    rs: 'text/x-rust', php: 'text/x-php', sql: 'text/x-sql', log: 'text/plain', conf: 'text/plain',
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp',
  };
  return map[ext] || 'application/octet-stream';
}

function isImageFile(item) {
  return item.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(item.name);
}

function isPdfFile(item) {
  return item.type === 'application/pdf' || /\.pdf$/i.test(item.name);
}

function isOfficeFile(item) {
  return /\.(docx?|xlsx?|pptx?)$/i.test(item.name) || /(wordprocessingml|spreadsheetml|presentationml|msword|ms-excel|ms-powerpoint)/.test(item.type);
}

function isProbablyTextFile(item) {
  return /text|json|xml|csv|markdown|javascript|typescript|yaml|html|css|sql/.test(item.type)
    || /\.(txt|md|markdown|json|csv|xml|yaml|yml|js|ts|jsx|tsx|html|css|py|java|go|rs|php|sql|log|conf|ini|env|sh|bash|zsh|toml|lock)$/i.test(item.name);
}

function looksBinary(text) {
  if (!text) return false;
  const sample = text.slice(0, 2000);
  if (sample.includes('\u0000')) return true;
  const bad = (sample.match(/[\u0000-\u0008\u000E-\u001F\uFFFD]/g) || []).length;
  return bad / sample.length > 0.05;
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

function buildChatMessagesWithAttachments(prompt, attachments = state.attachments, baseMessages = state.messages) {
  if (!attachments.length) return [...baseMessages, { role: 'user', content: prompt }];

  const parts = [];
  if (prompt) parts.push({ type: 'text', text: prompt });
  const textFiles = attachments.filter(f => f.text);
  if (textFiles.length) {
    parts.push({
      type: 'text',
      text: textFiles.map(f => `\n\n[附件：${f.name}]\n${f.text}`).join(''),
    });
  }
  for (const file of attachments.filter(f => f.type.startsWith('image/') && f.dataUrl)) {
    parts.push({ type: 'image_url', image_url: { url: file.dataUrl } });
  }
  const unsupported = attachments.filter(f => !f.text && !f.type.startsWith('image/'));
  if (unsupported.length) {
    parts.push({
      type: 'text',
      text: `\n\n[以下附件已上传到页面，但未解析正文：\n${unsupported.map(f => `- ${f.name} (${f.type})：${f.unsupportedReason || '暂不支持解析'}`).join('\n')}\n]`,
    });
  }
  return [...baseMessages, { role: 'user', content: parts }];
}

function attachmentsSummaryMarkdown(attachments = state.attachments) {
  if (!attachments.length) return '';
  return '\n\n' + attachments.map(f => `📎 ${f.name}`).join('\n');
}

async function requestMultipart(url, fields, files, apiKey) {
  const cfg = getConfig();
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') form.append(k, v);
  });
  files.forEach((item, idx) => form.append(idx === 0 ? 'image' : 'image[]', item.file, item.name));
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: form,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(normalizeError(null, data));
  return data;
}

function makeClientImageJobId() {
  return `imgjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeClientChatJobId() {
  return `chatjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function startChatJob(payload, cfg, jobId) {
  const res = await fetch('/api/chat-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, payload }),
  });
  const data = await parseResponseJson(res);
  if (!res.ok) throw new Error(normalizeError(null, data));
  return data;
}

async function registerChatStreamJob(payload, cfg, jobId, options = {}) {
  const res = await fetch('/api/chat-stream-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, payload, start: options.start === true }),
  });
  const data = await parseResponseJson(res);
  if (!res.ok) throw new Error(normalizeError(null, data));
  return data;
}

async function getChatJob(jobId) {
  const res = await fetch(`/api/chat-jobs/${encodeURIComponent(jobId)}`);
  const data = await parseResponseJson(res);
  if (!res.ok) throw new Error(normalizeError(null, data));
  return data;
}

function waitJobEvent(url, onTick = () => {}) {
  return new Promise((resolve, reject) => {
    let source = null;
    let settled = false;
    let retries = 0;
    let opened = false;
    const connect = () => {
      if (settled) return;
      source = new EventSource(url);
      source.onopen = () => { opened = true; retries = 0; };
      source.addEventListener('update', (event) => {
        opened = true;
        const job = JSON.parse(event.data || '{}');
        onTick(job);
        if (job.status === 'done') {
          settled = true;
          source.close();
          resolve(job.data);
        } else if (job.status === 'error') {
          settled = true;
          source.close();
          reject(new Error(job.error?.message || '任务失败'));
        }
      });
      source.onerror = () => {
        source.close();
        if (settled || state.pageUnloading) return;
        // 404/任务不存在这类错误 EventSource 不暴露状态码，但会在首次打开前直接 error。
        // 这种情况不能一直等待，否则会话会被 busy 卡死；直接交给恢复逻辑清理本地 job。
        if (!opened) {
          settled = true;
          reject(new Error('任务不存在或服务已重启，已停止恢复任务，请重新发送'));
          return;
        }
        retries += 1;
        if (retries > 60) {
          settled = true;
          reject(new Error('任务事件连接中断，已停止恢复任务，请刷新后重试'));
          return;
        }
        setTimeout(connect, Math.min(1000 + retries * 250, 5000));
      };
    };
    connect();
  });
}

function extractChatJobText(data) {
  const message = data?.choices?.[0]?.message || {};
  return {
    content: message.content || data?.output_text || '',
    reasoning: message.reasoning_content || message.reasoning || data?.reasoning_content || data?.reasoning || '',
  };
}

async function waitChatJob(jobId, onTick = () => {}) {
  return waitJobEvent(`/api/chat-jobs/${encodeURIComponent(jobId)}/events`, onTick);
}

async function startImageGenerationJob(payload, cfg, jobId) {
  const res = await fetch('/api/image-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, payload }),
  });
  const data = await parseResponseJson(res);
  if (!res.ok) throw new Error(normalizeError(null, data));
  return data;
}

async function getImageGenerationJob(jobId) {
  const res = await fetch(`/api/image-jobs/${encodeURIComponent(jobId)}`);
  const data = await parseResponseJson(res);
  if (!res.ok) throw new Error(normalizeError(null, data));
  return data;
}

async function waitImageGenerationJob(jobId, onTick = () => {}) {
  return waitJobEvent(`/api/image-jobs/${encodeURIComponent(jobId)}/events`, onTick);
}


function createSession(title = '新对话') {
  return {
    id: `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    messages: [],
    display: [],
    lastGeneratedImage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    busy: false,
  };
}

function getActiveSession() {
  if (!state.sessions.length) {
    state.sessions = [createSession()];
    state.activeSessionId = state.sessions[0].id;
  }
  let session = state.sessions.find(item => item.id === state.activeSessionId);
  if (!session) {
    session = state.sessions[0];
    state.activeSessionId = session.id;
  }
  session.messages ||= [];
  session.display ||= [];
  return session;
}

function sessionStorageKey(base, sessionId = state.activeSessionId) {
  return `${base}:${sessionId || 'default'}`;
}

function deriveSessionTitle(session) {
  const firstUser = session.messages?.find(msg => msg.role === 'user' && msg.content)?.content || '';
  const raw = String(firstUser || session.title || '新对话').replace(/\s+/g, ' ').trim();
  return raw ? raw.slice(0, 22) : '新对话';
}


function isSessionBusy(sessionId = state.activeSessionId) {
  return state.busySessions.has(sessionId) || !!state.sessions.find(item => item.id === sessionId)?.busy;
}

function setSessionBusy(sessionId, busy) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (session) session.busy = !!busy;
  if (busy) state.busySessions.add(sessionId);
  else state.busySessions.delete(sessionId);
  state.busy = isSessionBusy(state.activeSessionId);
  updateSendAvailability();
  renderSessionList();
}

function updateSendAvailability() {
  const busy = isSessionBusy(state.activeSessionId);
  state.busy = busy;
  const btn = $('sendBtn');
  if (btn) btn.disabled = busy;
}


function setSessionSidebarCollapsed(collapsed) {
  document.body.classList.toggle('session-sidebar-collapsed', !!collapsed);
  document.documentElement.classList.toggle('session-sidebar-collapsed-boot', !!collapsed);
  localStorage.setItem(SESSION_SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  const btn = $('collapseSessionsBtn');
  if (btn) {
    btn.title = window.matchMedia('(max-width: 840px)').matches ? '模型配置' : (collapsed ? '展开会话栏' : '收起会话栏');
    btn.setAttribute('aria-label', btn.title);
  }
}

function loadSessionSidebarCollapsed() {
  setSessionSidebarCollapsed(localStorage.getItem(SESSION_SIDEBAR_COLLAPSED_KEY) === '1');
}

function applyMobileDrawerState() {
  const sidebar = $('sessionSidebar');
  if (!sidebar) return;
  if (window.matchMedia('(max-width: 840px)').matches && document.body.classList.contains('session-drawer-open')) {
    sidebar.style.display = 'flex';
    sidebar.style.transform = 'translateX(0)';
    sidebar.style.left = '0px';
  } else {
    sidebar.style.display = '';
    sidebar.style.transform = '';
    sidebar.style.left = '';
  }
}

function closeSessionDrawer() {
  document.body.classList.remove('session-drawer-open');
  applyMobileDrawerState();
}

function openSessionDrawer() {
  document.body.classList.remove('session-sidebar-collapsed');
  document.body.classList.add('session-drawer-open');
  applyMobileDrawerState();
}

function saveSessionMessages(sessionId, messages) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return;
  const safeMessages = messages.map(normalizeMessageForStorage).filter(Boolean);
  session.messages = safeMessages;
  session.title = deriveSessionTitle(session);
  session.updatedAt = Date.now();
  localStorage.setItem(sessionStorageKey(CHAT_KEY, sessionId), JSON.stringify(safeMessages));
  saveSessionsMeta();
}

function persistSessionDisplay(sessionId) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return;
  session.updatedAt = Date.now();
  localStorage.setItem(sessionStorageKey(UI_KEY, sessionId), JSON.stringify((session.display || []).slice(-80)));
  saveSessionsMeta();
}

function makeDisplayItem(role, content, { html = false, rawText = content, messageIndex = null, pending = false } = {}) {
  return {
    role,
    rawText: rawText || '',
    html: html ? String(content || '') : renderMarkdown(String(content || '')),
    reasoningText: '',
    keepReasoning: false,
    messageIndex: messageIndex !== null && messageIndex !== undefined ? String(messageIndex) : '',
    imageContext: '',
    pending: pending ? '1' : '',
  };
}

function sessionImageJobKey(sessionId = state.activeSessionId) {
  return `${IMAGE_JOB_KEY}:${sessionId}`;
}

function saveImageJob(sessionId, job) {
  if (!job?.id) return;
  localStorage.setItem(sessionImageJobKey(sessionId), JSON.stringify(job));
}

function loadImageJob(sessionId = state.activeSessionId) {
  try { return JSON.parse(localStorage.getItem(sessionImageJobKey(sessionId)) || 'null'); }
  catch { return null; }
}

function clearImageJob(sessionId = state.activeSessionId) {
  localStorage.removeItem(sessionImageJobKey(sessionId));
}

function sessionChatJobKey(sessionId = state.activeSessionId) {
  return `${CHAT_JOB_KEY}:${sessionId}`;
}

function saveChatJob(sessionId, job) {
  if (!job?.id) return;
  localStorage.setItem(sessionChatJobKey(sessionId), JSON.stringify(job));
}

function loadChatJob(sessionId = state.activeSessionId) {
  try { return JSON.parse(localStorage.getItem(sessionChatJobKey(sessionId)) || 'null'); }
  catch { return null; }
}

function clearChatJob(sessionId = state.activeSessionId) {
  localStorage.removeItem(sessionChatJobKey(sessionId));
}

function appendSessionDisplayMessage(sessionId, role, content, options = {}) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return null;
  session.display ||= [];
  const item = makeDisplayItem(role, content, options);
  session.display.push(item);
  session.display = session.display.slice(-80);
  persistSessionDisplay(sessionId);
  return item;
}

function updateSessionDisplayItem(sessionId, item, role, content, options = {}) {
  const session = state.sessions.find(session => session.id === sessionId);
  if (!session || !item) return;
  item.role = role;
  item.rawText = options.rawText ?? content;
  item.html = options.html ? String(content || '') : renderMarkdown(String(content || ''));
  if (options.pending !== undefined) item.pending = options.pending ? '1' : '';
  persistSessionDisplay(sessionId);
}

function persistDetachedResponse(sessionId, role, content, options = {}) {
  if (sessionId === state.activeSessionId) return;
  appendSessionDisplayMessage(sessionId, role, content, options);
}


function replaceLastSessionDisplayMessage(sessionId, role, content, options = {}) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return;
  session.display ||= [];
  for (let i = session.display.length - 1; i >= 0; i -= 1) {
    if (session.display[i].role === role) {
      updateSessionDisplayItem(sessionId, session.display[i], role, content, options);
      return;
    }
  }
  appendSessionDisplayMessage(sessionId, role, content, options);
}


function findMessageNodeByDisplayItem(item) {
  if (!item) return null;
  return [...$('messages').querySelectorAll('.message')].find(node => node.__displayItem === item) || null;
}

function addDisplayItemNode(item) {
  const node = addMessage(item.role || 'assistant', item.html || item.rawText || '', {
    html: !!item.html,
    rawText: item.rawText || '',
    messageIndex: item.messageIndex !== '' ? Number(item.messageIndex) : null,
    skipSave: item.pending === '1',
    deferSave: true,
  });
  node.__displayItem = item;
  if (item.imageContext) node.dataset.imageContext = item.imageContext;
  if (item.reasoningText) updateReasoning(node, item.reasoningText, { done: true, keepReasoning: item.keepReasoning !== false });
  return node;
}

function removeDisplayItemNode(item) {
  const node = findMessageNodeByDisplayItem(item);
  if (node) node.remove();
}

function takePendingLiveItem(sessionId, fallbackText, matcher = null) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return null;
  session.display ||= [];
  const pendingItems = session.display.filter(item => item.pending === '1' && (item.role === 'assistant' || !item.role));
  let liveItem = null;
  if (matcher) liveItem = [...pendingItems].reverse().find(item => matcher.test(item.rawText || '')) || null;
  if (!liveItem) liveItem = pendingItems[pendingItems.length - 1] || null;
  if (!liveItem) {
    liveItem = appendSessionDisplayMessage(sessionId, 'assistant', fallbackText, { rawText: fallbackText, pending: true });
  }
  const removeSet = new Set(pendingItems.filter(item => item !== liveItem));
  if (removeSet.size) {
    session.display = session.display.filter(item => !removeSet.has(item));
    removeSet.forEach(removeDisplayItemNode);
    persistSessionDisplay(sessionId);
  }
  return liveItem;
}

function updateLiveDisplay(sessionId, item, role, content, options = {}) {
  updateSessionDisplayItem(sessionId, item, role, content, { ...options, pending: options.pending ?? true });
  if (sessionId !== state.activeSessionId) return;
  let node = findMessageNodeByDisplayItem(item);
  if (!node) node = addDisplayItemNode(item);
  if (options.reasoning !== undefined) updateReasoning(node, options.reasoning || '', { keepEmpty: true });
  const light = options.pending !== false && !options.html;
  if (light) updateMessageContentLight(node, content, { ...options, skipSave: true, forceScroll: options.forceScroll ?? false });
  else updateMessage(node, content, { ...options, skipSave: options.pending !== false });
}

function isAbortLikeError(err) {
  const text = String(err?.message || err || '').toLowerCase();
  return err?.name === 'AbortError'
    || text.includes('failed to fetch')
    || text.includes('fetch failed')
    || text.includes('networkerror')
    || text.includes('load failed')
    || text.includes('the network connection was lost')
    || text.includes('cancelled')
    || text.includes('canceled')
    || text.includes('任务事件连接中断');
}

function showRunError(sessionId, err, liveItem = null, loadingNode = null) {
  if (state.pageUnloading && isAbortLikeError(err)) return;
  const text = err?.message || String(err);
  if (liveItem) {
    updateSessionDisplayItem(sessionId, liveItem, 'error', text, { rawText: text, pending: false });
  } else {
    persistDetachedResponse(sessionId, 'error', text, { rawText: text });
  }

  if (sessionId === state.activeSessionId) {
    const node = loadingNode?.isConnected ? loadingNode : findMessageNodeByDisplayItem(liveItem);
    if (node) {
      node.classList.remove('assistant');
      node.classList.add('error');
      node.querySelector('.avatar').textContent = '!';
      updateMessage(node, text, { rawText: text });
    } else {
      addMessage('error', text, { rawText: text });
    }
  }
}


function cleanupStalePendingDisplay(sessionId, pattern, message) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session?.display?.length) return null;
  const item = [...session.display].reverse().find(item => item.pending === '1' && pattern.test(item.rawText || ''));
  if (!item) return null;
  updateSessionDisplayItem(sessionId, item, 'error', message, { rawText: message, pending: false });
  if (sessionId === state.activeSessionId) {
    const node = findMessageNodeByDisplayItem(item);
    if (node) {
      node.classList.remove('assistant');
      node.classList.add('error');
      const avatar = node.querySelector('.avatar');
      if (avatar) avatar.textContent = '!';
      updateMessage(node, message, { rawText: message });
    }
  }
  return item;
}

function isMissingJobError(err) {
  return String(err?.message || err || '').includes('任务不存在或服务已重启');
}

function appendDetachedError(sessionId, err) {
  showRunError(sessionId, err);
}

function syncActiveSession({ skipSave = false } = {}) {
  const session = getActiveSession();
  state.messages = [...(session.messages || [])];
  state.lastGeneratedImage = session.lastGeneratedImage || null;
  if (!skipSave) saveSessionsMeta();
  renderSessionList();
}

function saveSessionsMeta() {
  try {
    const sessions = state.sessions.map(session => ({
      id: session.id,
      title: deriveSessionTitle(session),
      createdAt: session.createdAt || Date.now(),
      updatedAt: session.updatedAt || Date.now(),
    }));
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    localStorage.setItem(ACTIVE_SESSION_KEY, state.activeSessionId || getActiveSession().id);
  } catch (err) {
    console.warn('save sessions meta failed', err);
  }
}

function loadSessions() {
  let sessions = [];
  try {
    const saved = readJsonStorage(SESSIONS_KEY, []);
    if (Array.isArray(saved)) {
      sessions = saved
        .filter(item => item && item.id)
        .map(item => ({
          id: item.id,
          title: item.title || '新对话',
          createdAt: item.createdAt || Date.now(),
          updatedAt: item.updatedAt || Date.now(),
          messages: readJsonStorage(sessionStorageKey(CHAT_KEY, item.id), []),
          display: readJsonStorage(sessionStorageKey(UI_KEY, item.id), []),
          lastGeneratedImage: readJsonStorage(sessionStorageKey(LAST_IMAGE_KEY, item.id), null),
          busy: false,
        }));
    }
  } catch (err) {
    console.warn('load sessions failed', err);
  }

  if (!sessions.length) {
    const legacyMessages = readJsonStorage(LEGACY_CHAT_KEY, []);
    const legacyDisplay = readJsonStorage(LEGACY_UI_KEY, []);
    const legacyImage = readJsonStorage(LAST_IMAGE_KEY, null);
    const session = createSession();
    session.messages = Array.isArray(legacyMessages) ? legacyMessages : [];
    session.display = Array.isArray(legacyDisplay) ? legacyDisplay : [];
    session.lastGeneratedImage = legacyImage;
    session.title = deriveSessionTitle(session);
    sessions = [session];
  }

  state.sessions = sessions;
  state.activeSessionId = localStorage.getItem(ACTIVE_SESSION_KEY) || sessions[0].id;
  syncActiveSession({ skipSave: true });
}

function sessionTitleHtml(session) {
  const text = deriveSessionTitle(session);
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}


function deleteSession(sessionId) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return;
  clearChatJob(sessionId);
  clearImageJob(sessionId);
  setSessionBusy(sessionId, false);
  localStorage.removeItem(sessionStorageKey(CHAT_KEY, sessionId));
  localStorage.removeItem(sessionStorageKey(UI_KEY, sessionId));
  localStorage.removeItem(sessionStorageKey(LAST_IMAGE_KEY, sessionId));
  state.busySessions.delete(sessionId);
  state.sessions = state.sessions.filter(item => item.id !== sessionId);
  if (!state.sessions.length) state.sessions = [createSession()];
  if (state.activeSessionId === sessionId) {
    state.activeSessionId = state.sessions[0].id;
    localStorage.setItem(ACTIVE_SESSION_KEY, state.activeSessionId);
    syncActiveSession({ skipSave: true });
    renderActiveSession();
  }
  saveSessionsMeta();
  renderSessionList();
  updateSendAvailability();
}

function getSessionReturnCount(session) {
  if (!session) return 0;
  const messages = session.id === state.activeSessionId && !isSessionBusy(session.id)
    ? state.messages
    : (session.messages || []);
  const assistantCount = Array.isArray(messages)
    ? messages.filter(msg => msg?.role === 'assistant').length
    : 0;
  if (assistantCount) return assistantCount;
  const display = session.id === state.activeSessionId && !isSessionBusy(session.id)
    ? [...$('messages')?.querySelectorAll('.message.assistant, .message.error') || []]
    : (session.display || []).filter(item => item?.role === 'assistant' || item?.role === 'error');
  return Array.isArray(display) ? display.length : 0;
}

function renderSessionList() {
  const list = $('sessionList');
  if (!list) return;
  list.innerHTML = '';
  state.sessions.forEach(session => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'session-tab';
      btn.classList.toggle('active', session.id === state.activeSessionId);
      btn.classList.toggle('busy', isSessionBusy(session.id));
      btn.dataset.sessionId = session.id;
      btn.innerHTML = `<span class="session-title">${sessionTitleHtml(session)}</span><small>${getSessionReturnCount(session)} 条</small><button class="session-delete-btn" type="button" title="删除会话" aria-label="删除会话">×</button>`;
      btn.addEventListener('click', (event) => {
        if (event.target.closest('.session-delete-btn')) return;
        switchSession(session.id);
      });
      btn.querySelector('.session-delete-btn')?.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteSession(session.id);
      });
      list.appendChild(btn);
    });
}

function renderActiveSession() {
  const session = getActiveSession();
  $('messages').innerHTML = '';
  state.messages = [...(session.messages || [])];
  state.lastGeneratedImage = session.lastGeneratedImage || null;
  if (!loadDisplayHistory()) loadChatHistory({ render: true });
  if (!$('messages').children.length) {
    $('messages').innerHTML = `<div class="empty"><div class="empty-icon">💬</div><h3>新对话</h3><p>当前会话独立保存上下文；可点击“新会话”开启另一条隔离对话。</p></div>`;
  }
  renderSessionList();
  scrollToBottom(true);
  resumeSessionJobs(session.id);
}

function switchSession(sessionId) {
  if (state.activeSessionId) {
    try { if (!isSessionBusy(state.activeSessionId)) { saveChatHistory(); saveDisplayHistory(); } } catch (err) { console.warn('save before switch failed', err); }
  }
  state.editingIndex = null;
  state.editingNode = null;
  delete $('prompt')?.dataset.editing;
  $('prompt').value = '';
  scheduleAutoResize();
  if (!state.sessions.some(item => item.id === sessionId)) return;
  state.activeSessionId = sessionId;
  localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
  syncActiveSession({ skipSave: true });
  renderActiveSession();
  updateSendAvailability();
  closeSessionDrawer();
  resumeSessionJobs(sessionId);
}


function newSession() {
  if (state.activeSessionId) {
    try { if (!isSessionBusy(state.activeSessionId)) { saveChatHistory(); saveDisplayHistory(); } } catch (err) { console.warn('save before new session failed', err); }
  }
  state.editingIndex = null;
  state.editingNode = null;
  delete $('prompt')?.dataset.editing;
  $('prompt').value = '';
  scheduleAutoResize();
  const session = createSession();
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  state.messages = [];
  state.lastGeneratedImage = null;
  saveSessionsMeta();
  localStorage.setItem(sessionStorageKey(CHAT_KEY), '[]');
  localStorage.setItem(sessionStorageKey(UI_KEY), '[]');
  localStorage.removeItem(sessionStorageKey(LAST_IMAGE_KEY));
  renderActiveSession();
  updateSendAvailability();
  closeSessionDrawer();
  $('prompt')?.focus();
}

function saveDisplayHistory() {
  const items = [...$('messages').querySelectorAll('.message')]
    .filter(node => node.dataset.persist !== '0')
    .map(node => {
      const clone = node.querySelector('.content')?.cloneNode(true);
      clone?.querySelectorAll('.reasoning-panel').forEach(el => el.remove());
      clone?.querySelectorAll('[data-image-action-clone]').forEach(el => el.remove());
      clone?.querySelectorAll('[data-preview-bound]').forEach(el => el.removeAttribute('data-preview-bound'));
      clone?.querySelectorAll('[data-download-bound]').forEach(el => el.removeAttribute('data-download-bound'));
      clone?.querySelectorAll('img[data-persisted-src]').forEach(el => {
        el.setAttribute('src', TRANSPARENT_PIXEL);
        el.classList.add('image-restoring');
        el.removeAttribute('data-object-url');
      });
      clone?.querySelectorAll('a[data-persisted-href]').forEach(el => {
        el.setAttribute('href', el.dataset.persistedHref);
        el.removeAttribute('data-object-url');
      });
      clone?.querySelectorAll('button[data-persisted-href]').forEach(el => {
        el.removeAttribute('data-object-url');
      });
      const reasoningText = node.dataset.keepReasoning === '1' ? (node.dataset.reasoningText || '') : '';
      return {
        role: node.classList.contains('user') ? 'user' : node.classList.contains('error') ? 'error' : 'assistant',
        rawText: node.dataset.rawText || '',
        html: clone?.innerHTML || '',
        reasoningText,
        keepReasoning: node.dataset.keepReasoning === '1',
        messageIndex: node.dataset.messageIndex || '',
        imageContext: node.dataset.imageContext || '',
      };
    }).slice(-80);
  const session = getActiveSession();
  session.display = items;
  session.updatedAt = Date.now();
  try {
    localStorage.setItem(sessionStorageKey(UI_KEY), JSON.stringify(items));
    saveSessionsMeta();
  } catch (err) { console.warn('save display history failed', err); }
}


function normalizePersistedHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('[data-image-action-clone]').forEach(el => el.remove());
  tpl.content.querySelectorAll('[data-preview-bound]').forEach(el => el.removeAttribute('data-preview-bound'));
  tpl.content.querySelectorAll('[data-download-bound]').forEach(el => el.removeAttribute('data-download-bound'));
  tpl.content.querySelectorAll('img[data-persisted-src]').forEach(el => {
    if (el.dataset.persistedSrc?.startsWith('indexeddb://')) {
      el.setAttribute('src', TRANSPARENT_PIXEL);
      el.classList.add('image-restoring');
    }
    el.removeAttribute('data-object-url');
  });
  tpl.content.querySelectorAll('a[data-persisted-href]').forEach(el => {
    if (el.dataset.persistedHref?.startsWith('indexeddb://')) el.setAttribute('href', el.dataset.persistedHref);
    el.removeAttribute('data-object-url');
  });
  tpl.content.querySelectorAll('button[data-persisted-href]').forEach(el => {
    el.removeAttribute('data-object-url');
  });
  return tpl.innerHTML;
}

function loadDisplayHistory() {
  try {
    const items = getActiveSession().display?.length ? getActiveSession().display : readJsonStorage(sessionStorageKey(UI_KEY), []);
    if (!Array.isArray(items) || !items.length) return false;
    $('messages').innerHTML = '';
    items.forEach(item => {
      if (item.html) item.html = normalizePersistedHtml(item.html);
      const node = addDisplayItemNode(item);
      if (item.pending === '1' && node) node.dataset.persist = '0';
    });
    hydrateMessageMedia($('messages'), { save: false });
    return true;
  } catch {
    localStorage.removeItem(sessionStorageKey(UI_KEY));
    return false;
  }
}

function saveLastGeneratedImage() {
  try {
    const session = getActiveSession();
    session.lastGeneratedImage = state.lastGeneratedImage || null;
    if (state.lastGeneratedImage) localStorage.setItem(sessionStorageKey(LAST_IMAGE_KEY), JSON.stringify(state.lastGeneratedImage));
    else localStorage.removeItem(sessionStorageKey(LAST_IMAGE_KEY));
    saveSessionsMeta();
  } catch {}
}

function loadLastGeneratedImage() {
  try {
    state.lastGeneratedImage = getActiveSession().lastGeneratedImage || readJsonStorage(sessionStorageKey(LAST_IMAGE_KEY), null);
  } catch {
    localStorage.removeItem(sessionStorageKey(LAST_IMAGE_KEY));
  }
}

function updateReasoningToggleUi() {
  const btn = $('reasoningToggle');
  if (!btn) return;
  btn.classList.toggle('active', state.reasoningPersist);
  btn.setAttribute('aria-pressed', state.reasoningPersist ? 'true' : 'false');
  btn.title = state.reasoningPersist ? '思考内容将保持显示' : '思考内容将在响应结束后自动收起';
  btn.setAttribute('aria-label', btn.title);
}

function loadReasoningPreference() {
  state.reasoningPersist = localStorage.getItem(REASONING_PERSIST_KEY) !== '0';
  updateReasoningToggleUi();
}

function setReasoningPersist(enabled) {
  state.reasoningPersist = !!enabled;
  localStorage.setItem(REASONING_PERSIST_KEY, state.reasoningPersist ? '1' : '0');
  updateReasoningToggleUi();
}

function normalizeMessageForStorage(msg) {
  if (!msg || !msg.role) return null;
  if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
  if (Array.isArray(msg.content)) {
    const text = msg.content
      .filter(part => part?.type === 'text')
      .map(part => part.text || '')
      .join('\n');
    return { role: msg.role, content: text || '[非文本附件消息]' };
  }
  return { role: msg.role, content: String(msg.content || '') };
}

function saveChatHistory() {
  const safeMessages = state.messages.map(normalizeMessageForStorage).filter(Boolean);
  const session = getActiveSession();
  session.messages = safeMessages;
  session.title = deriveSessionTitle(session);
  session.updatedAt = Date.now();
  localStorage.setItem(sessionStorageKey(CHAT_KEY), JSON.stringify(safeMessages));
  saveSessionsMeta();
}

function loadChatHistory({ render = false } = {}) {
  try {
    const saved = getActiveSession().messages?.length ? getActiveSession().messages : readJsonStorage(sessionStorageKey(CHAT_KEY), []);
    if (!Array.isArray(saved) || !saved.length) return;
    state.messages = saved.filter(m => m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string');
    if (!render || !state.messages.length) return;
    clearEmpty();
    $('messages').innerHTML = '';
    state.messages.forEach((msg, index) => {
      addMessage(msg.role === 'assistant' ? 'assistant' : 'user', msg.content, {
        rawText: msg.content,
        messageIndex: msg.role === 'user' ? index : null,
        skipSave: true,
      });
    });
  } catch {
    localStorage.removeItem(sessionStorageKey(CHAT_KEY));
  }
}

async function sendChat(prompt, attachments = state.attachments, loadingNode = null, options = {}) {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.chatModel) throw new Error('请先配置 Endpoint Base URL 和聊天模型');

  const sessionId = options.sessionId || state.activeSessionId;
  const session = state.sessions.find(item => item.id === sessionId) || getActiveSession();
  const baseMessages = sessionId === state.activeSessionId ? state.messages : [...(session.messages || [])];
  const requestBaseMessages = options.userAlreadyAdded && baseMessages.at(-1)?.role === 'user'
    ? baseMessages.slice(0, -1)
    : baseMessages;
  const requestMessages = buildChatMessagesWithAttachments(prompt, attachments, requestBaseMessages);
  if (sessionId === state.activeSessionId) {
    if (!options.userAlreadyAdded) state.messages.push({ role: 'user', content: prompt });
    saveChatHistory();
  } else {
    if (!options.userAlreadyAdded) baseMessages.push({ role: 'user', content: prompt });
    saveSessionMessages(sessionId, baseMessages);
  }
  const loading = sessionId === state.activeSessionId
    ? (loadingNode || addMessage('assistant', pendingFeedbackHtml('已收到，马上处理'), { html: true, rawText: '已收到，马上处理', skipSave: true }))
    : null;
  const liveItem = options.liveItem || appendSessionDisplayMessage(sessionId, 'assistant', pendingFeedbackHtml('已收到，马上处理'), { html: true, rawText: '已收到，马上处理', pending: true });
  if (loading && liveItem && !loading.__displayItem) loading.__displayItem = liveItem;

  const payload = {
    model: cfg.chatModel,
    messages: requestMessages,
    temperature: 0.7,
    stream: true,
  };
  const backgroundJobId = !attachments.length ? makeClientChatJobId() : '';
  if (backgroundJobId) {
    saveChatJob(sessionId, { id: backgroundJobId, prompt, payload, startedAt: Date.now() });
    // 正常发送只预登记，不启动后台流；刷新恢复时才 start，避免占用同一个 job 导致正常 token 流式被中断。
    registerChatStreamJob(payload, cfg, backgroundJobId, { start: false }).catch(err => console.warn('register chat stream job failed', err));
  }

  try {
    const renderer = createRealtimeRenderer((visible) => {
      const text = visible || '正在思考中';
      if (loading?.isConnected) {
        clearPendingFeedback(loading);
        updateMessageContentLight(loading, text, { rawText: text, skipSave: true, forceScroll: false });
      }
      updateLiveDisplay(sessionId, liveItem, 'assistant', text, { rawText: text, pending: true, forceScroll: false });
    });
    const reasoningRenderer = createRealtimeRenderer((visible) => {
      if (loading?.isConnected) updateReasoning(loading, visible || '', { forceScroll: false });
      if (liveItem) liveItem.reasoningText = visible || '';
    });
    if (loading?.isConnected) {
      updateReasoning(loading, '', { keepEmpty: true });
      setPendingFeedback(loading, '正在处理，请稍等');
    }
    const result = await streamChatCompletions(`${cfg.baseUrl}/chat/completions`, payload, cfg.apiKey, (partial) => {
      renderer.set(partial.content || '');
      reasoningRenderer.set(partial.reasoning || '');
    }, backgroundJobId);
    if (loading?.isConnected) clearPendingFeedback(loading);
    const finalReply = result.content || '没有返回内容';
    renderer.flush(finalReply);
    reasoningRenderer.cancel();
    if (sessionId === state.activeSessionId) {
      state.messages.push({ role: 'assistant', content: finalReply });
      saveChatHistory();
      if (loading?.isConnected) {
        updateMessage(loading, finalReply, { rawText: finalReply });
        finishReasoning(loading, result.reasoning || '');
      }
      updateLiveDisplay(sessionId, liveItem, 'assistant', finalReply, { rawText: finalReply, pending: false });
      if (backgroundJobId) clearChatJob(sessionId);
    } else {
      baseMessages.push({ role: 'assistant', content: finalReply });
      saveSessionMessages(sessionId, baseMessages);
      updateLiveDisplay(sessionId, liveItem, 'assistant', finalReply, { rawText: finalReply, pending: false });
      if (backgroundJobId) clearChatJob(sessionId);
    }
    playDoneSound();
  } catch (err) {
    if (state.pageUnloading && isAbortLikeError(err)) return;
    // 少数 OpenAI 兼容端点不支持 stream=true，自动降级成普通请求；刷新/返回导致的 Safari Load failed 不降级、不落错误气泡。
    const fallbackPayload = {
      model: cfg.chatModel,
      messages: requestMessages,
      temperature: 0.7,
    };
    if (loading?.isConnected) setPendingFeedback(loading, '响应有点慢，正在继续尝试');
    const data = await requestJson(`${cfg.baseUrl}/chat/completions`, fallbackPayload, cfg.apiKey);
    if (loading?.isConnected) clearPendingFeedback(loading);
    const reply = data?.choices?.[0]?.message?.content || data?.output_text || `流式失败，且普通请求没有返回内容：${err.message || err}`;
    if (sessionId === state.activeSessionId) {
      state.messages.push({ role: 'assistant', content: reply });
      saveChatHistory();
      if (loading?.isConnected) {
        updateMessage(loading, reply, { rawText: reply });
        finishReasoning(loading, data?.choices?.[0]?.message?.reasoning_content || data?.choices?.[0]?.message?.reasoning || data?.reasoning_content || data?.reasoning || '');
      }
      updateLiveDisplay(sessionId, liveItem, 'assistant', reply, { rawText: reply, pending: false });
      if (backgroundJobId) clearChatJob(sessionId);
    } else {
      baseMessages.push({ role: 'assistant', content: reply });
      saveSessionMessages(sessionId, baseMessages);
      updateLiveDisplay(sessionId, liveItem, 'assistant', reply, { rawText: reply, pending: false });
      if (backgroundJobId) clearChatJob(sessionId);
    }
    playDoneSound();
  }
}

function createRealtimeRenderer(onUpdate) {
  let latest = '';
  let scheduled = false;
  let cancelled = false;

  return {
    set(next) {
      if (cancelled) return;
      latest = String(next || '');
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (!cancelled) onUpdate(latest);
      });
    },
    flush(finalText) {
      if (cancelled) return;
      latest = String(finalText || '');
      scheduled = false;
      onUpdate(latest);
    },
    cancel() {
      cancelled = true;
      scheduled = false;
      latest = '';
    },
  };
}

async function streamChatCompletions(url, payload, apiKey, onDelta, jobId = '') {
  const cfg = getConfig();
  const direct = cfg.directMode;
  const finalUrl = direct ? url : toProxyUrl(url, cfg.baseUrl);
  const finalPayload = direct ? payload : { baseUrl: cfg.baseUrl, apiKey, payload, jobId };

  let res;
  try {
    res = await fetch(finalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(direct && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(finalPayload),
    });
  } catch (err) {
    throw new Error(`连接接口失败：${err?.message || '网络请求失败'}`);
  }

  if (!res.ok) {
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    throw new Error(normalizeError(null, data));
  }
  if (!res.body) throw new Error('当前浏览器不支持流式读取 Response.body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let reasoningFull = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const dataText = trimmed.slice(5).trim();
      if (dataText === '[DONE]') return { content: full, reasoning: reasoningFull };
      try {
        const data = JSON.parse(dataText);
        const delta = extractStreamDelta(data);
        if (delta.reasoning) reasoningFull += delta.reasoning;
        if (delta.content) full += delta.content;
        if (delta.content || delta.reasoning) {
          onDelta({ content: full, reasoning: reasoningFull });
        }
      } catch {
        // 忽略非 JSON 心跳片段。
      }
    }
  }

  return { content: full, reasoning: reasoningFull };
}

function extractStreamDelta(data) {
  const choice = data?.choices?.[0];
  const delta = choice?.delta || {};
  const message = choice?.message || {};

  const reasoning = delta.reasoning_content
    || delta.reasoning
    || delta.thinking
    || message.reasoning_content
    || message.reasoning
    || message.thinking
    || data?.reasoning_content
    || data?.reasoning
    || data?.thinking
    || '';

  let content = delta.content
    || message.content
    || (typeof data?.delta === 'string' ? data.delta : '')
    || (typeof data?.content === 'string' ? data.content : '')
    || '';

  if (!content && Array.isArray(data?.output)) {
    content = data.output.map(item => item?.content?.map(c => c?.text || '').join('') || '').join('');
  }

  return { content, reasoning };
}

async function imageResultToHtml(data, elapsedText = '', meta = {}) {
  const item = data?.data?.[0];
  if (!item) return { html: `${elapsedText ? `<p class="image-time">耗时：${escapeHtml(elapsedText)}</p>` : ''}没有返回图片数据`, raw: JSON.stringify(data, null, 2) };
  const url = item.url;
  const b64 = item.b64_json || item.image_base64;
  const src = url || (b64 ? `data:image/png;base64,${b64}` : '');
  if (!src) return { html: `${elapsedText ? `<p class="image-time">耗时：${escapeHtml(elapsedText)}</p>` : ''}<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`, raw: JSON.stringify(data, null, 2) };
  const filename = `generated-${Date.now()}.png`;
  const cfg = getConfig();
  const persistedImage = await persistImageSrc(src, filename, { ...cfg, returnDisplayUrl: true });
  const persistedSrc = persistedImage.persistedSrc || src;
  const displaySrc = persistedImage.displaySrc || persistedSrc;
  const lastImage = { src: persistedSrc, filename, prompt: meta.prompt || '', updatedAt: Date.now() };
  if (meta.sessionId && meta.sessionId !== state.activeSessionId) {
    const session = state.sessions.find(item => item.id === meta.sessionId);
    if (session) {
      session.lastGeneratedImage = lastImage;
      localStorage.setItem(sessionStorageKey(LAST_IMAGE_KEY, meta.sessionId), JSON.stringify(lastImage));
      saveSessionsMeta();
    }
  } else {
    state.lastGeneratedImage = lastImage;
    saveLastGeneratedImage();
  }
  return {
    raw: url || '[base64 image]',
    html: `<div class="image-result-head"><span>${elapsedText ? `生成完成，耗时：${escapeHtml(elapsedText)}` : '生成完成'}</span></div><img class="generated-thumb" src="${escapeHtml(displaySrc)}" data-persisted-src="${escapeHtml(persistedSrc)}" data-filename="${escapeHtml(filename)}" alt="generated image" /><div class="image-download-row">${imageActionButtonsHtml(persistedSrc, filename)}${url ? `<a class="image-icon-btn" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="打开原图" aria-label="打开原图"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"/></svg></a>` : ''}</div>`,
  };
}

async function sendImage(prompt, options = {}) {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.imageModel) throw new Error('请先配置 Endpoint Base URL 和生图模型');

  const sessionId = options.sessionId || state.activeSessionId;
  const session = state.sessions.find(item => item.id === sessionId) || getActiveSession();
  const baseMessages = sessionId === state.activeSessionId ? state.messages : [...(session.messages || [])];
  let requestStart = 0;
  let timer = null;
  const loading = sessionId === state.activeSessionId
    ? (options.loadingNode || addMessage('assistant', pendingFeedbackHtml('已收到，正在准备图片'), { html: true, rawText: '已收到，正在准备图片', skipSave: true }))
    : null;
  const liveItem = options.liveItem || appendSessionDisplayMessage(sessionId, 'assistant', pendingFeedbackHtml('已收到，正在准备图片'), { html: true, rawText: '已收到，正在准备图片', pending: true });
  if (loading && liveItem && !loading.__displayItem) loading.__displayItem = liveItem;

  const startImageTimer = (label = '正在生成图片') => {
    requestStart = performance.now();
    if (loading?.isConnected) {
      clearPendingFeedback(loading);
      updateMessage(loading, `${label}… 已等待 0 秒`, { rawText: `${label}… 已等待 0 秒`, skipSave: true });
    }
    updateLiveDisplay(sessionId, liveItem, 'assistant', `${label}… 已等待 0 秒`, { rawText: `${label}… 已等待 0 秒`, pending: true });
    timer = setInterval(() => {
      const seconds = Math.floor((performance.now() - requestStart) / 1000);
      const text = `${label}… 已等待 ${seconds} 秒`;
      if (loading?.isConnected) updateMessage(loading, text, { rawText: text, skipSave: true });
      updateLiveDisplay(sessionId, liveItem, 'assistant', text, { rawText: text, pending: true });
    }, 1000);
  };

  const payload = { model: cfg.imageModel, prompt, n: 1 };
  if (cfg.imageSize && cfg.imageSize !== 'auto') payload.size = cfg.imageSize;

  try {
    const attachments = options.attachments || state.attachments;
    let imageRefs = attachments.filter(f => isImageFile(f));
    let usedPreviousImage = false;
    if (!imageRefs.length && options.usePreviousImage) {
      const previous = await getPreviousImageAsAttachment(sessionId);
      if (!previous) throw new Error('没有可编辑的上一张图片');
      imageRefs = [previous];
      usedPreviousImage = true;
      if (loading?.isConnected) updateMessage(loading, '已准备上一张图片，正在发送修改请求…', { rawText: '已准备上一张图片，正在发送修改请求…', skipSave: true });
      updateLiveDisplay(sessionId, liveItem, 'assistant', '已准备上一张图片，正在发送修改请求…', { rawText: '已准备上一张图片，正在发送修改请求…', pending: true });
    } else if (!imageRefs.length && options.editMode) {
      throw new Error('没有可编辑的图片，请先上传图片，或明确说明要基于上一张图修改');
    }
    const imageContext = {
      prompt,
      mode: imageRefs.length ? 'edit_image' : 'image',
      target: usedPreviousImage ? 'previous' : (imageRefs.length ? (options.editTarget || 'uploaded') : 'new'),
      usePreviousImage: usedPreviousImage || !!options.imageContext?.usePreviousImage,
      attachments: imageRefs.map(serializeImageAttachment).filter(Boolean),
    };
    if (loading?.isConnected) {
      setImageContext(loading, imageContext);
      setPendingFeedback(loading, '正在处理，请稍等');
    }
    startImageTimer(imageRefs.length ? '正在修改图片' : '正在生成图片');
    let data;
    if (imageRefs.length) {
      data = await requestMultipart(`${cfg.baseUrl}/images/edits`, payload, imageRefs, cfg.apiKey);
    } else {
      const jobId = makeClientImageJobId();
      saveImageJob(sessionId, { id: jobId, prompt, payload, startedAt: Date.now(), liveItemRawText: liveItem?.rawText || '' });
      const job = await startImageGenerationJob(payload, cfg, jobId);
      saveImageJob(sessionId, { id: job.id, prompt, payload, startedAt: job.createdAt || Date.now(), liveItemRawText: liveItem?.rawText || '' });
      data = await waitImageGenerationJob(job.id);
      clearImageJob(sessionId);
    }
    const elapsedText = formatElapsed(performance.now() - requestStart);
    const result = await imageResultToHtml(data, elapsedText, { prompt, sessionId });
    if (usedPreviousImage || imageContext.mode === 'edit_image') result.html = result.html.replace('生成完成', usedPreviousImage ? '基于上一张图修改完成' : '图片修改完成');
    const assistantText = usedPreviousImage ? `[图片编辑完成] ${prompt}` : `[图片生成完成] ${prompt}`;
    if (sessionId === state.activeSessionId) {
      if (loading?.isConnected) {
        updateMessage(loading, result.html, { html: true, rawText: `${result.raw}\n耗时：${elapsedText}` });
        setImageContext(loading, imageContext);
      } else appendSessionDisplayMessage(sessionId, 'assistant', result.html, { html: true, rawText: `${result.raw}\n耗时：${elapsedText}` });
      if (!options.userAlreadyAdded) state.messages.push({ role: 'user', content: prompt });
      state.messages.push({ role: 'assistant', content: assistantText });
      saveChatHistory();
    } else {
      if (!options.userAlreadyAdded) baseMessages.push({ role: 'user', content: prompt });
      baseMessages.push({ role: 'assistant', content: assistantText });
      saveSessionMessages(sessionId, baseMessages);
      replaceLastSessionDisplayMessage(sessionId, 'assistant', result.html, { html: true, rawText: `${result.raw}\n耗时：${elapsedText}` });
      session.lastGeneratedImage = state.lastGeneratedImage;
    }
    playDoneSound();
  } finally {
    if (timer) clearInterval(timer);
  }
}

async function resumeImageJob(sessionId = state.activeSessionId) {
  const resumeKey = `image:${sessionId}`;
  if (state.resumingJobs.has(resumeKey)) return;
  state.resumingJobs.add(resumeKey);
  const saved = loadImageJob(sessionId);
  if (!saved?.id) { state.resumingJobs.delete(resumeKey); return; }
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) { clearImageJob(sessionId); state.resumingJobs.delete(resumeKey); return; }
  let liveItem = takePendingLiveItem(sessionId, '正在恢复图片生成任务…', /正在生成图片|正在恢复图片生成任务|已收到/);
  setSessionBusy(sessionId, true);
  const start = saved.startedAt || Date.now();
  const tick = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    updateLiveDisplay(sessionId, liveItem, 'assistant', `正在生成图片… 已等待 ${seconds} 秒`, { rawText: `正在生成图片… 已等待 ${seconds} 秒`, pending: true });
  };
  const timer = setInterval(tick, 1000);
  tick();
  try {
    const cfg = getConfig();
    if (saved.payload && cfg.baseUrl) await startImageGenerationJob(saved.payload, cfg, saved.id);
    const data = await waitImageGenerationJob(saved.id, tick);
    const elapsedText = formatElapsed(Date.now() - start);
    const result = await imageResultToHtml(data, elapsedText, { prompt: saved.prompt || '', sessionId });
    updateSessionDisplayItem(sessionId, liveItem, 'assistant', result.html, { html: true, rawText: `${result.raw}\n耗时：${elapsedText}`, pending: false });
    if (sessionId === state.activeSessionId) {
      const node = findMessageNodeByDisplayItem(liveItem);
      if (node) updateMessage(node, result.html, { html: true, rawText: `${result.raw}\n耗时：${elapsedText}` });
    }
    const baseMessages = [...(session.messages || [])];
    baseMessages.push({ role: 'assistant', content: `[图片生成完成] ${saved.prompt || ''}` });
    saveSessionMessages(sessionId, baseMessages);
    clearImageJob(sessionId);
    playDoneSound();
  } catch (err) {
    clearImageJob(sessionId);
    const message = isMissingJobError(err)
      ? '恢复任务不存在或已失效，已停止恢复，请重新发送'
      : (err?.message || String(err));
    if (isMissingJobError(err)) cleanupStalePendingDisplay(sessionId, /正在生成图片|正在恢复图片生成任务|已收到/, message);
    else showRunError(sessionId, err, liveItem, findMessageNodeByDisplayItem(liveItem));
    if (isMissingJobError(err) && sessionId === state.activeSessionId && !findMessageNodeByDisplayItem(liveItem)) addMessage('error', message, { rawText: message });
  } finally {
    clearInterval(timer);
    setSessionBusy(sessionId, false);
    state.resumingJobs.delete(resumeKey);
  }
}

async function resumeChatJob(sessionId = state.activeSessionId) {
  const resumeKey = `chat:${sessionId}`;
  if (state.resumingJobs.has(resumeKey)) return;
  state.resumingJobs.add(resumeKey);
  const saved = loadChatJob(sessionId);
  if (!saved?.id) { state.resumingJobs.delete(resumeKey); return; }
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) { clearChatJob(sessionId); state.resumingJobs.delete(resumeKey); return; }
  let liveItem = takePendingLiveItem(sessionId, '正在恢复聊天任务…', /正在处理|正在思考|正在恢复聊天任务|已收到/);
  setSessionBusy(sessionId, true);
  const start = saved.startedAt || Date.now();
  const isStatusText = (text = '') => /正在处理|正在思考|正在恢复聊天任务|已收到/.test(String(text || ''));
  let hasOutput = !!String(liveItem?.rawText || '').trim() && !isStatusText(liveItem.rawText || '');
  const tick = () => {
    if (hasOutput) return;
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    updateLiveDisplay(sessionId, liveItem, 'assistant', `正在处理… 已等待 ${seconds} 秒`, { rawText: `正在处理… 已等待 ${seconds} 秒`, pending: true });
  };
  const timer = setInterval(tick, 1000);
  try {
    const cfg = getConfig();
    const onJobUpdate = (job) => {
      const partial = extractChatJobText(job.data);
      if (partial.content || partial.reasoning) {
        hasOutput = !!partial.content || hasOutput;
        updateLiveDisplay(sessionId, liveItem, 'assistant', partial.content || (hasOutput ? liveItem.rawText || '' : '正在思考中'), { rawText: partial.content || liveItem.rawText || '', pending: true, reasoning: partial.reasoning });
      } else {
        tick();
      }
    };
    // 刷新恢复时先调用后端接口登记/重建 streaming job，再连接 SSE。
    // 这样“已收到，马上处理”阶段刷新，即使原请求没来得及建 job，也不会直接 /events 404。
    if (saved.payload && cfg.baseUrl) await registerChatStreamJob(saved.payload, cfg, saved.id, { start: true });
    const data = await waitChatJob(saved.id, onJobUpdate);
    const final = extractChatJobText(data);
    const reply = final.content || '没有返回内容';
    const reasoning = final.reasoning || '';
    updateSessionDisplayItem(sessionId, liveItem, 'assistant', reply, { rawText: reply, pending: false });
    if (sessionId === state.activeSessionId) {
      const node = findMessageNodeByDisplayItem(liveItem);
      if (node) {
        updateMessage(node, reply, { rawText: reply });
        finishReasoning(node, reasoning);
      }
    }
    const baseMessages = [...(session.messages || [])];
    baseMessages.push({ role: 'assistant', content: reply });
    saveSessionMessages(sessionId, baseMessages);
    clearChatJob(sessionId);
    playDoneSound();
  } catch (err) {
    clearChatJob(sessionId);
    const message = isMissingJobError(err)
      ? '恢复任务不存在或已失效，已停止恢复，请重新发送'
      : (err?.message || String(err));
    if (isMissingJobError(err)) cleanupStalePendingDisplay(sessionId, /正在处理|正在思考|正在恢复聊天任务|已收到/, message);
    else showRunError(sessionId, err, liveItem, findMessageNodeByDisplayItem(liveItem));
    if (isMissingJobError(err) && sessionId === state.activeSessionId && !findMessageNodeByDisplayItem(liveItem)) addMessage('error', message, { rawText: message });
  } finally {
    clearInterval(timer);
    setSessionBusy(sessionId, false);
  }
}


function resumeSessionJobs(sessionId = state.activeSessionId) {
  if (!sessionId) return;
  const imageJob = loadImageJob(sessionId);
  const chatJob = loadChatJob(sessionId);
  if (imageJob) setTimeout(() => resumeImageJob(sessionId), 0);
  if (chatJob) setTimeout(() => resumeChatJob(sessionId), 0);
}

function formatElapsed(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min} 分 ${sec} 秒`;
}

function extractMathSegments(text) {
  const math = [];
  let out = '';
  let i = 0;
  const pushMath = (raw, displayMode) => {
    const token = `@@MATH${math.length}@@`;
    math.push({ raw, displayMode });
    out += token;
  };

  while (i < text.length) {
    if (text.startsWith('$$', i)) {
      const end = text.indexOf('$$', i + 2);
      if (end !== -1) {
        pushMath(text.slice(i + 2, end), true);
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith('\\[', i)) {
      const end = text.indexOf('\\]', i + 2);
      if (end !== -1) {
        pushMath(text.slice(i + 2, end), true);
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith('\\(', i)) {
      const end = text.indexOf('\\)', i + 2);
      if (end !== -1) {
        pushMath(text.slice(i + 2, end), false);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '$' && text[i + 1] !== '$') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '$' && text[j - 1] !== '\\') break;
        j++;
      }
      if (j < text.length && j > i + 1) {
        const raw = text.slice(i + 1, j);
        if (!/^\s*$/.test(raw)) {
          pushMath(raw, false);
          i = j + 1;
          continue;
        }
      }
    }
    out += text[i];
    i++;
  }
  return { text: out, math };
}

function restoreMathSegments(html, math) {
  return html.replace(/@@MATH(\d+)@@/g, (_, idx) => {
    const item = math[Number(idx)];
    if (!item) return '';
    try {
      if (!window.katex) throw new Error('KaTeX not loaded');
      return katex.renderToString(item.raw, {
        displayMode: item.displayMode,
        throwOnError: false,
        strict: false,
        trust: false,
        output: 'html',
      });
    } catch {
      return item.displayMode
        ? `<div class="math-fallback">${escapeHtml(item.raw)}</div>`
        : `<span class="math-fallback">${escapeHtml(item.raw)}</span>`;
    }
  });
}

function enhanceCodeBlocks(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('pre').forEach(pre => {
    if (pre.parentElement?.classList.contains('code-block')) return;
    const code = pre.querySelector('code');
    const raw = code?.textContent || pre.textContent || '';
    const langClass = [...(code?.classList || [])].find(c => c.startsWith('language-')) || '';
    const lang = langClass ? langClass.replace(/^language-/, '') : '';
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    if (lang) {
      const langEl = document.createElement('span');
      langEl.className = 'code-lang';
      langEl.textContent = lang;
      wrapper.appendChild(langEl);
    }
    const btn = document.createElement('button');
    btn.className = 'inline-copy code-copy-icon';
    btn.type = 'button';
    btn.title = '复制代码';
    btn.setAttribute('aria-label', '复制代码');
    btn.dataset.copyText = raw;
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 16H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    wrapper.appendChild(btn);
    pre.replaceWith(wrapper);
    wrapper.appendChild(pre);
  });
  return tpl.innerHTML;
}


function stripTrailingOrphanFence(source) {
  const lines = String(source || '').split('\n');
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last -= 1;
  if (last < 0) return source;
  const closing = lines[last].match(/^\s*(`{3,}|~{3,})\s*$/);
  if (!closing) return source;

  let inFence = false;
  let markerChar = '';
  let markerLen = 0;
  for (let i = 0; i < last; i += 1) {
    const match = lines[i].match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const fence = match[1];
    const char = fence[0];
    if (!inFence) {
      inFence = true;
      markerChar = char;
      markerLen = fence.length;
    } else if (char === markerChar && fence.length >= markerLen) {
      inFence = false;
      markerChar = '';
      markerLen = 0;
    }
  }
  // 如果到末尾这行之前并不处于代码块中，这个末尾 fence 只是孤立多余内容，直接移除。
  if (!inFence) {
    lines.splice(last, 1);
    return lines.join('\n').replace(/\n+$/, '');
  }
  return source;
}

function renderMarkdown(md) {
  const source = stripTrailingOrphanFence(String(md || ''));
  const { text, math } = extractMathSegments(source);

  if (window.marked?.parse) {
    try {
      marked.setOptions({
        gfm: true,
        breaks: true,
        mangle: false,
        headerIds: false,
      });
      return enhanceCodeBlocks(restoreMathSegments(marked.parse(text), math));
    } catch (err) {
      console.warn('marked render failed, fallback to legacy renderer', err);
    }
  }

  return enhanceCodeBlocks(restoreMathSegments(renderMarkdownLegacy(text), math));
}

function renderMarkdownLegacy(md) {

  const codeBlocks = [];
  let text = String(md || '').replace(/```([\w-]*)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const raw = code.replace(/\n$/, '');
    const token = `@@CODE${codeBlocks.length}@@`;
    codeBlocks.push({ lang: lang || '', raw });
    return token;
  });

  text = escapeHtml(text);
  text = renderTables(text);
  text = text
    .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([\s\S]*?)__/g, '<strong>$1</strong>')
    .replace(/~~([\s\S]*?)~~/g, '<del>$1</del>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" />')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  text = renderLists(text);
  text = text.split(/\n{2,}/).map(part => {
    if (/^\s*<(h\d|ul|ol|blockquote|pre|div|table|hr|img)/.test(part)) return part;
    return `<p>${part.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  codeBlocks.forEach((block, i) => {
    const lang = block.lang ? `<span class="code-lang">${escapeHtml(block.lang)}</span>` : '';
    const copyIcon = `<button class="inline-copy code-copy-icon" type="button" title="复制代码" aria-label="复制代码" data-copy-text="${escapeAttr(block.raw)}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 16H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>`;
    const html = `<div class="code-block">${lang}${copyIcon}<pre><code>${escapeHtml(block.raw)}</code></pre></div>`;
    text = text.replace(`@@CODE${i}@@`, html);
  });
  return text;
}

function renderTables(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const headers = splitTableRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      i--;
      const thead = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map(r => `<tr>${headers.map((_, idx) => `<td>${r[idx] || ''}</td>`).join('')}</tr>`).join('')}</tbody>`;
      out.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim());
}

function renderLists(text) {
  const lines = text.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;
  function closeList() {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }
  for (const line of lines) {
    const ul = line.match(/^\s*[-*]\s+(.+)/);
    const ol = line.match(/^\s*\d+\.\s+(.+)/);
    if (ul) {
      if (inOl) closeList();
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (inUl) closeList();
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${ol[1]}</li>`);
    } else {
      closeList();
      out.push(line);
    }
  }
  closeList();
  return out.join('\n');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/\n/g, '&#10;');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function buildRouteContext(limit = 8, sessionId = state.activeSessionId) {
  const session = state.sessions.find(item => item.id === sessionId);
  const messages = sessionId === state.activeSessionId ? state.messages : (session?.messages || []);
  const lastImage = sessionId === state.activeSessionId ? state.lastGeneratedImage : session?.lastGeneratedImage;
  const history = messages.slice(-limit).map((msg, idx) => ({
    index: idx + 1,
    role: msg.role,
    content: String(msg.content || '').slice(0, 600),
  }));
  return {
    recent_messages: history,
    last_generated_image: lastImage ? {
      prompt: String(lastImage.prompt || '').slice(0, 800),
      updated_at: lastImage.updatedAt || null,
    } : null,
  };
}

function normalizeRoute(route, fallbackMode = 'chat') {
  const mode = ['chat', 'image', 'edit_image'].includes(route?.mode) ? route.mode : fallbackMode;
  const target = ['none', 'new', 'uploaded', 'previous'].includes(route?.target)
    ? route.target
    : (mode === 'image' ? 'new' : 'none');
  const confidence = Number.isFinite(Number(route?.confidence)) ? Math.max(0, Math.min(1, Number(route.confidence))) : 0;
  const evidence = String(route?.evidence || '').trim();
  const wantsPrevious = !!route?.use_previous_image || !!route?.usePreviousImage;
  return {
    mode,
    target,
    evidence,
    usePreviousImage: mode === 'edit_image' && target === 'previous' && wantsPrevious && confidence >= 0.75 && evidence.length > 0,
    confidence,
  };
}

function parseRouteResult(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return normalizeRoute(JSON.parse(jsonText));
  } catch {}

  const legacy = text.toLowerCase();
  if (legacy === 'edit_image') return normalizeRoute({ mode: 'edit_image', target: 'previous', use_previous_image: false, confidence: 0.5, evidence: '' });
  if (legacy === 'image') return normalizeRoute({ mode: 'image', target: 'new', use_previous_image: false, confidence: 0.8 });
  if (legacy === 'chat') return normalizeRoute({ mode: 'chat', target: 'none', use_previous_image: false, confidence: 0.8 });
  return null;
}

async function getEffectiveRoute(prompt, attachments = state.attachments, sessionId = state.activeSessionId) {
  if (!state.autoMode) {
    return normalizeRoute({
      mode: state.mode,
      target: state.mode === 'image' ? 'new' : 'none',
      use_previous_image: false,
      confidence: 1,
    }, state.mode);
  }

  const cfg = getConfig();
  // 自动模式下统一交给聊天模型做结构化路由；上一张图只能作为候选上下文，不能自动触发编辑。
  if (cfg.baseUrl && cfg.chatModel) {
    try {
      const data = await requestJson(`${cfg.baseUrl}/chat/completions`, {
        model: cfg.chatModel,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `你是一个严格的意图路由分类器。根据用户当前输入的真实意图，判断后续应该调用聊天、新图生成，还是图片编辑。

必须只输出 JSON，不要输出解释或 Markdown。

返回格式：
{"mode":"chat|image|edit_image","target":"none|new|uploaded|previous","use_previous_image":false,"confidence":0.0,"evidence":""}

字段含义：
- mode=chat：自然语言回复、解释、总结、改写、代码、分析或普通对话。
- mode=image：用户想得到一张全新的视觉输出。
- mode=edit_image：用户想基于已上传图片或上一张生成图进行修改、调整、优化、替换、扩展或编辑。
- target=none：聊天，不涉及图片目标。
- target=new：新图生成。
- target=uploaded：基于用户本次上传的图片。
- target=previous：基于上一张生成图。

判断规则：
1. 你必须综合当前用户输入、最近多轮会话、上一张生成图的原始提示词，判断当前任务是否承接历史。
2. 最近会话只用于理解省略、指代和任务承接；不能因为历史里有图片任务，就默认当前任务要修改上一张图。
3. 连续多次生图请求不代表有关联。当前输入如果是完整的新主题/新画面要求，通常是 mode=image、target=new、use_previous_image=false。
4. 只有当当前输入结合最近会话后，明确表达要引用、继承、修改、保持或延续某张历史图片时，才允许 target=previous 且 use_previous_image=true。
5. 如果判为 use_previous_image=true，evidence 必须说明依据：摘录当前输入中的指代/修改表达，必要时再引用最近会话中被指代的图片任务。没有证据则 use_previous_image=false。
6. 用户本次上传图片，并且当前输入明确要求处理该图片时，判为 mode=edit_image、target=uploaded。
7. 如果不确定是否承接历史图片，必须优先判为 target=new 或 target=none，不要使用 previous。
8. 输出只允许 JSON。`,
          },
          {
            role: 'user',
            content: JSON.stringify({
              current_input: prompt,
              attachments: attachments.map(f => ({ name: f.name, type: f.type })),
              context: buildRouteContext(8, sessionId),
            }, null, 2),
          },
        ],
      }, cfg.apiKey);
      const raw = data?.choices?.[0]?.message?.content || data?.output_text || '';
      const route = parseRouteResult(raw);
      if (route) return route;
    } catch (err) {
      console.warn('model route failed, fallback to chat:', err);
    }
  }

  return normalizeRoute({ mode: 'chat', target: 'none', use_previous_image: false, confidence: 0 });
}


function updateModeUi(mode, auto = state.autoMode) {
  state.mode = mode;
  const promptEl = $('prompt');
  if (promptEl) promptEl.placeholder = '输入消息，Enter 发送，Shift+Enter 换行';
}

async function onSubmit(e) {
  e.preventDefault();
  if (isSessionBusy(state.activeSessionId)) return;
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  unlockDoneSound();
  saveConfig(true);

  const runSessionId = state.activeSessionId;
  const submittedAttachments = [...state.attachments];
  const displayIndex = state.mode === 'chat' ? state.messages.length : null;
  const editingCandidate = state.editingIndex !== null && state.editingNode && state.mode === 'chat';
  let editResult = null;
  if (editingCandidate) editResult = applyPendingEdit(prompt);
  if (!editResult) {
    addMessage('user', prompt + attachmentsSummaryMarkdown(submittedAttachments), { rawText: prompt, messageIndex: displayIndex });
    state.messages.push({ role: 'user', content: prompt });
  }
  saveChatHistory();
  $('prompt').value = '';
  clearAttachments();
  scheduleAutoResize();
  setSessionBusy(runSessionId, true);

  const session = getActiveSession();
  let liveItem = null;
  const immediateFeedback = addMessage('assistant', pendingFeedbackHtml('已收到，马上处理'), { html: true, rawText: '已收到，马上处理', skipSave: true });
  if (session) {
    liveItem = appendSessionDisplayMessage(runSessionId, 'assistant', pendingFeedbackHtml('已收到，马上处理'), { html: true, rawText: '已收到，马上处理', pending: true });
    immediateFeedback.__displayItem = liveItem;
  }
  let effectiveMode = state.mode;
  let effectiveRoute = normalizeRoute({ mode: state.mode, target: state.mode === 'image' ? 'new' : 'none', confidence: 1 }, state.mode);

  try {
    try {
      effectiveRoute = await getEffectiveRoute(prompt, submittedAttachments, runSessionId);
      effectiveMode = effectiveRoute.mode;
    } catch (routeErr) {
      effectiveMode = 'chat';
      effectiveRoute = normalizeRoute({ mode: 'chat', target: 'none', use_previous_image: false, confidence: 0 });
      console.warn('route failed, fallback to chat:', routeErr);
    }
    if (runSessionId === state.activeSessionId) updateModeUi(effectiveMode, state.autoMode);
    if (runSessionId === state.activeSessionId && warnMissingModel(effectiveMode, true)) {
      immediateFeedback.remove();
      return;
    }
    if (effectiveMode === 'chat') await sendChat(prompt, submittedAttachments, immediateFeedback, { sessionId: runSessionId, userAlreadyAdded: true, liveItem });
    else await sendImage(prompt, {
      loadingNode: immediateFeedback,
      editMode: effectiveMode === 'edit_image',
      editTarget: effectiveRoute.target,
      usePreviousImage: effectiveRoute.usePreviousImage,
      attachments: submittedAttachments,
      sessionId: runSessionId,
      userAlreadyAdded: true,
      liveItem,
    });
    state.editingIndex = null;
    state.editingNode = null;
  } catch (err) {
    showRunError(runSessionId, err, liveItem, immediateFeedback);
  } finally {
    setSessionBusy(runSessionId, false);
    $('prompt').focus();
  }
}

function closeAllCustomSelects(except = null) {
  document.querySelectorAll('.custom-select.open').forEach(el => {
    if (el !== except) el.classList.remove('open');
  });
}

function renderCustomSelectLabel(container, option) {
  if (!container) return;
  container.innerHTML = '';
  const main = document.createElement('span');
  main.className = 'custom-select-main-text';
  const isUnknown = option?.dataset?.unrecognized === '1';
  main.textContent = isUnknown ? (option.textContent || '').replace(/（未知类型）$/, '') : (option?.textContent || '请选择');
  container.appendChild(main);
  if (isUnknown) {
    const badge = document.createElement('span');
    badge.className = 'model-unrecognized-badge';
    badge.textContent = '未知类型';
    container.appendChild(badge);
  }
}

function updateCustomSelect(select) {
  const wrapper = select?.closest('.custom-select');
  const valueEl = wrapper?.querySelector('.custom-select-value');
  if (valueEl) renderCustomSelectLabel(valueEl, select?.selectedOptions?.[0]);
  wrapper?.querySelectorAll('.custom-select-option').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.value === select.value);
  });
}

function refreshCustomSelectOptions(select) {
  const wrapper = select?.closest('.custom-select');
  const menu = wrapper?.querySelector('.custom-select-menu');
  if (!wrapper || !menu) return;
  menu.innerHTML = '';
  [...select.options].forEach(opt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'custom-select-option';
    btn.dataset.value = opt.value;
    btn.dataset.unrecognized = opt.dataset.unrecognized || '0';
    btn.setAttribute('role', 'option');
    renderCustomSelectLabel(btn, opt);
    btn.addEventListener('click', () => {
      select.value = opt.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      updateCustomSelect(select);
      wrapper.classList.remove('open');
    });
    menu.appendChild(btn);
  });
  updateCustomSelect(select);
}

function enhanceConfigSelects() {
  ['chatModel', 'imageModel', 'imageSize'].forEach(id => {
    const select = $(id);
    if (!select || select.closest('.custom-select')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.innerHTML = '<span class="custom-select-value"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
    const menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    menu.setAttribute('role', 'listbox');
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextOpen = !wrapper.classList.contains('open');
      closeAllCustomSelects(wrapper);
      wrapper.classList.toggle('open', nextOpen);
    });
    select.addEventListener('change', () => updateCustomSelect(select));
    refreshCustomSelectOptions(select);
  });
}

function autoResize() {
  const el = $('prompt');
  const isMobile = window.matchMedia('(max-width: 640px)').matches;
  const maxHeight = Math.round(window.innerHeight * (isMobile ? 0.36 : 0.42));
  const minHeight = isMobile ? 42 : 52;
  el.style.setProperty('--prompt-height', `${minHeight}px`);
  el.style.setProperty('height', `${minHeight}px`, 'important');
  const nextHeight = Math.max(minHeight, Math.min(el.scrollHeight, maxHeight));
  el.style.setProperty('--prompt-height', `${nextHeight}px`);
  el.style.setProperty('height', `${nextHeight}px`, 'important');
  el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function scheduleAutoResize() {
  requestAnimationFrame(() => {
    autoResize();
    requestAnimationFrame(autoResize);
  });
}

['baseUrl', 'apiKey', 'chatModel', 'imageModel', 'imageSize'].forEach(id => {
  $(id).addEventListener('change', () => saveConfig(true));
});
$('saveConfigBtn').addEventListener('click', () => saveConfig(false));
$('loadModelsBtn').addEventListener('click', loadModels);
$('toggleApiKeyVisibility')?.addEventListener('click', toggleApiKeyVisibility);
async function clearChat() {
  state.messages = [];
  state.attachments = [];
  state.lastGeneratedImage = null;
  state.editingIndex = null;
  state.editingNode = null;

  // 只清理会话/图片/临时数据，保留 CONFIG_KEY 接口配置。
  const session = getActiveSession();
  session.messages = [];
  session.display = [];
  session.lastGeneratedImage = null;
  session.title = '新对话';
  session.updatedAt = Date.now();
  localStorage.removeItem(sessionStorageKey(CHAT_KEY));
  localStorage.removeItem(sessionStorageKey(UI_KEY));
  localStorage.removeItem(sessionStorageKey(LAST_IMAGE_KEY));
  saveSessionsMeta();
  await clearImageDb();
  clearAttachments();

  $('messages').innerHTML = `<div class="empty"><div class="empty-icon">💬</div><h3>新对话已开始</h3><p>输入消息，Enter 发送，Shift+Enter 换行</p></div>`;
}
$('newSessionBtn')?.addEventListener('click', newSession);
$('mobileSessionFloatBtn')?.addEventListener('click', openSessionDrawer);
$('railExpandBtn')?.addEventListener('click', () => setSessionSidebarCollapsed(false));
$('railChatBtn')?.addEventListener('click', () => setSessionSidebarCollapsed(false));
$('railNewSessionBtn')?.addEventListener('click', newSession);
$('railConfigBtn')?.addEventListener('click', openConfigModal);
$('collapseSessionsBtn')?.addEventListener('click', () => {
  if (window.matchMedia('(max-width: 840px)').matches) {
    closeSessionDrawer();
    openConfigModal();
    return;
  }
  setSessionSidebarCollapsed(!document.body.classList.contains('session-sidebar-collapsed'));
});
$('sessionDrawerMask')?.addEventListener('click', closeSessionDrawer);
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('reasoningToggle')?.addEventListener('click', () => setReasoningPersist(!state.reasoningPersist));
$('fileInput').addEventListener('change', async (e) => {
  await addFiles([...e.target.files]);
  e.target.value = '';
});
$('composer').addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) await addFiles(files);
});
$('composer').addEventListener('submit', onSubmit);
$('prompt').addEventListener('input', scheduleAutoResize);
$('prompt').addEventListener('keyup', scheduleAutoResize);
$('prompt').addEventListener('paste', scheduleAutoResize);
$('prompt').addEventListener('compositionend', scheduleAutoResize);
function scrollPromptByWheel(e) {
  const el = $('prompt');
  if (!el || el.scrollHeight <= el.clientHeight) return;
  const before = el.scrollTop;
  el.scrollTop += e.deltaY;
  if (el.scrollTop !== before) {
    e.preventDefault();
    e.stopPropagation();
  }
}
$('prompt').addEventListener('wheel', scrollPromptByWheel, { passive: false });
document.querySelector('.input-stack')?.addEventListener('wheel', scrollPromptByWheel, { passive: false });
$('messages')?.addEventListener('scroll', updateAutoScrollLock, { passive: true });
$('messages')?.addEventListener('touchstart', markManualMessageScroll, { passive: true });
$('messages')?.addEventListener('touchmove', markManualMessageScroll, { passive: true });
$('messages')?.addEventListener('wheel', markManualMessageScroll, { passive: true });
window.visualViewport?.addEventListener('resize', () => scrollToBottom(false));
window.addEventListener('resize', scheduleAutoResize);
scheduleAutoResize();
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});


function openConfigModal() {
  document.body.classList.add('modal-open');
  $('configModal').classList.add('show');
  $('configModal').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('baseUrl')?.focus(), 0);
}

function closeConfigModal() {
  document.body.classList.remove('modal-open');
  $('configModal').classList.remove('show');
  $('configModal').setAttribute('aria-hidden', 'true');
}

$('imagePreviewClose').addEventListener('click', closeImagePreview);
$('imagePreview').addEventListener('click', (e) => { if (e.target.id === 'imagePreview' || e.target.classList.contains('image-preview-mask')) closeImagePreview(); });
$('sidebarConfigBtn')?.addEventListener('click', openConfigModal);
$('closeConfigBtn').addEventListener('click', closeConfigModal);
document.querySelectorAll('[data-close-modal]').forEach(el => el.addEventListener('click', closeConfigModal));
document.addEventListener('click', () => closeAllCustomSelects());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeAllCustomSelects(); closeConfigModal(); closeImagePreview(); }
});

enhanceConfigSelects();
loadConfig();
loadReasoningPreference();
loadSessions();
loadSessionSidebarCollapsed();
loadLastGeneratedImage();
renderActiveSession();
updateSendAvailability();
updateModeUi(state.mode, state.autoMode);
requestAnimationFrame(() => document.body.classList.remove('app-booting'));

window.addEventListener('beforeunload', () => { state.pageUnloading = true; });
window.addEventListener('pagehide', () => { state.pageUnloading = true; });
