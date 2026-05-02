const $ = (id) => document.getElementById(id);

const state = {
  mode: 'chat',
  messages: [],
  busy: false,
  models: [],
  editingIndex: null,
  editingNode: null,
  attachments: [],
  lastGeneratedImage: null,
  autoMode: true,
  reasoningPersist: false,
};

const CONFIG_KEY = 'openapi-chat-image-config-v2';
const CHAT_KEY = 'openapi-chat-image-chat-v1';
const UI_KEY = 'openapi-chat-image-ui-v1';
const LAST_IMAGE_KEY = 'openapi-chat-image-last-image-v1';
const REASONING_PERSIST_KEY = 'openapi-chat-reasoning-persist-v1';
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

  if (directMode || !baseUrl) throw new Error('图片地址无法直接加载，请关闭直连模式后重试，或使用返回 base64 图片的接口');
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
  directMode: true,
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

function loadConfig() {
  const saved = readJsonStorage(CONFIG_KEY, readJsonStorage('openapi-chat-image-config', {}));
  const cfg = { ...defaults, ...saved };
  $('baseUrl').value = cfg.baseUrl || '';
  $('apiKey').value = cfg.apiKey || '';
  $('imageSize').value = cfg.imageSize || defaults.imageSize;
  $('directMode').checked = cfg.directMode !== false;
  state.models = Array.isArray(cfg.models) ? cfg.models : [];
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
    directMode: $('directMode').checked,
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
    directMode: cfg.directMode,
    models: Array.isArray(state.models) ? state.models : [],
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


function iconChat() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 6.5h13v8.2a2.8 2.8 0 0 1-2.8 2.8H10l-4.5 3v-3H5.2a2.7 2.7 0 0 1-2.7-2.7V9.5a3 3 0 0 1 3-3Z"/><path d="M7.5 10h9M7.5 13.5h6"/></svg>`;
}

function iconImage() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.4"/><path d="m5.8 16 4.1-4.2 3.1 3.1 2.1-2.2 3.2 3.3"/></svg>`;
}

function setMode(mode, { manual = false } = {}) {
  state.mode = mode;
  if (manual) state.autoMode = false;
  updateModeUi(mode, state.autoMode);
  saveConfig(true);
  warnMissingModel(mode, true);
}


function clearEmpty() {
  const empty = document.querySelector('.empty');
  if (empty) empty.remove();
}

let scrollTimer = null;
function scrollToBottom(force = true) {
  const el = $('messages');
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 260;
  if (!force && !nearBottom) return;

  const isMobile = window.matchMedia('(max-width: 640px)').matches;
  const apply = () => {
    // 移动端只滚动消息容器，不滚 body/documentElement，避免键盘弹出时页面闪动。
    el.scrollTop = el.scrollHeight;
    if (!isMobile) {
      document.documentElement.scrollTop = document.documentElement.scrollHeight;
      document.body.scrollTop = document.body.scrollHeight;
    }
  };

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
    const btn = node.querySelector('.copy-btn');
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 900);
  });

  node.querySelectorAll('[data-copy-text]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await copyText(btn.dataset.copyText || '');
      const oldText = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => btn.textContent = oldText, 1000);
    });
  });
  hydrateMessageMedia(node, { save: !options.skipSave });

  $('messages').appendChild(node);
  scrollToBottom(true);
  if (!options.skipSave && !options.deferSave) saveDisplayHistory();
  return node;
}

function updateMessage(node, content, options = {}) {
  const box = node.querySelector('.content');
  node.dataset.rawText = options.rawText ?? content;
  if (options.skipSave) node.dataset.persist = '0';
  else delete node.dataset.persist;
  if (options.html) box.innerHTML = content;
  else box.innerHTML = renderMarkdown(String(content || ''));
  node.querySelectorAll('[data-copy-text]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await copyText(btn.dataset.copyText || '');
      const oldText = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => btn.textContent = oldText, 1000);
    });
  });
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
  scrollToBottom(false);
  if (options.persistSave && node.isConnected) saveDisplayHistory();
}

function finishReasoning(node, text) {
  const contentText = String(text || '').trim();
  if (contentText) updateReasoning(node, contentText, { done: true, persistSave: state.reasoningPersist, keepReasoning: state.reasoningPersist });
  else updateReasoning(node, '', { keepEmpty: true, done: true });
  if (!state.reasoningPersist) setTimeout(() => clearReasoning(node), 2000);
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
  const idx = Number(node.dataset.messageIndex);
  if (!Number.isFinite(idx)) return;
  const text = node.dataset.rawText || '';

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
  if (state.editingIndex === null || !state.editingNode) return false;
  const idx = state.editingIndex;
  const node = state.editingNode;

  // 发送时再清理：替换当前用户消息，删除它后面的旧回复/旧分支，并回退上下文。
  state.messages = state.messages.slice(0, idx);
  node.dataset.rawText = newText;
  const box = node.querySelector('.content');
  box.innerHTML = renderMarkdown(newText);

  let current = node.nextElementSibling;
  while (current) {
    const next = current.nextElementSibling;
    current.remove();
    current = next;
  }

  node.classList.remove('editing');
  state.editingIndex = null;
  state.editingNode = null;
  delete $('prompt').dataset.editing;
  return true;
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
  if (state.busy) return;
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
  if (hadGeneratedImage && node.dataset.imageContext) {
    try { imageContext = JSON.parse(node.dataset.imageContext); } catch {}
  }

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

  state.busy = true;
  $('sendBtn').disabled = true;
  try {
    const restoredAttachments = hadGeneratedImage ? await restoreImageAttachmentsFromContext(imageContext) : [];
    const route = hadGeneratedImage
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
    if (warnMissingModel(mode, true)) return;
    if (mode === 'chat') await sendChat(prompt, []);
    else await sendImage(prompt, {
      editMode: mode === 'edit_image',
      editTarget: route.target,
      usePreviousImage: false,
      attachments: restoredAttachments,
      imageContext,
    });
  } catch (err) {
    addMessage('error', err.message || String(err), { rawText: err.message || String(err) });
  } finally {
    state.busy = false;
    $('sendBtn').disabled = false;
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
  const res = await fetch(finalUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(direct && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(finalPayload) }),
  });
  const data = await parseResponseJson(res);
  if (!res.ok) throw new Error(normalizeError(null, data));
  return data;
}

async function requestModels() {
  const cfg = getConfig();
  if (!cfg.baseUrl) throw new Error('请先配置 Endpoint Base URL');

  if (cfg.directMode) {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    });
    const data = await parseResponseJson(res);
    if (!res.ok) throw new Error(normalizeError(null, data));
    return data;
  }

  const res = await fetch('/api/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, payload: {}, method: 'GET' }),
  });
  const data = await parseResponseJson(res);
  if (!res.ok) throw new Error(normalizeError(null, data));
  return data;
}

function extractModels(data) {
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return arr.map(item => typeof item === 'string' ? item : item.id || item.name).filter(Boolean).sort();
}

function setSelectValue(select, value) {
  const hasValue = [...select.options].some(opt => opt.value === value);
  select.value = hasValue ? value : '';
}

function renderModelOptions(chatValue = $('chatModel')?.value || '', imageValue = $('imageModel')?.value || '') {
  const models = [...new Set(state.models)].filter(Boolean);
  const html = `<option value="">请选择模型</option>` + models.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
  $('chatModel').innerHTML = html;
  $('imageModel').innerHTML = html;
  setSelectValue($('chatModel'), chatValue);
  setSelectValue($('imageModel'), imageValue);
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
    const models = extractModels(data);
    if (!models.length) throw new Error('未从 /models 返回中识别到模型列表');
    state.models = models;
    renderModelOptions($('chatModel').value, $('imageModel').value);
    saveConfig(true);
    status.textContent = `已加载 ${models.length} 个`;
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

async function getPreviousImageAsAttachment() {
  const img = state.lastGeneratedImage;
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

function shouldEditPreviousImage(prompt) {
  if (!state.lastGeneratedImage) return false;
  if (state.attachments.some(f => isImageFile(f))) return false;
  return /(修改|改成|调整|优化|换成|替换|去掉|加上|增加|保持|基于|上一张|这张|刚才|不要重画|edit|modify|change|replace|remove|add|based on|previous)/i.test(prompt);
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

function buildChatMessagesWithAttachments(prompt, attachments = state.attachments) {
  if (!attachments.length) return [...state.messages, { role: 'user', content: prompt }];

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
  return [...state.messages, { role: 'user', content: parts }];
}

function attachmentsSummaryMarkdown(attachments = state.attachments) {
  if (!attachments.length) return '';
  return '\n\n' + attachments.map(f => `📎 ${f.name}`).join('\n');
}

async function requestMultipart(url, fields, files, apiKey) {
  const cfg = getConfig();
  if (!cfg.directMode) throw new Error('带附件生图需要直连模式，或后续扩展本地代理 multipart 转发');
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
  try { localStorage.setItem(UI_KEY, JSON.stringify(items)); } catch (err) { console.warn('save display history failed', err); }
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
    const items = readJsonStorage(UI_KEY, []);
    if (!Array.isArray(items) || !items.length) return false;
    $('messages').innerHTML = '';
    items.forEach(item => {
      if (item.html) item.html = normalizePersistedHtml(item.html);
      addMessage(item.role || 'assistant', item.html || item.rawText || '', {
        html: !!item.html,
        rawText: item.rawText || '',
        messageIndex: item.messageIndex !== '' ? Number(item.messageIndex) : null,
        skipSave: false,
        deferSave: true,
      });
      const node = $('messages').lastElementChild;
      if (item.imageContext && node) node.dataset.imageContext = item.imageContext;
      if (item.reasoningText && node) updateReasoning(node, item.reasoningText, { done: true, keepReasoning: item.keepReasoning !== false });
    });
    hydrateMessageMedia($('messages'), { save: false });
    return true;
  } catch {
    localStorage.removeItem(UI_KEY);
    return false;
  }
}

function saveLastGeneratedImage() {
  try {
    if (state.lastGeneratedImage) localStorage.setItem(LAST_IMAGE_KEY, JSON.stringify(state.lastGeneratedImage));
  } catch {}
}

function loadLastGeneratedImage() {
  try {
    state.lastGeneratedImage = readJsonStorage(LAST_IMAGE_KEY, null);
  } catch {
    localStorage.removeItem(LAST_IMAGE_KEY);
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
  state.reasoningPersist = localStorage.getItem(REASONING_PERSIST_KEY) === '1';
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
  localStorage.setItem(CHAT_KEY, JSON.stringify(safeMessages));
}

function loadChatHistory({ render = false } = {}) {
  try {
    const saved = readJsonStorage(CHAT_KEY, []);
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
    localStorage.removeItem(CHAT_KEY);
  }
}

async function sendChat(prompt, attachments = state.attachments) {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.chatModel) throw new Error('请先配置 Endpoint Base URL 和聊天模型');

  const userIndex = state.messages.length;
  const requestMessages = buildChatMessagesWithAttachments(prompt, attachments);
  state.messages.push({ role: 'user', content: prompt });
  saveChatHistory();
  const loading = addMessage('assistant', '正在发送…', { rawText: '正在发送…' });

  const payload = {
    model: cfg.chatModel,
    messages: requestMessages,
    temperature: 0.7,
    stream: true,
  };

  try {
    const renderer = createRealtimeRenderer((visible) => {
      updateMessage(loading, visible || '正在发送…', { rawText: visible || '正在发送…' });
    });
    const reasoningRenderer = createRealtimeRenderer((visible) => {
      updateReasoning(loading, visible || '');
    });
    updateReasoning(loading, '', { keepEmpty: true });
    const result = await streamChatCompletions(`${cfg.baseUrl}/chat/completions`, payload, cfg.apiKey, (partial) => {
      renderer.set(partial.content || '');
      reasoningRenderer.set(partial.reasoning || '');
    });
    const finalReply = result.content || '没有返回内容';
    renderer.flush(finalReply);
    reasoningRenderer.cancel();
    state.messages.push({ role: 'assistant', content: finalReply });
    saveChatHistory();
    updateMessage(loading, finalReply, { rawText: finalReply });
    finishReasoning(loading, result.reasoning || '');
    playDoneSound();
  } catch (err) {
    // 少数 OpenAI 兼容端点不支持 stream=true，自动降级成普通请求。
    const fallbackPayload = {
      model: cfg.chatModel,
      messages: requestMessages,
      temperature: 0.7,
    };
    const data = await requestJson(`${cfg.baseUrl}/chat/completions`, fallbackPayload, cfg.apiKey);
    const reply = data?.choices?.[0]?.message?.content || data?.output_text || `流式失败，且普通请求没有返回内容：${err.message || err}`;
    state.messages.push({ role: 'assistant', content: reply });
    saveChatHistory();
    updateMessage(loading, reply, { rawText: reply });
    finishReasoning(loading, data?.choices?.[0]?.message?.reasoning_content || data?.choices?.[0]?.message?.reasoning || data?.reasoning_content || data?.reasoning || '');
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

async function streamChatCompletions(url, payload, apiKey, onDelta) {
  const cfg = getConfig();
  const direct = cfg.directMode;
  const finalUrl = direct ? url : toProxyUrl(url, cfg.baseUrl);
  const finalPayload = direct ? payload : { baseUrl: cfg.baseUrl, apiKey, payload };

  const res = await fetch(finalUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(direct && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(finalPayload),
  });

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
  state.lastGeneratedImage = { src: persistedSrc, filename, prompt: meta.prompt || '', updatedAt: Date.now() };
  saveLastGeneratedImage();
  return {
    raw: url || '[base64 image]',
    html: `<div class="image-result-head"><span>${elapsedText ? `生成完成，耗时：${escapeHtml(elapsedText)}` : '生成完成'}</span></div><img class="generated-thumb" src="${escapeHtml(displaySrc)}" data-persisted-src="${escapeHtml(persistedSrc)}" data-filename="${escapeHtml(filename)}" alt="generated image" /><div class="image-download-row">${imageActionButtonsHtml(persistedSrc, filename)}${url ? `<a class="image-icon-btn" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="打开原图" aria-label="打开原图"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"/></svg></a>` : ''}</div>`,
  };
}

async function sendImage(prompt, options = {}) {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.imageModel) throw new Error('请先配置 Endpoint Base URL 和生图模型');

  let requestStart = 0;
  let timer = null;
  const loading = addMessage('assistant', '正在发送生图请求…', { rawText: '正在发送生图请求…', skipSave: true });

  const startImageTimer = (label = '正在生成图片') => {
    requestStart = performance.now();
    updateMessage(loading, `${label}… 已等待 0 秒`, { rawText: `${label}… 已等待 0 秒`, skipSave: true });
    timer = setInterval(() => {
      const seconds = Math.floor((performance.now() - requestStart) / 1000);
      updateMessage(loading, `${label}… 已等待 ${seconds} 秒`, { rawText: `${label}… 已等待 ${seconds} 秒`, skipSave: true });
    }, 1000);
  };

  const payload = { model: cfg.imageModel, prompt, n: 1 };
  if (cfg.imageSize && cfg.imageSize !== 'auto') payload.size = cfg.imageSize;

  try {
    const attachments = options.attachments || state.attachments;
    let imageRefs = attachments.filter(f => isImageFile(f));
    let usedPreviousImage = false;
    if (!imageRefs.length && options.usePreviousImage) {
      const previous = await getPreviousImageAsAttachment();
      if (!previous) throw new Error('没有可编辑的上一张图片');
      imageRefs = [previous];
      usedPreviousImage = true;
      updateMessage(loading, '已准备上一张图片，正在发送修改请求…', { rawText: '已准备上一张图片，正在发送修改请求…', skipSave: true });
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
    setImageContext(loading, imageContext);
    startImageTimer(imageRefs.length ? '正在修改图片' : '正在生成图片');
    const data = imageRefs.length
      ? await requestMultipart(`${cfg.baseUrl}/images/edits`, payload, imageRefs, cfg.apiKey)
      : await requestJson(`${cfg.baseUrl}/images/generations`, payload, cfg.apiKey);
    const elapsedText = formatElapsed(performance.now() - requestStart);
    const result = await imageResultToHtml(data, elapsedText, { prompt });
    if (usedPreviousImage || imageContext.mode === 'edit_image') result.html = result.html.replace('生成完成', usedPreviousImage ? '基于上一张图修改完成' : '图片修改完成');
    updateMessage(loading, result.html, { html: true, rawText: `${result.raw}\n耗时：${elapsedText}` });
    setImageContext(loading, imageContext);
    state.messages.push({ role: 'user', content: prompt });
    state.messages.push({ role: 'assistant', content: usedPreviousImage ? `[图片编辑完成] ${prompt}` : `[图片生成完成] ${prompt}` });
    saveChatHistory();
    playDoneSound();
  } finally {
    if (timer) clearInterval(timer);
  }
}

function formatElapsed(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min} 分 ${sec} 秒`;
}

function renderMarkdown(md) {
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
    .replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    .replace(/~~(.*?)~~/g, '<del>$1</del>')
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
    const html = `<div class="code-block"><div class="block-toolbar">${lang}<button class="inline-copy" type="button" data-copy-text="${escapeAttr(block.raw)}">复制代码</button></div><pre><code>${escapeHtml(block.raw)}</code></pre></div>`;
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

function buildRouteContext(limit = 8) {
  const history = state.messages.slice(-limit).map((msg, idx) => ({
    index: idx + 1,
    role: msg.role,
    content: String(msg.content || '').slice(0, 600),
  }));
  return {
    recent_messages: history,
    last_generated_image: state.lastGeneratedImage ? {
      prompt: String(state.lastGeneratedImage.prompt || '').slice(0, 800),
      updated_at: state.lastGeneratedImage.updatedAt || null,
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

async function getEffectiveRoute(prompt, attachments = state.attachments) {
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
              context: buildRouteContext(8),
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
  $('modeTitle').textContent = mode === 'chat' ? '极简聊天工具' : '生图';
  const modeBtn = $('modeSwitchBtn');
  if (modeBtn) {
    modeBtn.innerHTML = mode === 'chat' ? iconChat() : iconImage();
    modeBtn.title = auto
      ? '自动识别模式：点击可手动切换当前模式'
      : (mode === 'chat' ? '当前：聊天，点击切换生图' : '当前：生图，点击切换聊天');
    modeBtn.setAttribute('aria-label', modeBtn.title);
    modeBtn.classList.toggle('image-mode', mode === 'image');
  }
  $('modeDesc').textContent = auto
    ? '可配置兼容 OpenAPI 的第三方供应商，支持聊天和生图'
    : (mode === 'chat' ? '微信式左右气泡，支持 Markdown、复制和模型选择。' : '输入图片提示词，调用图片接口，图片可下载/预览/继续修改。');
  $('prompt').placeholder = auto
    ? '输入消息；我会自动判断聊天还是生图'
    : (mode === 'chat' ? '输入消息，Enter 发送，Shift+Enter 换行' : '描述你要生成/修改的图片，Enter 发送');
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.busy) return;
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  unlockDoneSound();
  saveConfig(true);

  const submittedAttachments = [...state.attachments];
  const displayIndex = state.mode === 'chat' ? state.messages.length : null;
  const editingCandidate = !state.autoMode && state.mode === 'chat';
  let editingApplied = false;
  if (editingCandidate) editingApplied = applyPendingEdit(prompt);
  if (!editingApplied) {
    addMessage('user', prompt + attachmentsSummaryMarkdown(submittedAttachments), { rawText: prompt, messageIndex: displayIndex });
  }
  $('prompt').value = '';
  clearAttachments();
  scheduleAutoResize();
  state.busy = true;
  $('sendBtn').disabled = true;

  let effectiveMode = state.mode;
  let effectiveRoute = normalizeRoute({ mode: state.mode, target: state.mode === 'image' ? 'new' : 'none', confidence: 1 }, state.mode);

  try {
    try {
      effectiveRoute = await getEffectiveRoute(prompt, submittedAttachments);
      effectiveMode = effectiveRoute.mode;
    } catch (routeErr) {
      effectiveMode = 'chat';
      effectiveRoute = normalizeRoute({ mode: 'chat', target: 'none', use_previous_image: false, confidence: 0 });
      console.warn('route failed, fallback to chat:', routeErr);
    }
    updateModeUi(effectiveMode, state.autoMode);
    if (warnMissingModel(effectiveMode, true)) {
      return;
    }
    // 如果模型判断为聊天，但刚才没有应用编辑状态，这里补一次编辑处理。
    if (effectiveMode === 'chat' && state.editingIndex !== null && state.editingNode) {
      applyPendingEdit(prompt);
    }

    if (effectiveMode === 'chat') await sendChat(prompt, submittedAttachments);
    else await sendImage(prompt, {
      editMode: effectiveMode === 'edit_image',
      editTarget: effectiveRoute.target,
      usePreviousImage: effectiveRoute.usePreviousImage,
      attachments: submittedAttachments,
    });
    state.editingIndex = null;
    state.editingNode = null;
  } catch (err) {
    addMessage('error', err.message || String(err), { rawText: err.message || String(err) });
  } finally {
    state.busy = false;
    $('sendBtn').disabled = false;
    $('prompt').focus();
  }
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

['baseUrl', 'apiKey', 'chatModel', 'imageModel', 'imageSize', 'directMode'].forEach(id => {
  $(id).addEventListener('change', () => saveConfig(true));
});
$('saveConfigBtn').addEventListener('click', () => saveConfig(false));
$('loadModelsBtn').addEventListener('click', loadModels);
async function clearChat() {
  state.messages = [];
  state.attachments = [];
  state.lastGeneratedImage = null;
  state.editingIndex = null;
  state.editingNode = null;

  // 只清理会话/图片/临时数据，保留 CONFIG_KEY 接口配置。
  localStorage.removeItem(CHAT_KEY);
  localStorage.removeItem(UI_KEY);
  localStorage.removeItem(LAST_IMAGE_KEY);
  await clearImageDb();
  clearAttachments();

  $('messages').innerHTML = `<div class="empty"><div class="empty-icon">💬</div><h3>新对话已开始</h3><p>继续输入你的问题；我会自动判断聊天还是生图。</p></div>`;
}
$('clearBtn').addEventListener('click', () => clearChat().catch(console.error));
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
window.addEventListener('resize', scheduleAutoResize);
scheduleAutoResize();
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});


function openConfigModal() {
  $('configModal').classList.add('show');
  $('configModal').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('baseUrl')?.focus(), 0);
}

function closeConfigModal() {
  $('configModal').classList.remove('show');
  $('configModal').setAttribute('aria-hidden', 'true');
}

$('imagePreviewClose').addEventListener('click', closeImagePreview);
$('imagePreview').addEventListener('click', (e) => { if (e.target.id === 'imagePreview' || e.target.classList.contains('image-preview-mask')) closeImagePreview(); });
$('configBtn').addEventListener('click', openConfigModal);
$('closeConfigBtn').addEventListener('click', closeConfigModal);
document.querySelectorAll('[data-close-modal]').forEach(el => el.addEventListener('click', closeConfigModal));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeConfigModal(); closeImagePreview(); }
});

loadConfig();
loadReasoningPreference();
loadLastGeneratedImage();
loadChatHistory({ render: false });
if (!loadDisplayHistory()) loadChatHistory({ render: true });
updateModeUi(state.mode, state.autoMode);
requestAnimationFrame(() => document.body.classList.remove('app-booting'));
