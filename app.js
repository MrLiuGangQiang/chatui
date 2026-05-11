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
  reasoningMode: false,
  reasoningType: 'medium',
  reasoningProvider: 'auto',
  reasoningPersist: true,
  pageUnloading: false,
  resumingJobs: new Set(),
  followingChatJobs: new Set(),
  autoScrollLocked: true,
  activeOutputNode: null,
  scrollVersion: 0,
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
const REASONING_MODE_KEY = 'openapi-chat-reasoning-mode-v1';
const REASONING_TYPE_KEY = 'openapi-chat-reasoning-type-v1';
const REASONING_PROVIDER_KEY = 'openapi-chat-reasoning-provider-v1';
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


function setDisplayedVersion(version) {
  const clean = String(version || '').trim();
  if (!clean) return;
  const label = clean.startsWith('v') ? clean : `v${clean}`;
  document.querySelectorAll('[data-app-version]').forEach(node => {
    node.textContent = label;
  });
  const railBtn = $('railConfigBtn');
  if (railBtn) {
    railBtn.title = `模型配置 · ${label}`;
    railBtn.setAttribute('aria-label', `模型配置，当前版本 ${label}`);
  }
}

async function loadAppVersion() {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setDisplayedVersion(data.version);
  } catch {
    setDisplayedVersion('1.1.1');
  }
}

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
  systemPrompt: '',
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
  btn.classList.toggle('visible', visible);
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
  $('systemPrompt').value = cfg.systemPrompt || '';
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
    systemPrompt: $('systemPrompt')?.value.trim() || '',
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
    systemPrompt: cfg.systemPrompt,
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
  document.querySelector('.empty')?.remove();
  document.querySelector('.empty-welcome')?.remove();
}

function renderEmptyWelcome() {
  const messages = $('messages');
  if (!messages) return;
  const old = messages.querySelector('.empty-welcome');
  if (old) old.remove();
  if (messages.children.length) return;
  const text = 'ChatUI极简聊天工具';
  const spans = [...text].map(c => `<span class="wc">${c}</span>`).join('');
  messages.innerHTML = `<div class="empty-welcome" aria-hidden="true"><div class="welcome-title">${spans}</div><div class="welcome-sub">专注对话 · 智能思考 · 灵感生图 · 高效创作</div><div class="welcome-note">本项目全程使用 OpenClaw 托管开发 · 人为编码量 0</div></div>`;
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

function getComposerSafeBottom() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--composer-safe-bottom');
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : 168;
}

function scrollToBottom(force = true) {
  const el = $('messages');
  if (!el) return;
  if (!force && !state.autoScrollLocked && !isNearMessagesBottom(220)) return;

  const isMobile = window.matchMedia('(max-width: 640px)').matches;
  const apply = () => {
    // .messages 是唯一主滚动容器；移动端不要滚 window，避免抢手势和键盘抖动。
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight + getComposerSafeBottom());
    if (!isMobile) {
      const doc = document.scrollingElement || document.documentElement;
      doc.scrollTop = doc.scrollHeight;
      document.documentElement.scrollTop = document.documentElement.scrollHeight;
      document.body.scrollTop = document.body.scrollHeight;
    }
  };

  state.autoScrollLocked = true;
  const token = ++state.scrollVersion;
  apply();
  requestAnimationFrame(() => { if (state.scrollVersion === token) apply(); });

  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => { if (state.scrollVersion === token) apply(); }, isMobile ? 80 : 160);
}

function scrollToActiveOutput(node, options = {}) {
  const el = $('messages');
  if (!el || !node?.isConnected) return;
  const isActiveOutput = state.activeOutputNode === node;
  if (!options.force && !isActiveOutput && !state.autoScrollLocked && !isNearMessagesBottom(220)) return;

  const isMobile = window.matchMedia('(max-width: 640px)').matches;
  const margin = Number.isFinite(options.margin) ? options.margin : 24;
  const apply = () => {
    const nodeRect = node.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const nodeBottom = el.scrollTop + (nodeRect.bottom - elRect.top);
    const targetBottom = Math.min(el.scrollHeight, nodeBottom + margin);
    const safeBottom = getComposerSafeBottom();
    const visibleHeight = Math.max(120, el.clientHeight - safeBottom);
    // 自动跟随时锚定正在输出的消息底部，并预留固定输入框安全区；
    // 否则流式输出会贴到容器底部，被 composer 盖住。
    el.scrollTop = Math.max(0, targetBottom - visibleHeight);
    if (!isMobile) {
      const doc = document.scrollingElement || document.documentElement;
      doc.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }
  };

  if (options.active) state.activeOutputNode = node;
  state.autoScrollLocked = true;
  const token = ++state.scrollVersion;
  apply();
  if (options.settle !== false) {
    requestAnimationFrame(() => { if (state.scrollVersion === token) apply(); });

    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { if (state.scrollVersion === token) apply(); }, isMobile ? 80 : 160);
  } else {
    // 最终完成态不再允许流式阶段遗留的 RAF/timer 二次补滚。
    state.scrollVersion += 1;
    clearTimeout(scrollTimer);
  }
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
  if (options.responseIndex !== undefined && options.responseIndex !== null) node.dataset.responseIndex = String(options.responseIndex);

  if (options.html) box.innerHTML = content;
  else box.innerHTML = renderMarkdown(String(content || ''));

  const editBtn = node.querySelector('.edit-btn');
  if (role === 'user') {
    editBtn.addEventListener('click', () => editUserMessage(node));
  } else {
    editBtn.remove();
  }

  const refreshBtn = node.querySelector('.refresh-btn');
  if (role === 'assistant' || role === 'error') {
    refreshBtn.addEventListener('click', () => regenerateAssistantMessage(node));
  } else {
    refreshBtn.remove();
  }

  node.querySelector('.copy-btn')?.addEventListener('click', async () => {
    await copyText(node.dataset.rawText || box.innerText);
    showCopySuccess(node.querySelector('.copy-btn'));
  });

  const downloadBtn = node.querySelector('.download-answer-btn');
  if (role === 'assistant') {
    downloadBtn?.addEventListener('click', () => downloadAnswerFile(node));
  } else {
    downloadBtn?.remove();
  }

  bindInlineCopyButtons(node);
  hydrateMessageMedia(node, { save: !options.skipSave });

  $('messages').appendChild(node);
  scrollToBottom(true);
  if (!options.skipSave && !options.deferSave) saveDisplayHistory();
  return node;
}

const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7.5A2.5 2.5 0 0 1 11.5 5h5A2.5 2.5 0 0 1 19 7.5v7A2.5 2.5 0 0 1 16.5 17h-5A2.5 2.5 0 0 1 9 14.5z"></path><path d="M7 19h5.5A2.5 2.5 0 0 0 15 16.5V16"></path><path d="M7 19A2.5 2.5 0 0 1 4.5 16.5v-7A2.5 2.5 0 0 1 7 7h5.5"></path></svg>';
const COPY_SUCCESS_ICON_SVG = '<svg class="copy-success-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>';

function safeFilenamePart(text = '') {
  return String(text || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32) || 'assistant-answer';
}

function downloadTextFile(text, filename, type = 'text/markdown;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function downloadAnswerFile(node) {
  const text = String(node?.dataset.rawText || node?.querySelector('.content')?.innerText || '').trim();
  if (!text) {
    toast('暂无可下载的回答内容');
    return;
  }
  const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const title = safeFilenamePart(text.split('\n').find(Boolean) || 'assistant-answer');
  downloadTextFile(text.endsWith('\n') ? text : `${text}\n`, `${date}-${title}.md`);
}

function showCopySuccess(btn) {
  if (!btn) return;
  const oldHtml = btn.innerHTML;
  btn.classList.add('copied');
  btn.innerHTML = COPY_SUCCESS_ICON_SVG;
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
  // 自动滚动锚定正在输出的消息底部，而不是无脑贴到整个消息列表底部。
  scrollToActiveOutput(node, { force: options.forceScroll ?? false, active: options.followActive === true });
}

function updateMessage(node, content, options = {}) {
  const box = node.querySelector('.content');
  const messagesEl = $('messages');
  const preservedScrollTop = options.noScroll && messagesEl ? messagesEl.scrollTop : null;
  node.dataset.rawText = options.rawText ?? content;
  if (options.skipSave) node.dataset.persist = '0';
  else delete node.dataset.persist;
  if (options.messageIndex !== undefined && options.messageIndex !== null) node.dataset.messageIndex = String(options.messageIndex);
  if (options.responseIndex !== undefined && options.responseIndex !== null) node.dataset.responseIndex = String(options.responseIndex);
  if (options.html) box.innerHTML = content;
  else box.innerHTML = renderMarkdown(String(content || ''));
  bindInlineCopyButtons(node);
  hydrateMessageMedia(node, { save: options.skipSave !== true });
  if (options.noScroll) {
    state.scrollVersion += 1;
    clearTimeout(scrollTimer);
    if (messagesEl && preservedScrollTop !== null) {
      const restore = () => { messagesEl.scrollTop = preservedScrollTop; };
      restore();
      requestAnimationFrame(restore);
      setTimeout(restore, 80);
    }
    return;
  }
  const shouldFollowActive = options.followActive === true || state.activeOutputNode === node;
  if (shouldFollowActive) {
    const force = options.forceScroll ?? (options.followActive === true);
    if (force) {
      if (options.settleScroll === false) {
        clearTimeout(scrollTimer);
        scrollToActiveOutput(node, { force: true, active: true, settle: false });
        clearTimeout(scrollTimer);
      } else {
        scrollToActiveOutput(node, { force: true, active: true, settle: true });
      }
    } else {
      state.activeOutputNode = node;
      state.scrollVersion += 1;
      clearTimeout(scrollTimer);
    }
  } else scrollToBottom(options.forceScroll ?? true);
}

function hydrateMessageMedia(node, { save = false } = {}) {
  const finalize = () => {
    bindImagePreview(node);
    bindUserAttachmentPreviews(node);
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
    panel.innerHTML = `
      <div class="reasoning-head">
        <div class="reasoning-title">思考中…</div>
        <button class="reasoning-copy-btn" type="button" title="复制思考内容" aria-label="复制思考内容">
          ${COPY_ICON_SVG}
        </button>
      </div>
      <div class="reasoning-content markdown-body"></div>`;
    panel.querySelector('.reasoning-copy-btn')?.addEventListener('click', async () => {
      await copyText(node.dataset.reasoningText || panel.querySelector('.reasoning-content')?.innerText || '');
      showCopySuccess(panel.querySelector('.reasoning-copy-btn'));
    });
    node.querySelector('.bubble')?.prepend(panel);
  }
  panel.classList.toggle('reasoning-done', options.done === true);
  panel.querySelector('.reasoning-title').textContent = options.done ? '思考完成' : '思考中…';
  const copyBtn = panel.querySelector('.reasoning-copy-btn');
  if (copyBtn) copyBtn.hidden = !contentText;
  const content = panel.querySelector('.reasoning-content');
  const html = renderMarkdown(contentText);
  if (content.innerHTML !== html) {
    content.innerHTML = html;
    bindInlineCopyButtons(panel);
  }
  content.hidden = !contentText;
  scrollToActiveOutput(node, { force: options.forceScroll ?? false, active: options.followActive === true });
  if (options.persistSave && node.isConnected) saveDisplayHistory();
}

function finishReasoning(node, text) {
  if (!state.reasoningMode) {
    clearReasoning(node);
    return;
  }
  const contentText = String(text || node?.dataset.reasoningText || '').trim();
  if (contentText) updateReasoning(node, contentText, { done: true, persistSave: true, keepReasoning: true });
  else showReasoningUnavailable(node);
}

function showReasoningUnavailable(node) {
  if (!node) return;
  updateReasoning(node, '当前模型未返回可展示的思考过程。', { done: true, persistSave: true, keepReasoning: true });
  node.querySelector('.reasoning-panel')?.classList.add('reasoning-empty');
}

function clearAllReasoningDisplays() {
  document.querySelectorAll('.message').forEach(node => clearReasoning(node));
  const session = getActiveSession();
  if (session?.display?.length) {
    session.display.forEach(item => {
      delete item.reasoningText;
      item.keepReasoning = false;
    });
    persistSessionDisplay(session.id);
  }
}

function pendingFeedbackHtml(text) {
  return `<div class="pending-feedback"><span class="pending-orb" aria-hidden="true"></span><span class="pending-text">${escapeHtml(text)}</span><span class="pending-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
}

function isChatStatusText(text = '') {
  return /正在处理|正在思考|正在恢复聊天任务|已收到|请稍等|已等待/.test(String(text || ''));
}

function setPendingFeedback(node, text, options = {}) {
  if (!node) return;
  node.dataset.pendingFeedback = '1';
  updateMessage(node, pendingFeedbackHtml(text), {
    html: true,
    rawText: text,
    skipSave: true,
    followActive: options.followActive === true || state.activeOutputNode === node,
    forceScroll: options.forceScroll ?? (state.activeOutputNode === node),
  });
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

  // 编辑重发只修改当前用户消息，并复用它后面紧邻的回答位置；不删除后续消息。
  if (state.messages[idx]?.role === 'user') state.messages[idx].content = newText;
  else state.messages.splice(idx, 0, { role: 'user', content: newText });
  node.dataset.rawText = newText;
  node.dataset.messageIndex = String(idx);
  const box = node.querySelector('.content');
  box.innerHTML = renderMarkdown(newText);
  bindInlineCopyButtons(node);

  const nextNode = node.nextElementSibling;
  const responseNode = nextNode && (nextNode.classList?.contains('assistant') || nextNode.classList?.contains('error'))
    ? nextNode
    : null;
  const responseIndex = idx + 1;

  if (node.__displayItem) {
    node.__displayItem.rawText = newText;
    node.__displayItem.html = renderMarkdown(newText);
  }

  saveDisplayHistory();

  node.classList.remove('editing');
  state.editingIndex = null;
  state.editingNode = null;
  delete $('prompt').dataset.editing;
  return { index: idx, responseIndex, node, responseNode };
}

function removeSessionDisplayItemForNode(sessionId, node) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session?.display?.length || !node) return;
  const ids = new Set([node.dataset.displayItemId, node.__displayItem?.id].filter(Boolean));
  const responseIndex = node.dataset.responseIndex || node.__displayItem?.responseIndex || '';
  const messageIndex = node.dataset.messageIndex || node.__displayItem?.messageIndex || '';
  const role = node.classList?.contains('assistant') ? 'assistant' : node.classList?.contains('user') ? 'user' : node.__displayItem?.role || '';
  const next = session.display.filter(item => {
    if (ids.size && ids.has(item.id)) return false;
    if (role === 'assistant' && responseIndex !== '' && item.role === 'assistant' && String(item.responseIndex || '') === String(responseIndex)) return false;
    if (role === 'user' && messageIndex !== '' && item.role === 'user' && String(item.messageIndex || '') === String(messageIndex)) return false;
    return true;
  });
  if (next.length === session.display.length) return;
  session.display = next;
  persistSessionDisplay(sessionId);
}

function removeAssistantHistoryAt(sessionId, index) {
  if (!Number.isFinite(index)) return;
  const session = state.sessions.find(item => item.id === sessionId);
  const messages = sessionId === state.activeSessionId ? state.messages : session?.messages;
  if (!Array.isArray(messages) || messages[index]?.role !== 'assistant') return;
  messages.splice(index, 1);
  if (sessionId === state.activeSessionId) saveChatHistory();
  else saveSessionMessages(sessionId, messages);
}

function prepareRegeneratedResponse(userNode, oldNode, sessionId, responseIndex, text = '已收到，马上处理') {
  const html = pendingFeedbackHtml(text);
  removeSessionDisplayItemForNode(sessionId, oldNode);
  removeAssistantHistoryAt(sessionId, responseIndex);
  oldNode?.remove();

  const node = addMessage('assistant', html, { html: true, rawText: text, skipSave: true });
  userNode?.after(node);
  const liveItem = appendSessionDisplayMessage(sessionId, 'assistant', html, { html: true, rawText: text, pending: true, responseIndex });
  node.__displayItem = liveItem;
  if (liveItem?.id) node.dataset.displayItemId = liveItem.id;
  if (Number.isFinite(responseIndex)) node.dataset.responseIndex = String(responseIndex);
  state.activeOutputNode = node;
  return { node, liveItem };
}

function prepareReplacementResponse(editResult, sessionId, text = '已收到，马上处理') {
  const html = pendingFeedbackHtml(text);
  let node = editResult?.responseNode || null;
  if (!node) {
    node = addMessage('assistant', html, { html: true, rawText: text, skipSave: true });
    editResult?.node?.after(node);
  } else {
    node.classList.remove('error');
    node.classList.add('assistant');
    const avatar = node.querySelector('.avatar');
    if (avatar) avatar.textContent = 'AI';
    clearReasoning(node);
    updateMessage(node, html, { html: true, rawText: text, skipSave: true, followActive: true, forceScroll: true });
    state.activeOutputNode = node;
  }

  let liveItem = node.__displayItem || null;
  if (!liveItem) {
    liveItem = appendSessionDisplayMessage(sessionId, 'assistant', html, { html: true, rawText: text, pending: true });
    node.__displayItem = liveItem;
    node.dataset.displayItemId = liveItem.id;
  } else {
    updateSessionDisplayItem(sessionId, liveItem, 'assistant', html, { html: true, rawText: text, pending: true });
  }
  return { node, liveItem };
}

function findPreviousUserMessageNode(node) {
  let current = node?.previousElementSibling;
  while (current) {
    if (current.classList.contains('user')) return current;
    current = current.previousElementSibling;
  }
  return null;
}

function getAssistantImageContext(node) {
  if (!node) return null;
  const candidates = [node.dataset.imageContext || '', node.__displayItem?.imageContext || ''];
  const itemId = node.dataset.displayItemId || node.__displayItem?.id || '';
  if (itemId) {
    const session = getActiveSession();
    const item = (session.display || []).find(entry => entry.id === itemId);
    if (item?.imageContext) candidates.push(item.imageContext);
  }
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
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
  const responseIndex = userIndex + 1;
  const hadGeneratedImage = !!node.querySelector('img.generated-thumb');
  const imageContext = getAssistantImageContext(node);
  const hadImageContext = !!(imageContext && Array.isArray(imageContext.attachments) && imageContext.attachments.length);

  const runSessionId = state.activeSessionId;
  setSessionBusy(runSessionId, true);
  const replacement = prepareRegeneratedResponse(userNode, node, runSessionId, responseIndex);
  node = replacement.node;
  let liveItem = replacement.liveItem;

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
      : await getEffectiveRoute(prompt, [], runSessionId);
    const mode = route.mode;
    updateModeUi(mode, state.autoMode);
    if (warnMissingModel(mode, true)) {
      node.remove();
      return;
    }
    if (mode === 'chat') await sendChat(prompt, [], node, { sessionId: runSessionId, userAlreadyAdded: true, liveItem, replaceAssistantIndex: responseIndex, requestBaseMessages: state.messages.slice(0, userIndex) });
    else await sendImage(prompt, {
      loadingNode: node,
      editMode: mode === 'edit_image',
      editTarget: route.target,
      usePreviousImage: false,
      attachments: restoredAttachments,
      imageContext,
      sessionId: runSessionId,
      userAlreadyAdded: true,
      liveItem,
      replaceAssistantIndex: responseIndex,
    });
  } catch (err) {
    showRunError(runSessionId, err, liveItem, node);
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
  if (data?.error?.code) return data.error.code;
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

function extractModelType(item, modelId = '') {
  if (item && typeof item !== 'string') {
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
    const explicitType = candidates.find(v => String(v || '').trim());
    if (explicitType) return normalizeModelType(explicitType);
  }
  return normalizeModelType(modelId);
}

function extractModels(data) {
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const meta = {};
  const models = [];
  arr.forEach(item => {
    const id = typeof item === 'string' ? item : item?.id || item?.name;
    if (!id) return;
    const modelId = String(id);
    const hasExplicitType = !!(item && typeof item !== 'string' && [
      item.type,
      item.model_type,
      item.modelType,
      item.mode,
      item.category,
      item.task,
      item.capability,
      Array.isArray(item.capabilities) ? item.capabilities.join(',') : '',
    ].some(v => String(v || '').trim()));
    const type = extractModelType(item, modelId);
    meta[modelId] = { id: modelId, type, unrecognized: !hasExplicitType && !type, inferred: !hasExplicitType && !!type };
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
  const inferred = state.modelMeta?.[id]?.inferred;
  const label = unrecognized ? `${id}（未知类型）` : inferred ? `${id}（按名称识别）` : id;
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
    const thumb = isImage
      ? `<button class="attachment-thumb-btn" type="button" data-preview-attachment="${index}" title="打开预览：${escapeHtml(file.name)}" aria-label="打开预览：${escapeHtml(file.name)}"><img src="${escapeHtml(file.dataUrl)}" alt="" /></button>`
      : `<span class="file-icon">${escapeHtml(file.name.split('.').pop() || 'FILE')}</span>`;
    const status = file.compressionNote
      ? `<em title="${escapeHtml(file.compressionNote)}">已压缩</em>`
      : (file.text || file.dataUrl ? '' : `<em title="${escapeHtml(file.unsupportedReason || '暂不支持解析')}">未解析</em>`);
    const previewAttrs = isImage ? ` data-preview-attachment="${index}" role="button" tabindex="0" aria-label="打开预览：${escapeHtml(file.name)}"` : '';
    return `<div class="attachment-chip${isImage ? ' attachment-chip-image' : ''}"${previewAttrs} title="${escapeHtml(file.compressionNote || file.unsupportedReason || file.name)}">${thumb}<span>${escapeHtml(file.name)}</span>${status}<button type="button" data-remove-attachment="${index}">×</button></div>`;
  }).join('');
  bar.classList.toggle('show', state.attachments.length > 0);
  bar.querySelectorAll('[data-preview-attachment]').forEach(el => {
    const open = () => {
      const item = state.attachments[Number(el.dataset.previewAttachment)];
      if (item?.dataUrl) openImagePreview(item.dataUrl);
    };
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove-attachment]')) return;
      open();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open();
    });
  });
  bar.querySelectorAll('[data-remove-attachment]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
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

async function persistImageAttachmentRefs(items = []) {
  const refs = [];
  for (const item of items) {
    const ref = serializeImageAttachment(item);
    if (!ref) continue;
    let src = ref.src;
    if (src.startsWith('data:')) {
      try {
        const blob = await dataUrlToBlob(src);
        const id = `edit-attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        await putImageBlob(id, blob);
        src = `indexeddb://${id}`;
      } catch {
        src = ref.src;
      }
    }
    refs.push({ ...ref, src });
  }
  return refs;
}

function normalizeImageContextForStorage(context = {}) {
  return {
    prompt: context.prompt || '',
    mode: context.mode || 'image',
    target: context.target || 'new',
    usePreviousImage: !!context.usePreviousImage,
    attachments: (context.attachments || []).map(serializeImageAttachment).filter(Boolean),
  };
}

function parseImageContext(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

async function buildUploadedImageContext(prompt, attachments = []) {
  const imageRefs = attachments.filter(item => isImageFile(item));
  if (!imageRefs.length) return null;
  const persisted = await persistImageAttachmentRefs(imageRefs);
  if (!persisted.length) return null;
  return normalizeImageContextForStorage({
    prompt,
    mode: 'edit_image',
    target: 'uploaded',
    usePreviousImage: false,
    attachments: persisted,
  });
}

function getLatestUploadedImageContext(sessionId = state.activeSessionId) {
  const session = state.sessions.find(item => item.id === sessionId) || getActiveSession();
  const candidates = [...(session?.display || [])].reverse();
  for (const item of candidates) {
    const ctx = parseImageContext(item?.imageContext);
    if (ctx?.attachments?.length && (ctx.target === 'uploaded' || ctx.mode === 'edit_image')) return ctx;
  }
  for (const msg of [...(session?.messages || [])].reverse()) {
    const ctx = parseImageContext(msg?.imageContext);
    if (ctx?.attachments?.length && (ctx.target === 'uploaded' || ctx.mode === 'edit_image')) return ctx;
  }
  return null;
}

async function getLatestUploadedImageAttachments(sessionId = state.activeSessionId) {
  const ctx = getLatestUploadedImageContext(sessionId);
  return ctx?.attachments?.length ? restoreImageAttachmentsFromContext(ctx) : [];
}

function looksLikeImageEditInstruction(prompt = '') {
  return /(换|替换|改|修改|编辑|调整|优化|重做|修|去掉|加上|放大|缩小|变成|换个|换成|logo|图标|背景|颜色|字体|样式|清晰|高清)/i.test(String(prompt || ''));
}

function setImageContext(node, context) {
  if (!node || !context) return;
  const raw = JSON.stringify(normalizeImageContextForStorage(context));
  node.dataset.imageContext = raw;
  if (node.__displayItem) node.__displayItem.imageContext = raw;
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

function isExcelFile(item) {
  return /\.(xlsx|xlsm)$/i.test(item.name) || /spreadsheetml\.sheet|spreadsheetml|ms-excel/.test(item.type || '');
}

function canExtractOfficeText(item) {
  return /\.(xlsx|xlsm|xls|pptx|ppt|docx|doc)$/i.test(item.name)
    || /(spreadsheetml|presentationml|wordprocessingml|msword|ms-excel|ms-powerpoint)/.test(item.type || '');
}

function canExtractAttachmentText(item) {
  return isPdfFile(item) || canExtractOfficeText(item);
}

async function extractAttachmentText(item) {
  if (!item?.dataUrl) return '';
  try {
    const res = await fetch('/api/extract-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: item.name, type: item.type, dataUrl: item.dataUrl }),
    });
    const data = await parseResponseJson(res);
    if (!res.ok) throw new Error(normalizeError(null, data));
    return String(data.text || '').trim();
  } catch (err) {
    item.unsupportedReason = `本地解析失败：${err.message || String(err)}。为避免接口报错，不会直接发送二进制原文件。`;
    return '';
  }
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
    } else if (isPdfFile(item) || isOfficeFile(item)) {
      item.dataUrl = await readFileAsDataURL(uploadFile);
      if (canExtractAttachmentText(item)) {
        const extractedText = await extractAttachmentText(item);
        if (extractedText) item.text = extractedText;
      }
    } else if (isProbablyTextFile(item)) {
      item.text = await readFileAsText(file);
      if (looksBinary(item.text)) {
        item.text = '';
        item.unsupportedReason = '文件看起来是二进制内容，未内联解析';
      }
    } else {
      // 最后一层兜底：很多代码文件在浏览器里 type 为空，尝试按文本读取一小类安全文件。
      try {
        const text = await readFileAsText(file);
        if (!looksBinary(text)) { item.text = text; }
        else { item.dataUrl = await readFileAsDataURL(uploadFile); }
      } catch {
        item.dataUrl = await readFileAsDataURL(uploadFile);
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

function applyDefaultSystemPrompt(messages, systemPrompt = '') {
  const content = String(systemPrompt || '').trim();
  if (!content) return messages;
  const withoutDuplicate = messages.filter((msg, index) => !(index === 0 && msg?.role === 'system' && String(msg.content || '').trim() === content));
  return [{ role: 'system', content }, ...withoutDuplicate];
}

function normalizeApiChatMessage(msg) {
  if (!msg || !['system', 'user', 'assistant'].includes(msg.role)) return null;
  if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
  if (Array.isArray(msg.content)) return { role: msg.role, content: msg.content };
  return { role: msg.role, content: String(msg.content || '') };
}

function normalizeApiChatHistory(messages = []) {
  return (Array.isArray(messages) ? messages : []).map(normalizeApiChatMessage).filter(Boolean);
}

function buildChatMessagesWithAttachments(prompt, attachments = state.attachments, baseMessages = state.messages, systemPrompt = '') {
  const history = normalizeApiChatHistory(baseMessages);
  if (!attachments.length) return applyDefaultSystemPrompt([...history, { role: 'user', content: prompt }], systemPrompt);

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
      text: `\n\n[以下附件已上传到页面，但未能解析正文，因此不会直接发送二进制文件给模型，避免接口报错：\n${unsupported.map(f => `- ${f.name} (${f.type})：${f.unsupportedReason || '暂不支持解析，请转换为文本/Markdown/CSV 后再上传'}`).join('\n')}\n]`,
    });
  }
  return applyDefaultSystemPrompt([...history, { role: 'user', content: parts }], systemPrompt);
}


function reasoningBudgetTokens(effort = 'medium') {
  return ({ low: 1024, medium: 4096, high: 8192, xhigh: 16384 })[effort] || 4096;
}

function reasoningPayloadOptions(options = {}) {
  if (options.reasoning === false) return {};
  const effort = options.reasoningEffort || state.reasoningType;
  if (!state.reasoningMode && !options.reasoningEffort) return {};
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) return {};
  const provider = normalizeReasoningProvider(options.reasoningProvider || state.reasoningProvider || 'auto');
  const openaiEffort = effort === 'xhigh' ? 'high' : effort;
  if (provider === 'anthropic') return { thinking: { type: 'enabled', budget_tokens: reasoningBudgetTokens(effort) } };
  if (provider === 'thinking-budget') return { enable_thinking: true, thinking_budget: reasoningBudgetTokens(effort) };
  if (provider === 'generic') return { reasoning: { enabled: true, effort: openaiEffort } };
  if (provider === 'google') return { thinkingConfig: { thinkingBudget: reasoningBudgetTokens(effort) } };
  return { reasoning_effort: openaiEffort };
}

function buildChatPayload(model, messages, options = {}) {
  return {
    model,
    messages,
    stream: options.stream !== false,
    ...reasoningPayloadOptions(options),
  };
}

function saveLastGeneratedImage() {
  const session = getActiveSession();
  session.lastGeneratedImage = state.lastGeneratedImage || null;
  if (state.lastGeneratedImage) localStorage.setItem(sessionStorageKey(LAST_IMAGE_KEY), JSON.stringify(state.lastGeneratedImage));
  else localStorage.removeItem(sessionStorageKey(LAST_IMAGE_KEY));
  saveSessionsMeta();
}

function loadLastGeneratedImage() {
  const session = getActiveSession();
  state.lastGeneratedImage = session.lastGeneratedImage || readJsonStorage(sessionStorageKey(LAST_IMAGE_KEY), null);
  if (session) session.lastGeneratedImage = state.lastGeneratedImage || null;
}


function buildUserMessageContent(prompt, attachments = []) {
  const base = String(prompt || '').trim();
  if (base) return base;
  return attachments.length ? '已发送附件' : '';
}

function buildUserApiContent(prompt, attachments = []) {
  if (!attachments.length) return prompt;
  const content = buildChatMessagesWithAttachments(prompt, attachments, [], '')[0]?.content;
  return content || prompt || attachmentsSummaryMarkdown(attachments).trim();
}

function attachmentsSummaryMarkdown(attachments = state.attachments) {
  if (!attachments.length) return '';
  return '\n\n' + attachments.map(f => `📎 ${f.name}`).join('\n');
}

async function prepareUserAttachmentPreviews(attachments = []) {
  for (const file of attachments) {
    if (!isImageFile(file) || !file.dataUrl || file.previewSrc) continue;
    try {
      file.previewSrc = await persistImageSrc(file.dataUrl, file.name || 'attachment.png');
    } catch {
      file.previewSrc = file.dataUrl;
    }
  }
  return attachments;
}

function userAttachmentPreviewHtml(attachments = []) {
  const items = attachments.filter(f => isImageFile(f) && (f.previewSrc || f.dataUrl));
  if (!items.length) return '';
  return `<div class="user-attachment-preview-grid">${items.map(file => {
    const src = file.previewSrc || file.dataUrl;
    const displaySrc = src.startsWith('indexeddb://') ? TRANSPARENT_PIXEL : src;
    return `
    <img class="user-attachment-image" src="${escapeHtml(displaySrc)}" data-persisted-src="${escapeHtml(src)}" alt="${escapeHtml(file.name)}" title="点击预览" />`;
  }).join('')}</div>`;
}

function renderUserMessageWithAttachments(prompt, attachments = []) {
  const textHtml = renderMarkdown(String(prompt || ''));
  const previewHtml = userAttachmentPreviewHtml(attachments);
  const nonImageSummary = attachments.filter(f => !(isImageFile(f) && f.dataUrl));
  const summaryHtml = nonImageSummary.length ? renderMarkdown(attachmentsSummaryMarkdown(nonImageSummary)) : '';
  return `${textHtml}${previewHtml}${summaryHtml}`;
}

function bindUserAttachmentPreviews(scope) {
  scope.querySelectorAll('img.user-attachment-image').forEach(img => {
    if (img.dataset.userAttachmentPreviewBound === '1') return;
    img.dataset.userAttachmentPreviewBound = '1';
    img.addEventListener('click', () => openImagePreview(img.currentSrc || img.src || img.dataset.persistedSrc || ''));
  });
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

async function streamManagedChatCompletions(payload, cfg, jobId, onDelta) {
  if (jobId) state.followingChatJobs.add(jobId);
  try {
    await registerChatStreamJob(payload, cfg, jobId, { start: true });
    const data = await waitChatJob(jobId, (job) => {
      const partial = extractChatJobText(job.data);
      if (partial.content || partial.reasoning) onDelta(partial);
    });
    return extractChatJobText(data);
  } finally {
    if (jobId) state.followingChatJobs.delete(jobId);
  }
}

async function imageFileToJobPayload(item) {
  const file = item?.file;
  if (!file) return null;
  const dataUrl = await readFileAsDataURL(file);
  const data = String(dataUrl || '').split(',')[1] || '';
  if (!data) return null;
  return {
    name: item.name || file.name || 'image.png',
    type: item.type || file.type || 'image/png',
    data,
  };
}

async function imageFilesToJobPayload(files = []) {
  const result = [];
  for (const item of files) {
    const payload = await imageFileToJobPayload(item);
    if (payload) result.push(payload);
  }
  return result;
}

async function startImageGenerationJob(payload, cfg, jobId, options = {}) {
  const res = await fetch('/api/image-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      payload,
      mode: options.mode || 'image',
      files: options.files || [],
    }),
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
    systemPrompt: '',
    hasSystemPromptOverride: false,
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

function normalizeMessageOrderFields(messages = []) {
  let nextIndex = 0;
  return (Array.isArray(messages) ? messages : []).map(msg => {
    if (!msg || !msg.role) return msg;
    const out = { ...msg };
    const explicit = msg.role === 'user' ? Number(msg.messageIndex) : Number(msg.responseIndex);
    const index = Number.isFinite(explicit) ? explicit : nextIndex;
    if (msg.role === 'user') out.messageIndex = String(index);
    if (msg.role === 'assistant') out.responseIndex = String(index);
    nextIndex = Math.max(nextIndex, index + 1);
    return out;
  });
}

function messageSortIndex(msg, fallback) {
  const value = msg?.role === 'user' ? Number(msg.messageIndex) : msg?.role === 'assistant' ? Number(msg.responseIndex) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function sortCanonicalMessages(messages = []) {
  return normalizeMessageOrderFields(messages)
    .map((msg, fallback) => ({ msg, fallback }))
    .sort((a, b) => messageSortIndex(a.msg, a.fallback) - messageSortIndex(b.msg, b.fallback) || a.fallback - b.fallback)
    .map(item => item.msg);
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


function cloneMessageList(messages = []) {
  return messages.map(msg => normalizeMessageForStorage(msg)).filter(Boolean);
}

function compactAdjacentDuplicateMessages(messages = []) {
  const compacted = [];
  const ordered = sortCanonicalMessages(messages);
  for (const msg of ordered.map(normalizeMessageForStorage).filter(Boolean)) {
    const prev = compacted[compacted.length - 1];
    if (prev && prev.role === msg.role && prev.content === msg.content) continue;
    compacted.push(msg);
  }
  return compacted;
}

function compactDisplayItems(items = []) {
  const compacted = [];
  for (const item of items || []) {
    if (!item) continue;
    const prev = compacted[compacted.length - 1];
    const signature = [item.role || '', item.rawText || '', item.html || '', item.pending || '', item.jobId || '', item.responseIndex || '', item.messageIndex || ''].join('\u0001');
    const prevSignature = prev ? [prev.role || '', prev.rawText || '', prev.html || '', prev.pending || '', prev.jobId || '', prev.responseIndex || '', prev.messageIndex || ''].join('\u0001') : '';
    if (prev && signature === prevSignature) continue;
    compacted.push(item);
  }
  return compacted;
}


function displayItemHasRichMedia(item) {
  return !!(item?.html && (
    /data-persisted-src=/.test(item.html)
    || /data-persisted-href=/.test(item.html)
    || /user-attachment-preview-grid/.test(item.html)
    || /class=["'][^"']*generated-thumb/.test(item.html)
    || /class=["'][^"']*user-attachment-image/.test(item.html)
    || /image-download-row/.test(item.html)
  ));
}

function displayItemMatchesMessage(item, msg, index, session) {
  if (!item || !msg || item.role !== msg.role) return false;
  if (item.messageIndex !== '' && Number(item.messageIndex) === index) return true;
  if (item.responseIndex !== '' && Number(item.responseIndex) === index) return true;
  const content = String(msg.content || '');
  const raw = String(item.rawText || '');
  if (raw && raw === content) return true;
  if (msg.role === 'user' && displayItemHasRichMedia(item)) {
    const isAttachmentMessage = /📎/.test(content) || content === '已发送附件';
    if (!isAttachmentMessage) return false;
    const richUsers = (session?.display || []).filter(entry => entry?.role === 'user' && displayItemHasRichMedia(entry));
    const userRichOrder = (session?.messages || [])
      .slice(0, index + 1)
      .filter(entry => entry?.role === 'user' && (/📎/.test(String(entry.content || '')) || String(entry.content || '') === '已发送附件'))
      .length - 1;
    return userRichOrder >= 0 && richUsers[userRichOrder] === item;
  }
  if (msg.role === 'assistant' && displayItemHasRichMedia(item)) {
    const isImageMessage = /^\[图片(生成|编辑|修改)完成\]/.test(content);
    if (!isImageMessage) return false;
    const richAssistants = (session?.display || []).filter(entry => entry?.role === 'assistant' && displayItemHasRichMedia(entry));
    const assistantRichOrder = (session?.messages || [])
      .slice(0, index + 1)
      .filter(entry => entry?.role === 'assistant' && /^\[图片(生成|编辑|修改)完成\]/.test(String(entry.content || '')))
      .length - 1;
    return assistantRichOrder >= 0 && richAssistants[assistantRichOrder] === item;
  }
  return false;
}

function findDisplayItemForMessage(session, index, msg) {
  if (!session || !msg || !['user', 'assistant'].includes(msg.role)) return null;
  const items = session.display || [];
  return items.find(item => displayItemMatchesMessage(item, msg, index, session)) || null;
}

function findUserAttachmentDisplayItemForMessage(session, index, msg) {
  if (!session || !msg || msg.role !== 'user') return null;
  const content = String(msg.content || '');
  const isAttachmentMessage = /📎/.test(content) || content === '已发送附件' || /附件/.test(content);
  if (!isAttachmentMessage) return null;
  const items = session.display || [];
  return items.find(item => item?.role === 'user' && displayItemHasRichMedia(item) && displayItemMatchesMessage(item, msg, index, session)) || null;
}

function findImageDisplayItemForMessage(session, index, msg) {
  if (!session || !msg || msg.role !== 'assistant') return null;
  const content = String(msg.content || '');
  if (!/^\[图片(生成|编辑|修改)完成\]/.test(content)) return null;
  const items = session.display || [];
  return items.find(item => item?.role === 'assistant' && displayItemHasRichMedia(item) && displayItemMatchesMessage(item, msg, index, session)) || null;
}

function renderMessageFromCanonical(session, msg, index) {
  if (msg?.html) {
    const node = addMessage(msg.role === 'assistant' ? 'assistant' : msg.role === 'error' ? 'error' : 'user', msg.html, {
      html: true,
      rawText: msg.rawText || msg.content,
      messageIndex: msg.role === 'user' ? (msg.messageIndex !== undefined ? msg.messageIndex : index) : null,
      responseIndex: msg.role === 'assistant' ? (msg.responseIndex !== undefined ? msg.responseIndex : index) : null,
      deferSave: true,
    });
    node.dataset.rawText = msg.rawText || msg.content;
    if (msg.role === 'user') node.dataset.messageIndex = String(msg.messageIndex !== undefined ? msg.messageIndex : index);
    if (msg.responseIndex !== undefined && msg.responseIndex !== '') node.dataset.responseIndex = String(msg.responseIndex);
    if (msg.imageContext) node.dataset.imageContext = msg.imageContext;
    return node;
  }
  const displayItem = findUserAttachmentDisplayItemForMessage(session, index, msg) || findImageDisplayItemForMessage(session, index, msg) || findDisplayItemForMessage(session, index, msg);
  const node = displayItem
    ? addDisplayItemNode({ ...displayItem, pending: '' })
    : addMessage(msg.role === 'assistant' ? 'assistant' : 'user', msg.content, {
        rawText: msg.content,
        messageIndex: msg.role === 'user' ? (msg.messageIndex !== undefined ? msg.messageIndex : index) : null,
        responseIndex: msg.role === 'assistant' ? (msg.responseIndex !== undefined ? msg.responseIndex : index) : null,
        deferSave: true,
      });
  node.dataset.rawText = msg.content;
  if (msg.role === 'user') node.dataset.messageIndex = String(msg.messageIndex !== undefined ? msg.messageIndex : index);
  if (msg.role === 'assistant' && displayItem?.responseIndex !== '') node.dataset.responseIndex = displayItem.responseIndex;
  return node;
}

function trimAssistantTailDuplicate(messages = [], reply = '') {
  const safe = compactAdjacentDuplicateMessages(messages);
  const text = String(reply || '');
  while (safe.length >= 2
    && safe[safe.length - 1]?.role === 'assistant'
    && safe[safe.length - 2]?.role === 'assistant'
    && safe[safe.length - 1]?.content === text
    && safe[safe.length - 2]?.content === text) {
    safe.pop();
  }
  return safe;
}

function assistantMessageCount(messages = []) {
  return (Array.isArray(messages) ? messages : []).filter(msg => msg?.role === 'assistant').length;
}

function displayMessageItems(session) {
  const activeJobIds = new Set([loadImageJob(session?.id)?.id, loadLatestChatJob(session?.id)?.id].filter(Boolean));
  return (session?.display || []).filter(item => {
    if (!item || !['user', 'assistant', 'error'].includes(item.role)) return false;
    if (item.pending === '1' && (!item.jobId || !activeJobIds.has(item.jobId))) return false;
    const raw = String(item.rawText || '').trim();
    return raw || displayItemHasRichMedia(item);
  });
}

function displayItemToMessage(item, session) {
  if (!item) return null;
  const raw = String(item.rawText || '').trim();
  if (item.role === 'user') {
    if (raw) return { role: 'user', content: raw };
    const idx = item.messageIndex !== '' ? Number(item.messageIndex) : NaN;
    const saved = Number.isFinite(idx) ? session?.messages?.[idx] : null;
    return saved?.role === 'user' && saved.content ? { role: 'user', content: saved.content } : null;
  }
  const idx = item.responseIndex !== '' ? Number(item.responseIndex) : NaN;
  const saved = Number.isFinite(idx) ? session?.messages?.[idx] : null;
  if (displayItemHasRichMedia(item) && saved?.role === 'assistant' && /^\[图片(生成|编辑|修改)完成\]/.test(String(saved.content || ''))) {
    return { role: 'assistant', content: saved.content };
  }
  if (raw) return { role: 'assistant', content: raw };
  return saved?.role === 'assistant' && saved.content ? { role: 'assistant', content: saved.content } : null;
}

function indexedMessagesFromDisplay(session) {
  if (!session) return [];
  const indexed = [];
  const items = displayMessageItems(session);
  for (const item of items) {
    const msg = displayItemToMessage(item, session);
    if (!msg?.content) continue;
    const rawIndex = item.role === 'user' ? item.messageIndex : item.responseIndex;
    const index = rawIndex !== '' && rawIndex !== undefined ? Number(rawIndex) : NaN;
    if (!Number.isFinite(index) || index < 0) continue;
    const prev = indexed[index];
    if (!prev || (msg.role === 'assistant' && prev.role !== 'assistant') || msg.content.length >= String(prev.content || '').length) {
      indexed[index] = msg;
    }
  }
  return indexed.filter(Boolean);
}

function repairMessagesFromDisplay(session) {
  if (!session) return [];
  const saved = compactAdjacentDuplicateMessages(session.messages || []);
  const indexedDisplay = compactAdjacentDuplicateMessages(indexedMessagesFromDisplay(session));
  if (!indexedDisplay.length) return saved;
  const savedAssistants = assistantMessageCount(saved);
  const displayAssistants = assistantMessageCount(indexedDisplay);
  const savedUsers = saved.filter(msg => msg?.role === 'user').length;
  const displayUsers = indexedDisplay.filter(msg => msg?.role === 'user').length;
  if (displayAssistants > savedAssistants && displayUsers >= savedUsers) return indexedDisplay;
  if (indexedDisplay.length > saved.length && displayAssistants >= savedAssistants && displayUsers >= savedUsers) return indexedDisplay;
  return saved;
}

function assignChatDisplayIndexes(session, item, userIndex) {
  if (!session || !item || !Number.isFinite(userIndex)) return;
  const responseIndex = userIndex + 1;
  item.responseIndex = String(responseIndex);
  const userItem = [...(session.display || [])]
    .reverse()
    .find(entry => entry?.role === 'user' && entry.messageIndex !== '' && Number(entry.messageIndex) === userIndex);
  if (userItem) userItem.responseIndex = String(responseIndex);
  persistSessionDisplay(session.id);
}

function activeSessionMessages() {
  const current = Array.isArray(state.messages) ? cloneMessageList(state.messages) : [];
  const session = getActiveSession();
  const saved = Array.isArray(session?.messages) ? cloneMessageList(session.messages) : [];
  return current.length >= saved.length ? current : saved;
}

function saveSessionMessages(sessionId, messages) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return;
  const safeMessages = compactAdjacentDuplicateMessages(messages);
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
  session.display = compactDisplayItems(session.display || []).slice(-80);
  localStorage.setItem(sessionStorageKey(UI_KEY, sessionId), JSON.stringify(session.display));
  saveSessionsMeta();
}

function makeDisplayItemId() {
  return `display_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function makeDisplayItem(role, content, { html = false, rawText = content, messageIndex = null, pending = false, responseIndex = null, jobId = '', id = '', imageContext = '' } = {}) {
  return {
    id: id || makeDisplayItemId(),
    role,
    rawText: rawText || '',
    html: html ? String(content || '') : renderMarkdown(String(content || '')),
    reasoningText: '',
    keepReasoning: false,
    messageIndex: messageIndex !== null && messageIndex !== undefined ? String(messageIndex) : '',
    responseIndex: responseIndex !== null && responseIndex !== undefined ? String(responseIndex) : '',
    jobId: jobId || '',
    imageContext: imageContext || '',
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

function replaceAssistantMessageAt(sessionId, index, content) {
  if (!Number.isFinite(index)) return false;
  const session = state.sessions.find(item => item.id === sessionId);
  const messages = sessionId === state.activeSessionId ? state.messages : session?.messages;
  if (!Array.isArray(messages)) return false;
  if (messages[index]?.role === 'assistant') messages[index].content = content;
  else messages.splice(index, 0, { role: 'assistant', content });
  if (sessionId === state.activeSessionId) saveChatHistory();
  else saveSessionMessages(sessionId, messages);
  return true;
}

function loadChatJob(sessionId = state.activeSessionId) {
  try { return JSON.parse(localStorage.getItem(sessionChatJobKey(sessionId)) || 'null'); }
  catch { return null; }
}

function loadDisplayChatJob(sessionId = state.activeSessionId) {
  const session = state.sessions.find(item => item.id === sessionId);
  const item = [...(session?.display || [])].reverse().find(item => item?.pending === '1' && item.jobId);
  if (!item?.jobId) return null;
  return {
    id: item.jobId,
    prompt: '',
    payload: null,
    startedAt: Date.now(),
    displayItemId: item.id || '',
    responseIndex: item.responseIndex !== '' && item.responseIndex !== undefined ? item.responseIndex : null,
  };
}

function loadLatestChatJob(sessionId = state.activeSessionId) {
  const saved = loadChatJob(sessionId);
  const displayJob = loadDisplayChatJob(sessionId);
  if (!saved?.id) return displayJob;
  if (!displayJob?.id) return saved;
  return displayJob.id === saved.id ? { ...saved, displayItemId: saved.displayItemId || displayJob.displayItemId, responseIndex: saved.responseIndex ?? displayJob.responseIndex } : displayJob;
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
  session.display = compactDisplayItems(session.display).slice(-80);
  persistSessionDisplay(sessionId);
  return item;
}

function updateSessionDisplayItem(sessionId, item, role, content, options = {}) {
  const session = state.sessions.find(session => session.id === sessionId);
  if (!session || !item) return;
  item.role = role;
  item.rawText = options.rawText ?? content;
  item.html = options.html ? String(content || '') : renderMarkdown(String(content || ''));
  if (!item.id) item.id = makeDisplayItemId();
  if (options.pending !== undefined) item.pending = options.pending ? '1' : '';
  if (options.id !== undefined && options.id) item.id = options.id;
  if (options.messageIndex !== undefined && options.messageIndex !== null) item.messageIndex = String(options.messageIndex);
  if (options.responseIndex !== undefined && options.responseIndex !== null) item.responseIndex = String(options.responseIndex);
  if (options.jobId !== undefined) item.jobId = options.jobId || '';
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
  const nodes = [...$('messages').querySelectorAll('.message')];
  return nodes.find(node => node.__displayItem === item)
    || (item.id ? nodes.find(node => node.dataset.displayItemId === item.id) : null)
    || (item.role === 'assistant' && item.responseIndex !== '' ? nodes.find(node => node.classList.contains('assistant') && node.dataset.responseIndex === String(item.responseIndex)) : null)
    || (item.role === 'user' && item.messageIndex !== '' ? nodes.find(node => node.classList.contains('user') && node.dataset.messageIndex === String(item.messageIndex)) : null)
    || null;
}

function addDisplayItemNode(item) {
  const node = addMessage(item.role || 'assistant', item.html || item.rawText || '', {
    html: !!item.html,
    rawText: item.rawText || '',
    messageIndex: item.messageIndex !== '' ? Number(item.messageIndex) : null,
    skipSave: item.pending === '1',
    deferSave: true,
  });
  if (!item.id) item.id = makeDisplayItemId();
  node.__displayItem = item;
  node.dataset.displayItemId = item.id;
  if (item.responseIndex !== undefined && item.responseIndex !== '') node.dataset.responseIndex = item.responseIndex;
  if (item.jobId) node.dataset.jobId = item.jobId;
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

function takeChatJobLiveItem(sessionId, saved, fallbackText, matcher = null) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return null;
  session.display ||= [];

  let liveItem = null;
  if (saved?.displayItemId) liveItem = session.display.find(item => item.id === saved.displayItemId) || null;
  if (saved?.id && !liveItem) liveItem = session.display.find(item => item.jobId === saved.id) || null;
  if (!liveItem && saved?.responseIndex !== undefined && saved.responseIndex !== null) {
    const responseIndex = String(saved.responseIndex);
    liveItem = session.display.find(item => item.responseIndex === responseIndex) || null;
    if (!liveItem) {
      const assistantItems = session.display.filter(item => item.role === 'assistant' || !item.role);
      const assistantPosition = Math.max(0, Math.floor(Number(saved.responseIndex) / 2));
      liveItem = assistantItems[assistantPosition] || null;
    }
  }

  const pendingItems = session.display.filter(item => item.pending === '1' && (item.role === 'assistant' || !item.role));
  if (!liveItem && matcher) liveItem = [...pendingItems].reverse().find(item => matcher.test(item.rawText || '')) || null;
  if (!liveItem) liveItem = pendingItems[pendingItems.length - 1] || null;
  if (!liveItem) liveItem = appendSessionDisplayMessage(sessionId, 'assistant', fallbackText, { rawText: fallbackText, pending: true, responseIndex: saved?.responseIndex ?? null, jobId: saved?.id || '' });

  if (!liveItem.id) liveItem.id = saved?.displayItemId || makeDisplayItemId();
  if (saved?.id) liveItem.jobId = saved.id;
  if (saved?.responseIndex !== undefined && saved.responseIndex !== null) liveItem.responseIndex = String(saved.responseIndex);
  liveItem.pending = '1';

  const removeSet = new Set(pendingItems.filter(item => item !== liveItem));
  if (removeSet.size) {
    session.display = session.display.filter(item => !removeSet.has(item));
    removeSet.forEach(removeDisplayItemNode);
  }
  persistSessionDisplay(sessionId);
  return liveItem;
}

function updateLiveDisplay(sessionId, item, role, content, options = {}) {
  updateSessionDisplayItem(sessionId, item, role, content, { ...options, pending: options.pending ?? true });
  if (sessionId !== state.activeSessionId) return;
  let node = findMessageNodeByDisplayItem(item);
  if (!node) node = addDisplayItemNode(item);
  if (options.reasoning !== undefined) updateReasoning(node, options.reasoning || '', { keepEmpty: true, forceScroll: options.forceScroll ?? false, followActive: options.followActive === true });
  const light = options.pending !== false && !options.html;
  if (light) updateMessageContentLight(node, content, { ...options, skipSave: true, forceScroll: options.forceScroll ?? false });
  else updateMessage(node, content, { ...options, skipSave: options.pending !== false, noScroll: options.noScroll === true });
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
      systemPrompt: session.systemPrompt || '',
      hasSystemPromptOverride: !!session.hasSystemPromptOverride,
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
          systemPrompt: item.systemPrompt || '',
          hasSystemPromptOverride: !!item.hasSystemPromptOverride,
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

function renderSessionPromptArea() {
  const input = $('sessionPromptInput');
  const hint = $('sessionPromptHint');
  if (!input) return;
  const session = getActiveSession();
  const hasOverride = !!session?.hasSystemPromptOverride;
  const sessionPrompt = session?.systemPrompt || '';
  input.value = hasOverride ? sessionPrompt : '';
  if (hasOverride) {
    hint.textContent = sessionPrompt.trim() ? '会话自定义' : '会话自定义 · 空';
    hint.className = 'session-prompt-hint-value session-prompt-custom';
  } else {
    hint.textContent = '无 · 未设置';
    hint.className = 'session-prompt-hint-value session-prompt-none';
  }
  const btn = $('sessionPromptBtn');
  if (btn) {
    btn.classList.toggle('has-session-prompt', hasOverride);
  }
}

function saveSessionPrompt() {
  const input = $('sessionPromptInput');
  if (!input) return;
  const session = getActiveSession();
  if (!session) return;
  session.systemPrompt = input.value.trim();
  session.hasSystemPromptOverride = true;
  saveSessionsMeta();
  renderSessionPromptArea();
  closeSessionPromptPanel();
}

function loadGlobalPromptToSessionInput() {
  const input = $('sessionPromptInput');
  if (!input) return;
  const cfg = getConfig();
  input.value = cfg.systemPrompt || '';
  input.focus();
}

function clearSessionPromptInput() {
  const input = $('sessionPromptInput');
  if (!input) return;
  input.value = '';
  input.focus();
}

function openSessionPromptPanel() {
  const panel = $('sessionPromptPanel');
  if (!panel) return;
  renderSessionPromptArea();
  panel.classList.add('show');
  panel.setAttribute('aria-hidden', 'false');
  const input = $('sessionPromptInput');
  if (input) setTimeout(() => input.focus(), 60);
}

function closeSessionPromptPanel() {
  const panel = $('sessionPromptPanel');
  if (!panel) return;
  panel.classList.remove('show');
  panel.setAttribute('aria-hidden', 'true');
  renderSessionPromptArea();
}



function restorePendingDisplayItems(session, pendingItems = []) {
  if (!session || !pendingItems.length) return;
  const activeJobIds = new Set([loadImageJob(session.id)?.id, loadLatestChatJob(session.id)?.id].filter(Boolean));
  const activePending = pendingItems.filter(item => item?.pending === '1' && item.jobId && activeJobIds.has(item.jobId));
  if (!activePending.length) return;
  session.display ||= [];
  for (const item of activePending) {
    if (item.id && session.display.some(existing => existing.id === item.id)) continue;
    session.display.push(item);
    if (session.id === state.activeSessionId) addDisplayItemNode(item);
  }
  session.display = compactDisplayItems(session.display).slice(-80);
  persistSessionDisplay(session.id);
}

function rebuildDisplayFromMessages(session, { preservePending = true } = {}) {
  const pendingItems = preservePending ? [...(session?.display || [])].filter(item => item?.pending === '1') : [];
  const rendered = loadChatHistory({ render: true });
  if (rendered) restorePendingDisplayItems(session, pendingItems);
  return rendered;
}

function canonicalDomSignature() {
  return [...$('messages').querySelectorAll('.message')]
    .map(node => `${node.classList.contains('user') ? 'user' : node.classList.contains('assistant') ? 'assistant' : 'error'}:${node.dataset.rawText || ''}`)
    .join('');
}

function messagesDomSignature(messages = []) {
  return (messages || [])
    .filter(msg => ['user', 'assistant', 'error'].includes(msg?.role))
    .map(msg => `${msg.role}:${msg.rawText || msg.content || ''}`)
    .join('');
}

function forceRenderCanonicalMessages(session) {
  if (!session) return false;
  const messages = compactAdjacentDuplicateMessages(session.messages || state.messages || []);
  if (!messages.length) return false;
  state.messages = cloneMessageList(messages);
  session.messages = cloneMessageList(messages);
  $('messages').innerHTML = '';
  state.messages.forEach((msg, index) => renderMessageFromCanonical(session, msg, index));
  const ok = canonicalDomSignature() === messagesDomSignature(state.messages);
  if (ok) saveDisplayHistory();
  return ok;
}

function ensureCanonicalDom(session) {
  if (!session?.messages?.length) return;
  const expected = messagesDomSignature(session.messages);
  if (!expected) return;
  if (canonicalDomSignature() !== expected) {
    forceRenderCanonicalMessages(session);
  }
}

function renderActiveSession() {
  const session = getActiveSession();
  $('messages').innerHTML = '';
  state.lastGeneratedImage = session.lastGeneratedImage || null;

  // 会话切换/刷新时，canonical messages 是唯一事实来源。
  // display 只做图片/附件富媒体和 pending job 的增强兜底，绝不覆盖完整 messages。
  const rendered = loadChatHistory({ render: true });
  ensureCanonicalDom(session);
  restorePendingDisplayItems(session, [...(session?.display || [])].filter(item => item?.pending === '1'));
  ensureCanonicalDom(session);

  if (!rendered || !$('messages').children.length) {
    renderEmptyWelcome();
  }
  renderSessionList();
  renderSessionPromptArea();
  scrollToBottom(true);
  resumeSessionJobs(session.id);
}

function switchSession(sessionId) {
  // 切换只读不写：不能用当前 DOM / 临时 state 覆盖任何历史缓存。
  // messages/display 都只在发送、回复完成、job 更新等真实状态变化时写入。
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
}


function newSession() {
  // 新建会话前同样不反写旧会话，避免把当前渲染态覆盖为历史。
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

function saveDisplayHistory(options = {}) {
  const includeTransient = options.includeTransient === true;
  const items = [...$('messages').querySelectorAll('.message')]
    .filter(node => includeTransient || node.dataset.persist !== '0')
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
      const item = {
        id: node.dataset.displayItemId || node.__displayItem?.id || makeDisplayItemId(),
        role: node.classList.contains('user') ? 'user' : node.classList.contains('error') ? 'error' : 'assistant',
        rawText: node.dataset.rawText || '',
        html: clone?.innerHTML || '',
        reasoningText,
        keepReasoning: node.dataset.keepReasoning === '1',
        messageIndex: node.dataset.messageIndex || '',
        responseIndex: node.dataset.responseIndex || node.__displayItem?.responseIndex || '',
        jobId: node.dataset.jobId || node.__displayItem?.jobId || '',
        imageContext: node.dataset.imageContext || '',
        pending: node.dataset.persist === '0' || node.__displayItem?.pending === '1' ? '1' : '',
      };
      if (node.__displayItem) {
        Object.assign(node.__displayItem, item);
        return node.__displayItem;
      }
      return item;
    }).slice(-80);
  const session = getActiveSession();
  session.display = compactDisplayItems(items).slice(-80);
  session.updatedAt = Date.now();
  try {
    localStorage.setItem(sessionStorageKey(UI_KEY), JSON.stringify(session.display));
    saveSessionsMeta();
  } catch (err) { console.warn('save display history failed', err); }
}


function normalizeMessageForStorage(msg) {
  if (!msg || !msg.role) return null;
  let content;
  if (typeof msg.content === 'string') content = msg.content;
  else if (Array.isArray(msg.content)) {
    content = msg.content
      .filter(part => part?.type === 'text')
      .map(part => part.text || '')
      .join('\n') || '[非文本附件消息]';
  } else {
    content = String(msg.content || '');
  }
  const out = { role: msg.role, content };
  ['html', 'rawText', 'imageContext', 'messageIndex', 'responseIndex', 'kind'].forEach(key => {
    if (msg[key] !== undefined && msg[key] !== null && msg[key] !== '') out[key] = String(msg[key]);
  });
  return out;
}

function saveChatHistory() {
  const safeMessages = compactAdjacentDuplicateMessages(activeSessionMessages());
  const session = getActiveSession();
  session.messages = safeMessages;
  state.messages = [...safeMessages];
  session.title = deriveSessionTitle(session);
  session.updatedAt = Date.now();
  localStorage.setItem(sessionStorageKey(CHAT_KEY), JSON.stringify(safeMessages));
  saveSessionsMeta();
}

function loadChatHistory({ render = false } = {}) {
  try {
    const session = getActiveSession();
    const savedCanonical = session.messages?.length ? session.messages : readJsonStorage(sessionStorageKey(CHAT_KEY), []);
    const repaired = repairMessagesFromDisplay(session);
    const savedUsers = Array.isArray(savedCanonical) ? savedCanonical.filter(m => m?.role === 'user').length : 0;
    const savedAssistants = Array.isArray(savedCanonical) ? savedCanonical.filter(m => m?.role === 'assistant').length : 0;
    const repairedUsers = repaired.filter(m => m?.role === 'user').length;
    const repairedAssistants = repaired.filter(m => m?.role === 'assistant').length;
    // canonical messages are authoritative. Only fall back to display reconstruction when
    // canonical history is empty or the display clearly contains more complete user+assistant pairs.
    const source = (Array.isArray(savedCanonical) && savedCanonical.length && savedUsers >= repairedUsers && savedAssistants >= repairedAssistants)
      ? savedCanonical
      : (repaired.length ? repaired : savedCanonical);
    if (!Array.isArray(source) || !source.length) return false;
    state.messages = compactAdjacentDuplicateMessages(source.filter(m => m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string'));
    session.messages = cloneMessageList(state.messages);
    localStorage.setItem(sessionStorageKey(CHAT_KEY), JSON.stringify(state.messages));
    if (!state.messages.length) return false;
    if (!render) return true;
    clearEmpty();
    $('messages').innerHTML = '';
    state.messages.forEach((msg, index) => renderMessageFromCanonical(session, msg, index));
    return true;
  } catch {
    localStorage.removeItem(sessionStorageKey(CHAT_KEY));
    return false;
  }
}

async function sendChat(prompt, attachments = state.attachments, loadingNode = null, options = {}) {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.chatModel) throw new Error('请先配置 Endpoint Base URL 和聊天模型');

  const sessionId = options.sessionId || state.activeSessionId;
  const session = state.sessions.find(item => item.id === sessionId) || getActiveSession();
  const baseMessages = sessionId === state.activeSessionId ? state.messages : [...(session.messages || [])];
  const requestBaseMessages = Array.isArray(options.requestBaseMessages)
    ? options.requestBaseMessages
    : options.userAlreadyAdded && baseMessages.at(-1)?.role === 'user'
      ? baseMessages.slice(0, -1)
      : baseMessages;
  const effectiveSystemPrompt = session.hasSystemPromptOverride ? (session.systemPrompt || '') : (cfg.systemPrompt || '');
  const requestMessages = buildChatMessagesWithAttachments(prompt, attachments, requestBaseMessages, effectiveSystemPrompt);
  if (sessionId === state.activeSessionId) {
    if (!options.userAlreadyAdded) state.messages.push({ role: 'user', content: prompt, rawText: prompt, messageIndex: state.messages.length });
    saveChatHistory();
  } else {
    if (!options.userAlreadyAdded) baseMessages.push({ role: 'user', content: prompt, rawText: prompt, messageIndex: baseMessages.length });
    saveSessionMessages(sessionId, baseMessages);
  }
  const inferredUserIndex = Number.isFinite(options.replaceAssistantIndex)
    ? options.replaceAssistantIndex - 1
    : Math.max(0, (sessionId === state.activeSessionId ? state.messages : baseMessages).length - 1);
  const inferredResponseIndex = inferredUserIndex + 1;
  const loading = sessionId === state.activeSessionId
    ? (loadingNode || addMessage('assistant', pendingFeedbackHtml('已收到，马上处理'), { html: true, rawText: '已收到，马上处理', skipSave: true }))
    : null;
  const liveItem = options.liveItem || appendSessionDisplayMessage(sessionId, 'assistant', pendingFeedbackHtml('已收到，马上处理'), { html: true, rawText: '已收到，马上处理', pending: true, responseIndex: inferredResponseIndex });
  if (liveItem) {
    liveItem.responseIndex = String(Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex);
    const userItem = [...(session.display || [])]
      .reverse()
      .find(entry => entry?.role === 'user' && entry.messageIndex !== '' && Number(entry.messageIndex) === inferredUserIndex);
    if (userItem) userItem.responseIndex = '';
    persistSessionDisplay(sessionId);
  }
  if (loading && liveItem) {
    if (!loading.__displayItem) loading.__displayItem = liveItem;
    if (liveItem.id) loading.dataset.displayItemId = liveItem.id;
  }

  const payload = buildChatPayload(cfg.chatModel, requestMessages, { stream: true });
  let backgroundJobId = makeClientChatJobId();
  if (backgroundJobId && liveItem) {
    liveItem.jobId = backgroundJobId;
    liveItem.responseIndex = String(Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex);
    if (!liveItem.id) liveItem.id = makeDisplayItemId();
    persistSessionDisplay(sessionId);
    if (loading) {
      loading.dataset.jobId = backgroundJobId;
      loading.dataset.responseIndex = String(Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex);
    }
  }
  if (backgroundJobId) {
    saveChatJob(sessionId, { id: backgroundJobId, prompt, payload, startedAt: Date.now(), displayItemId: liveItem?.id || '', responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex });
  }

  try {
    let lastReasoningText = '';
    let reasoningDone = false;
    let reasoningCompleteTimer = null;
    const markReasoningDone = () => {
      if (reasoningDone || !lastReasoningText) return;
      reasoningDone = true;
      if (loading?.isConnected) updateReasoning(loading, lastReasoningText, { done: true, forceScroll: Number.isFinite(options.replaceAssistantIndex), followActive: Number.isFinite(options.replaceAssistantIndex), keepReasoning: true });
      if (liveItem) {
        liveItem.reasoningText = lastReasoningText;
        liveItem.keepReasoning = true;
      }
    };
    const scheduleReasoningDone = () => {
      clearTimeout(reasoningCompleteTimer);
      reasoningCompleteTimer = setTimeout(markReasoningDone, 900);
    };
    const renderer = createRealtimeRenderer((visible) => {
      const text = visible || '正在处理…';
      if (loading?.isConnected) {
        clearPendingFeedback(loading);
        updateMessageContentLight(loading, text, { rawText: text, skipSave: true, forceScroll: Number.isFinite(options.replaceAssistantIndex), followActive: Number.isFinite(options.replaceAssistantIndex) });
      }
      updateLiveDisplay(sessionId, liveItem, 'assistant', text, { rawText: text, pending: true, forceScroll: false });
    });
    const reasoningRenderer = createRealtimeRenderer((visible) => {
      if (!state.reasoningMode) {
        if (loading?.isConnected) clearReasoning(loading);
        if (liveItem) {
          delete liveItem.reasoningText;
          liveItem.keepReasoning = false;
        }
        return;
      }
      const nextText = visible || '';
      if (nextText && nextText !== lastReasoningText) {
        lastReasoningText = nextText;
        reasoningDone = false;
        scheduleReasoningDone();
      }
      if (nextText && loading?.isConnected && loading.dataset.pendingFeedback === '1') {
        clearPendingFeedback(loading);
        updateMessageContentLight(loading, '正在思考…', { rawText: '正在思考…', skipSave: true, forceScroll: Number.isFinite(options.replaceAssistantIndex), followActive: Number.isFinite(options.replaceAssistantIndex) });
      }
      if (loading?.isConnected) updateReasoning(loading, nextText, { done: reasoningDone, forceScroll: Number.isFinite(options.replaceAssistantIndex), followActive: Number.isFinite(options.replaceAssistantIndex), keepEmpty: !!nextText });
      if (liveItem) {
        liveItem.reasoningText = nextText;
        liveItem.keepReasoning = !!nextText;
        if (nextText && isChatStatusText(liveItem.rawText || '')) {
          updateLiveDisplay(sessionId, liveItem, 'assistant', '正在思考…', { rawText: '正在思考…', pending: true, reasoning: state.reasoningMode ? nextText : undefined, forceScroll: true, followActive: true });
        }
      }
    });
    if (loading?.isConnected) {
      if (state.reasoningMode) updateReasoning(loading, '', { keepEmpty: true });
      else clearReasoning(loading);
      setPendingFeedback(loading, '正在处理，请稍等', { followActive: Number.isFinite(options.replaceAssistantIndex), forceScroll: Number.isFinite(options.replaceAssistantIndex) });
    }
    let result;
    try {
      result = await streamManagedChatCompletions(payload, cfg, backgroundJobId, (partial) => {
        renderer.set(partial.content || '');
        reasoningRenderer.set(partial.reasoning || '');
      });
    } catch (streamErr) {
      if (!state.reasoningMode || !isUnsupportedReasoningError(streamErr)) throw streamErr;
      const retryPayload = isUnsupportedXhighError(streamErr)
        ? buildChatPayload(cfg.chatModel, requestMessages, { stream: true, reasoningEffort: 'high' })
        : buildChatPayload(cfg.chatModel, requestMessages, { stream: true, reasoning: false });
      if (backgroundJobId) {
        backgroundJobId = makeClientChatJobId();
        if (liveItem) {
          liveItem.jobId = backgroundJobId;
          persistSessionDisplay(sessionId);
        }
        if (loading) loading.dataset.jobId = backgroundJobId;
        saveChatJob(sessionId, { id: backgroundJobId, prompt, payload: retryPayload, startedAt: Date.now(), displayItemId: liveItem?.id || '', responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex });
      }
      if (!isUnsupportedXhighError(streamErr)) {
        if (loading?.isConnected) clearReasoning(loading);
        if (liveItem) {
          delete liveItem.reasoningText;
          liveItem.keepReasoning = false;
        }
      }
      result = await streamManagedChatCompletions(retryPayload, cfg, backgroundJobId, (partial) => {
        renderer.set(partial.content || '');
        reasoningRenderer.set(partial.reasoning || '');
      });
    }
    clearTimeout(reasoningCompleteTimer);
    markReasoningDone();
    if (loading?.isConnected) clearPendingFeedback(loading);
    const finalReply = result.content || '没有返回内容';
    renderer.flush(finalReply);
    reasoningRenderer.cancel();
    clearTimeout(reasoningCompleteTimer);
    if (sessionId === state.activeSessionId) {
      if (Number.isFinite(options.replaceAssistantIndex) && state.messages[options.replaceAssistantIndex]?.role === 'assistant') {
        state.messages[options.replaceAssistantIndex] = { ...state.messages[options.replaceAssistantIndex], role: 'assistant', content: finalReply, rawText: finalReply, responseIndex: options.replaceAssistantIndex };
      } else if (Number.isFinite(options.replaceAssistantIndex)) {
        state.messages.splice(options.replaceAssistantIndex, 0, { role: 'assistant', content: finalReply, rawText: finalReply, responseIndex: options.replaceAssistantIndex });
      } else {
        state.messages.push({ role: 'assistant', content: finalReply, rawText: finalReply, responseIndex: inferredResponseIndex });
      }
      session.messages = cloneMessageList(state.messages);
      saveChatHistory();
      if (loading?.isConnected) {
        updateMessage(loading, finalReply, { rawText: finalReply, responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex, noScroll: Number.isFinite(options.replaceAssistantIndex) });
        finishReasoning(loading, result.reasoning || '');
      }
      updateLiveDisplay(sessionId, liveItem, 'assistant', finalReply, { rawText: finalReply, pending: false, responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex, noScroll: Number.isFinite(options.replaceAssistantIndex) });
      if (backgroundJobId) clearChatJob(sessionId);
    } else {
      baseMessages.push({ role: 'assistant', content: finalReply, rawText: finalReply, responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex });
      saveSessionMessages(sessionId, baseMessages);
      updateLiveDisplay(sessionId, liveItem, 'assistant', finalReply, { rawText: finalReply, pending: false, responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex });
      if (backgroundJobId) clearChatJob(sessionId);
    }
    playDoneSound();
  } catch (err) {
    if (state.pageUnloading && isAbortLikeError(err)) return;
    // 少数 OpenAI 兼容端点不支持 stream=true，自动降级成普通请求；刷新/返回导致的 Safari Load failed 不降级、不落错误气泡。
    let fallbackPayload = buildChatPayload(cfg.chatModel, requestMessages, { stream: false });
    if (loading?.isConnected) setPendingFeedback(loading, '响应有点慢，正在继续尝试', { followActive: Number.isFinite(options.replaceAssistantIndex), forceScroll: Number.isFinite(options.replaceAssistantIndex) });
    let data;
    try {
      data = await requestJson(`${cfg.baseUrl}/chat/completions`, fallbackPayload, cfg.apiKey);
    } catch (fallbackErr) {
      if (!state.reasoningMode || !isUnsupportedReasoningError(fallbackErr)) throw fallbackErr;
      fallbackPayload = isUnsupportedXhighError(fallbackErr)
        ? buildChatPayload(cfg.chatModel, requestMessages, { stream: false, reasoningEffort: 'high' })
        : buildChatPayload(cfg.chatModel, requestMessages, { stream: false, reasoning: false });
      data = await requestJson(`${cfg.baseUrl}/chat/completions`, fallbackPayload, cfg.apiKey);
    }
    if (loading?.isConnected) clearPendingFeedback(loading);
    const reply = data?.choices?.[0]?.message?.content || data?.output_text || `流式失败，且普通请求没有返回内容：${err.message || err}`;
    if (sessionId === state.activeSessionId) {
      if (Number.isFinite(options.replaceAssistantIndex) && state.messages[options.replaceAssistantIndex]?.role === 'assistant') {
        state.messages[options.replaceAssistantIndex] = { ...state.messages[options.replaceAssistantIndex], role: 'assistant', content: reply, rawText: reply, responseIndex: options.replaceAssistantIndex };
      } else if (Number.isFinite(options.replaceAssistantIndex)) {
        state.messages.splice(options.replaceAssistantIndex, 0, { role: 'assistant', content: reply, rawText: reply, responseIndex: options.replaceAssistantIndex });
      } else {
        state.messages.push({ role: 'assistant', content: reply, rawText: reply, responseIndex: inferredResponseIndex });
      }
      session.messages = cloneMessageList(state.messages);
      saveChatHistory();
      if (loading?.isConnected) {
        updateMessage(loading, reply, { rawText: reply, responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex, noScroll: Number.isFinite(options.replaceAssistantIndex) });
        finishReasoning(loading, normalizeReasoningText(data?.choices?.[0]?.message?.reasoning_content || data?.choices?.[0]?.message?.reasoning || data?.choices?.[0]?.message?.thinking || data?.choices?.[0]?.message?.reasoning_details || data?.reasoning_content || data?.reasoning || data?.thinking || data?.reasoning_details || data?.output?.filter?.(item => /reason/i.test(String(item?.type || item?.role || '')) || item?.summary || item?.reasoning || item?.thinking) || ''));
      }
      updateLiveDisplay(sessionId, liveItem, 'assistant', reply, { rawText: reply, pending: false, responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex, noScroll: Number.isFinite(options.replaceAssistantIndex) });
      if (backgroundJobId) clearChatJob(sessionId);
    } else {
      baseMessages.push({ role: 'assistant', content: reply, rawText: reply, responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex });
      saveSessionMessages(sessionId, baseMessages);
      updateLiveDisplay(sessionId, liveItem, 'assistant', reply, { rawText: reply, pending: false, responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : inferredResponseIndex });
      if (backgroundJobId) clearChatJob(sessionId);
    }
    playDoneSound();
  }
}

function createRealtimeRenderer(onUpdate) {
  let latest = '';
  let scheduled = false;
  let cancelled = false;
  let frameId = null;

  return {
    set(next) {
      if (cancelled) return;
      latest = String(next || '');
      if (scheduled) return;
      scheduled = true;
      frameId = requestAnimationFrame(() => {
        scheduled = false;
        frameId = null;
        if (!cancelled) onUpdate(latest);
      });
    },
    flush(finalText) {
      if (cancelled) return;
      latest = String(finalText || '');
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      scheduled = false;
      onUpdate(latest);
    },
    cancel() {
      cancelled = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
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

function normalizeReasoningText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => normalizeReasoningText(item?.text || item?.content || item?.summary || item?.reasoning || item?.thinking || item)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    return normalizeReasoningText(value.text || value.content || value.summary || value.reasoning || value.thinking || value.reasoning_content || value.thinking_content || value.reasoning_details || value.output_text || '');
  }
  return String(value || '');
}

function extractStreamDelta(data) {
  const choice = data?.choices?.[0];
  const delta = choice?.delta || {};
  const message = choice?.message || {};

  const reasoning = normalizeReasoningText(
    delta.reasoning_content
    || delta.reasoning
    || delta.thinking
    || delta.reasoning_details
    || delta.thinking_content
    || message.reasoning_content
    || message.reasoning
    || message.thinking
    || message.reasoning_details
    || message.thinking_content
    || data?.reasoning_content
    || data?.reasoning
    || data?.thinking
    || data?.reasoning_details
    || data?.thinking_content
    || ''
  );

  let content = delta.content
    || message.content
    || (typeof data?.delta === 'string' ? data.delta : '')
    || (typeof data?.content === 'string' ? data.content : '')
    || '';

  if (!content && Array.isArray(data?.output)) {
    content = data.output.map(item => item?.content?.map(c => c?.text || '').join('') || '').join('');
  }

  const outputReasoning = !reasoning && Array.isArray(data?.output)
    ? normalizeReasoningText(data.output.filter(item => /reason/i.test(String(item?.type || item?.role || '')) || item?.summary || item?.reasoning || item?.thinking))
    : '';

  return { content, reasoning: reasoning || outputReasoning };
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
  if (loading && liveItem) {
    if (!loading.__displayItem) loading.__displayItem = liveItem;
    if (liveItem.id) loading.dataset.displayItemId = liveItem.id;
  }

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
    } else if (!imageRefs.length && options.editMode && options.editTarget === 'uploaded') {
      imageRefs = await restoreImageAttachmentsFromContext(options.imageContext || getLatestUploadedImageContext(sessionId) || {});
      if (!imageRefs.length) throw new Error('上一张上传图片的缓存已丢失，请重新上传图片后再修改');
      if (loading?.isConnected) updateMessage(loading, '已准备上一张上传图片，正在发送修改请求…', { rawText: '已准备上一张上传图片，正在发送修改请求…', skipSave: true });
      updateLiveDisplay(sessionId, liveItem, 'assistant', '已准备上一张上传图片，正在发送修改请求…', { rawText: '已准备上一张上传图片，正在发送修改请求…', pending: true });
    } else if (!imageRefs.length && options.editMode) {
      throw new Error('没有可编辑的图片，请先上传图片，或明确说明要基于上一张图修改');
    }
    const persistedImageRefs = await persistImageAttachmentRefs(imageRefs);
    const imageContext = {
      prompt,
      mode: imageRefs.length ? 'edit_image' : 'image',
      target: usedPreviousImage ? 'previous' : (imageRefs.length ? (options.editTarget || 'uploaded') : 'new'),
      usePreviousImage: usedPreviousImage || !!options.imageContext?.usePreviousImage,
      attachments: persistedImageRefs,
    };
    const imageContextRaw = JSON.stringify(normalizeImageContextForStorage(imageContext));
    if (liveItem) {
      liveItem.imageContext = imageContextRaw;
      persistSessionDisplay(sessionId);
    }
    if (loading?.isConnected) {
      setImageContext(loading, imageContext);
      setPendingFeedback(loading, '正在处理，请稍等');
    }
    startImageTimer(imageRefs.length ? '正在修改图片' : '正在生成图片');
    let data;
    if (imageRefs.length) {
      const jobId = makeClientImageJobId();
      const jobFiles = await imageFilesToJobPayload(imageRefs);
      saveImageJob(sessionId, { id: jobId, prompt, payload, mode: 'edit_image', imageContext, startedAt: Date.now(), displayItemId: liveItem?.id || '', liveItemRawText: liveItem?.rawText || '' });
      const job = await startImageGenerationJob(payload, cfg, jobId, { mode: 'edit_image', files: jobFiles });
      saveImageJob(sessionId, { id: job.id, prompt, payload, mode: 'edit_image', imageContext, startedAt: job.createdAt || Date.now(), displayItemId: liveItem?.id || '', liveItemRawText: liveItem?.rawText || '' });
      data = await waitImageGenerationJob(job.id);
      clearImageJob(sessionId);
    } else {
      const jobId = makeClientImageJobId();
      saveImageJob(sessionId, { id: jobId, prompt, payload, mode: 'image', imageContext, startedAt: Date.now(), displayItemId: liveItem?.id || '', liveItemRawText: liveItem?.rawText || '' });
      const job = await startImageGenerationJob(payload, cfg, jobId);
      saveImageJob(sessionId, { id: job.id, prompt, payload, mode: 'image', imageContext, startedAt: job.createdAt || Date.now(), displayItemId: liveItem?.id || '', liveItemRawText: liveItem?.rawText || '' });
      data = await waitImageGenerationJob(job.id);
      clearImageJob(sessionId);
    }
    const elapsedText = formatElapsed(performance.now() - requestStart);
    const result = await imageResultToHtml(data, elapsedText, { prompt, sessionId });
    if (usedPreviousImage || imageContext.mode === 'edit_image') result.html = result.html.replace('生成完成', usedPreviousImage ? '基于上一张图修改完成' : '图片修改完成');
    const assistantText = usedPreviousImage ? `[图片编辑完成] ${prompt}` : `[图片生成完成] ${prompt}`;
    if (sessionId === state.activeSessionId) {
      const finalResponseIndex = Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : state.messages.length;
      if (liveItem) {
        updateSessionDisplayItem(sessionId, liveItem, 'assistant', result.html, { html: true, rawText: `${result.raw}
耗时：${elapsedText}`, pending: false, responseIndex: finalResponseIndex });
        liveItem.imageContext = imageContextRaw;
      }
      if (loading?.isConnected) {
        updateMessage(loading, result.html, { html: true, rawText: `${result.raw}
耗时：${elapsedText}`, responseIndex: finalResponseIndex });
        setImageContext(loading, imageContext);
      } else if (!liveItem) appendSessionDisplayMessage(sessionId, 'assistant', result.html, { html: true, rawText: `${result.raw}
耗时：${elapsedText}`, pending: false, responseIndex: finalResponseIndex, imageContext: imageContextRaw });
      if (!options.userAlreadyAdded) state.messages.push({ role: 'user', content: prompt, rawText: prompt, messageIndex: state.messages.length });
      if (Number.isFinite(options.replaceAssistantIndex) && state.messages[options.replaceAssistantIndex]?.role === 'assistant') {
        state.messages[options.replaceAssistantIndex] = { ...state.messages[options.replaceAssistantIndex], role: 'assistant', content: assistantText, html: result.html, rawText: `${result.raw}\n耗时：${elapsedText}`, responseIndex: options.replaceAssistantIndex, imageContext: imageContextRaw, kind: imageContext.mode };
      } else if (Number.isFinite(options.replaceAssistantIndex)) {
        state.messages.splice(options.replaceAssistantIndex, 0, { role: 'assistant', content: assistantText, html: result.html, rawText: `${result.raw}\n耗时：${elapsedText}`, responseIndex: options.replaceAssistantIndex, imageContext: imageContextRaw, kind: imageContext.mode });
      } else {
        state.messages.push({ role: 'assistant', content: assistantText, html: result.html, rawText: `${result.raw}\n耗时：${elapsedText}`, responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : state.messages.length, imageContext: imageContextRaw, kind: imageContext.mode });
      }
      session.messages = cloneMessageList(state.messages);
      saveChatHistory();
    } else {
      if (!options.userAlreadyAdded) baseMessages.push({ role: 'user', content: prompt, rawText: prompt, messageIndex: baseMessages.length });
      baseMessages.push({ role: 'assistant', content: assistantText, html: result.html, rawText: `${result.raw}\n耗时：${elapsedText}`, responseIndex: Number.isFinite(options.replaceAssistantIndex) ? options.replaceAssistantIndex : baseMessages.length, imageContext: imageContextRaw, kind: imageContext.mode });
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
  const isEditJob = saved.mode === 'edit_image' || saved.imageContext?.mode === 'edit_image' || (Array.isArray(saved.imageContext?.attachments) && saved.imageContext.attachments.length > 0);
  let liveItem = saved.displayItemId ? (session.display || []).find(item => item.id === saved.displayItemId) || null : null;
  if (!liveItem) liveItem = takePendingLiveItem(sessionId, isEditJob ? '正在恢复图片修改任务…' : '正在恢复图片生成任务…', /正在生成图片|正在修改图片|正在恢复图片生成任务|正在恢复图片修改任务|已收到/);
  if (liveItem && saved.imageContext) {
    liveItem.imageContext = JSON.stringify(normalizeImageContextForStorage(saved.imageContext));
    liveItem.jobId = saved.id || liveItem.jobId || '';
    persistSessionDisplay(sessionId);
  }
  setSessionBusy(sessionId, true);
  const start = saved.startedAt || Date.now();
  const label = isEditJob ? '正在修改图片' : '正在生成图片';
  const tick = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    updateLiveDisplay(sessionId, liveItem, 'assistant', `${label}… 已等待 ${seconds} 秒`, { rawText: `${label}… 已等待 ${seconds} 秒`, pending: true });
  };
  const timer = setInterval(tick, 1000);
  tick();
  try {
    const cfg = getConfig();
    let data;
    if (isEditJob) {
      try {
        data = (await getImageGenerationJob(saved.id)).data;
      } catch (err) {
        if (!isMissingJobError(err)) throw err;
      }
      if (!data) {
        const imageRefs = await restoreImageAttachmentsFromContext(saved.imageContext || {});
        if (!imageRefs.length) throw new Error('恢复图片修改任务失败：附件信息已丢失，请重新上传图片');
        const jobFiles = await imageFilesToJobPayload(imageRefs);
        await startImageGenerationJob(saved.payload, cfg, saved.id, { mode: 'edit_image', files: jobFiles });
        data = await waitImageGenerationJob(saved.id, tick);
      }
    } else {
      if (saved.payload && cfg.baseUrl) await startImageGenerationJob(saved.payload, cfg, saved.id);
      data = await waitImageGenerationJob(saved.id, tick);
    }
    const elapsedText = formatElapsed(Date.now() - start);
    const result = await imageResultToHtml(data, elapsedText, { prompt: saved.prompt || '', sessionId });
    if (isEditJob) result.html = result.html.replace('生成完成', saved.imageContext?.usePreviousImage ? '基于上一张图修改完成' : '图片修改完成');
    updateSessionDisplayItem(sessionId, liveItem, 'assistant', result.html, { html: true, rawText: `${result.raw}\n耗时：${elapsedText}`, pending: false });
    if (sessionId === state.activeSessionId) {
      const node = findMessageNodeByDisplayItem(liveItem);
      if (node) {
        updateMessage(node, result.html, { html: true, rawText: `${result.raw}\n耗时：${elapsedText}` });
        if (saved.imageContext) setImageContext(node, saved.imageContext);
      }
    }
    const assistantText = `${isEditJob ? '[图片编辑完成]' : '[图片生成完成]'} ${saved.prompt || ''}`;
    const baseMessages = trimAssistantTailDuplicate([...(session.messages || []), { role: 'assistant', content: assistantText }], assistantText);
    saveSessionMessages(sessionId, baseMessages);
    clearImageJob(sessionId);
    playDoneSound();
  } catch (err) {
    clearImageJob(sessionId);
    const message = isMissingJobError(err)
      ? '恢复任务不存在或已失效，已停止恢复，请重新发送'
      : (err?.message || String(err));
    if (isMissingJobError(err)) cleanupStalePendingDisplay(sessionId, /正在生成图片|正在修改图片|正在恢复图片生成任务|正在恢复图片修改任务|已收到/, message);
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
  const saved = loadLatestChatJob(sessionId);
  if (!saved?.id) { state.resumingJobs.delete(resumeKey); return; }
  if (state.followingChatJobs.has(saved.id)) { state.resumingJobs.delete(resumeKey); return; }
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) { clearChatJob(sessionId); state.resumingJobs.delete(resumeKey); return; }
  let liveItem = takeChatJobLiveItem(sessionId, saved, '正在恢复聊天任务…', /正在处理|正在思考|正在恢复聊天任务|已收到/);
  if (liveItem) {
    if (saved.id && !liveItem.jobId) liveItem.jobId = saved.id;
    if (saved.responseIndex !== undefined && saved.responseIndex !== null && liveItem.responseIndex === '') liveItem.responseIndex = String(saved.responseIndex);
    persistSessionDisplay(sessionId);
  }
  setSessionBusy(sessionId, true);
  const start = saved.startedAt || Date.now();
  let hasOutput = !!String(liveItem?.rawText || '').trim() && !isChatStatusText(liveItem.rawText || '');
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
        hasOutput = !!(partial.content || partial.reasoning) || hasOutput;
        const visibleText = partial.content || '正在思考…';
        updateLiveDisplay(sessionId, liveItem, 'assistant', visibleText, { rawText: visibleText, pending: true, reasoning: state.reasoningMode ? partial.reasoning : undefined, forceScroll: true, followActive: true });
      } else if (!hasOutput) {
        tick();
      }
    };
    const resolveSnapshot = (job) => {
      if (!job) return null;
      onJobUpdate(job);
      if (job.status === 'done') return job.data;
      if (job.status === 'error') throw new Error(job.error?.message || '任务失败');
      return null;
    };
    // 刷新/切换恢复时，先登记并立即拉取当前 job 快照，再接 SSE。
    // 这样首屏能马上显示后端已累计的最新内容，而不是停留在本地 pending 文案。
    let data = null;
    let snapshotErr = null;
    try {
      data = resolveSnapshot(await getChatJob(saved.id));
    } catch (err) {
      snapshotErr = err;
    }
    if (!data && saved.payload && cfg.baseUrl) {
      const registeredJob = await registerChatStreamJob(saved.payload, cfg, saved.id, { start: true });
      data = resolveSnapshot(registeredJob);
      snapshotErr = null;
    }
    if (!data && snapshotErr && isMissingJobError(snapshotErr)) throw snapshotErr;
    if (!data) data = await waitChatJob(saved.id, onJobUpdate);
    const final = extractChatJobText(data);
    const reply = final.content || '没有返回内容';
    const reasoning = final.reasoning || '';
    updateSessionDisplayItem(sessionId, liveItem, 'assistant', reply, { rawText: reply, pending: false });
    if (sessionId === state.activeSessionId) {
      const node = findMessageNodeByDisplayItem(liveItem);
      if (node) {
        updateMessage(node, reply, { rawText: reply, noScroll: true });
        finishReasoning(node, reasoning);
      }
    }
    const rawResponseIndex = liveItem?.responseIndex !== '' && liveItem?.responseIndex !== undefined
      ? liveItem.responseIndex
      : saved.responseIndex;
    const responseIndex = rawResponseIndex !== null && rawResponseIndex !== undefined && rawResponseIndex !== '' ? Number(rawResponseIndex) : NaN;
    if (Number.isFinite(responseIndex) && !Number.isNaN(responseIndex) && replaceAssistantMessageAt(sessionId, responseIndex, reply)) {
      // 已按原位置回填历史。
    } else {
      const baseMessages = trimAssistantTailDuplicate([...(session.messages || []), { role: 'assistant', content: reply }], reply);
      saveSessionMessages(sessionId, baseMessages);
    }
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
    state.resumingJobs.delete(resumeKey);
  }
}


function resumeSessionJobs(sessionId = state.activeSessionId) {
  if (!sessionId) return;
  const imageJob = loadImageJob(sessionId);
  const chatJob = loadLatestChatJob(sessionId);
  if (imageJob) setTimeout(() => resumeImageJob(sessionId), 0);
  // 已有完整 canonical 历史时，不允许旧 display/job 恢复流程覆盖 DOM。
  const session = state.sessions.find(item => item.id === sessionId);
  const completePairs = Array.isArray(session?.messages)
    && session.messages.filter(m => m?.role === 'user').length > 0
    && session.messages.filter(m => m?.role === 'assistant').length >= session.messages.filter(m => m?.role === 'user').length;
  if (chatJob && !completePairs) setTimeout(() => resumeChatJob(sessionId), 0);
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
  tpl.content.querySelectorAll('table').forEach(table => {
    if (table.parentElement?.classList.contains('table-wrap')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrap';
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  });
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
    btn.innerHTML = COPY_ICON_SVG;
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
    const copyIcon = `<button class="inline-copy code-copy-icon" type="button" title="复制代码" aria-label="复制代码" data-copy-text="${escapeAttr(block.raw)}">${COPY_ICON_SVG}</button>`;
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
  const latestUploadedImage = getLatestUploadedImageContext(sessionId);
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
    latest_uploaded_image: latestUploadedImage ? {
      prompt: String(latestUploadedImage.prompt || '').slice(0, 800),
      count: latestUploadedImage.attachments?.length || 0,
      target: latestUploadedImage.target || 'uploaded',
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
  if (!attachments.length && looksLikeImageEditInstruction(prompt) && getLatestUploadedImageContext(sessionId)) {
    return normalizeRoute({ mode: 'edit_image', target: 'uploaded', use_previous_image: false, confidence: 0.9, evidence: '当前输入是承接上一张用户上传图的图片修改指令' }, 'chat');
  }
  // 自动模式下统一交给聊天模型做结构化路由；上一张图和上一张上传图只作为候选上下文。
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
7. 如果最近上下文里存在 latest_uploaded_image，且当前输入是“换个图标/改一下/替换/调整/优化”等承接式图片修改指令，应判为 mode=edit_image、target=uploaded、use_previous_image=false。
8. 如果不确定是否承接历史图片，必须优先判为 target=new 或 target=none，不要使用 previous。
9. 输出只允许 JSON。`,
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
  if (!prompt && !state.attachments.length) return;
  unlockDoneSound();
  saveConfig(true);

  const runSessionId = state.activeSessionId;
  const submittedAttachments = [...state.attachments];
  await prepareUserAttachmentPreviews(submittedAttachments);
  const displayIndex = state.mode === 'chat' ? state.messages.length : null;
  const editingCandidate = state.editingIndex !== null && state.editingNode && state.mode === 'chat';
  let editResult = null;
  if (editingCandidate) editResult = applyPendingEdit(prompt);
  if (!editResult) {
    const displayPrompt = prompt || '已发送附件';
    const userHtml = renderUserMessageWithAttachments(displayPrompt, submittedAttachments);
    const rawUserContent = buildUserMessageContent(prompt, submittedAttachments);
    const apiUserContent = buildUserApiContent(prompt, submittedAttachments);
    const userNode = addMessage('user', userHtml, { html: true, rawText: rawUserContent, messageIndex: displayIndex });
    const userItem = appendSessionDisplayMessage(runSessionId, 'user', userHtml, { html: true, rawText: rawUserContent, messageIndex: displayIndex });
    const uploadedImageContext = await buildUploadedImageContext(prompt, submittedAttachments);
    const uploadedImageContextRaw = uploadedImageContext ? JSON.stringify(uploadedImageContext) : '';
    if (uploadedImageContextRaw) {
      userItem.imageContext = uploadedImageContextRaw;
      userNode.dataset.imageContext = uploadedImageContextRaw;
      persistSessionDisplay(runSessionId);
    }
    userNode.__displayItem = userItem;
    if (userItem?.id) userNode.dataset.displayItemId = userItem.id;
    state.messages.push({ role: 'user', content: apiUserContent, html: userHtml, rawText: rawUserContent, messageIndex: displayIndex, ...(uploadedImageContextRaw ? { imageContext: uploadedImageContextRaw } : {}) });
    getActiveSession().messages = cloneMessageList(state.messages);
  }
  saveChatHistory();
  $('prompt').value = '';
  clearAttachments();
  scheduleAutoResize();
  setSessionBusy(runSessionId, true);

  const session = getActiveSession();
  let liveItem = null;
  let immediateFeedback;
  if (editResult) {
    const replacement = prepareReplacementResponse(editResult, runSessionId);
    immediateFeedback = replacement.node;
    liveItem = replacement.liveItem;
  } else {
    immediateFeedback = addMessage('assistant', pendingFeedbackHtml('已收到，马上处理'), { html: true, rawText: '已收到，马上处理', skipSave: true });
    if (session) {
      liveItem = appendSessionDisplayMessage(runSessionId, 'assistant', pendingFeedbackHtml('已收到，马上处理'), { html: true, rawText: '已收到，马上处理', pending: true, responseIndex: state.messages.length });
      immediateFeedback.__displayItem = liveItem;
    }
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
    if (effectiveMode === 'chat') await sendChat(prompt, submittedAttachments, immediateFeedback, { sessionId: runSessionId, userAlreadyAdded: true, liveItem, replaceAssistantIndex: editResult?.responseIndex, requestBaseMessages: editResult ? state.messages.slice(0, editResult.index) : null });
    else await sendImage(prompt, {
      loadingNode: immediateFeedback,
      editMode: effectiveMode === 'edit_image',
      editTarget: effectiveRoute.target,
      usePreviousImage: effectiveRoute.usePreviousImage,
      attachments: submittedAttachments,
      imageContext: effectiveRoute.target === 'uploaded' ? getLatestUploadedImageContext(runSessionId) : null,
      sessionId: runSessionId,
      userAlreadyAdded: true,
      liveItem,
      replaceAssistantIndex: editResult?.responseIndex,
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

function updateComposerSafeArea() {
  const composer = $('composer');
  const messages = $('messages');
  if (!composer || !messages) return;
  const rect = composer.getBoundingClientRect();
  const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 0;
  const safeBottom = Math.ceil(Math.max(120, viewportHeight - rect.top + 28));
  document.documentElement.style.setProperty('--composer-safe-bottom', `${safeBottom}px`);
  messages.style.scrollPaddingBottom = `${safeBottom}px`;
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
  updateComposerSafeArea();
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

  $('messages').innerHTML = '';
  renderEmptyWelcome();
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

function reasoningTypeText(type = state.reasoningType) {
  return ({ low: '快速', medium: '标准', high: '深度', xhigh: '最强' })[type] || '标准';
}

function reasoningProviderText(provider = state.reasoningProvider) {
  return ({
    auto: '自动',
    openai: 'OpenAI',
    anthropic: 'Claude',
    google: 'Google',
    'thinking-budget': 'Qwen 兼容',
    generic: '通用',
  })[provider] || '自动';
}

function updateReasoningControls() {
  $('reasoningToggle')?.classList.toggle('active', !!state.reasoningMode);
  $('reasoningToggle')?.setAttribute('aria-pressed', String(!!state.reasoningMode));
  if ($('reasoningTypeLabel')) $('reasoningTypeLabel').textContent = reasoningTypeText();
  if ($('reasoningProviderLabel')) $('reasoningProviderLabel').textContent = reasoningProviderText();
  document.querySelectorAll('[data-reasoning-type]')?.forEach(btn => {
    const active = btn.dataset.reasoningType === state.reasoningType;
    btn.classList.toggle('selected', active);
    btn.setAttribute('aria-checked', String(active));
  });
  document.querySelectorAll('[data-reasoning-provider]')?.forEach(btn => {
    const active = btn.dataset.reasoningProvider === state.reasoningProvider;
    btn.classList.toggle('selected', active);
    btn.setAttribute('aria-checked', String(active));
  });
}

function setReasoningMode(enabled) {
  state.reasoningMode = !!enabled;
  localStorage.setItem(REASONING_MODE_KEY, state.reasoningMode ? '1' : '0');
  updateReasoningControls();
}

function setReasoningType(type = 'medium') {
  state.reasoningType = ['low', 'medium', 'high', 'xhigh'].includes(type) ? type : 'medium';
  localStorage.setItem(REASONING_TYPE_KEY, state.reasoningType);
  updateReasoningControls();
}

function normalizeReasoningProvider(provider = 'auto') {
  return ['auto', 'openai', 'anthropic', 'google', 'thinking-budget', 'generic'].includes(provider) ? provider : 'auto';
}

function setReasoningProvider(provider = 'auto') {
  state.reasoningProvider = normalizeReasoningProvider(provider);
  localStorage.setItem(REASONING_PROVIDER_KEY, state.reasoningProvider);
  updateReasoningControls();
}

function loadReasoningPreference() {
  state.reasoningMode = localStorage.getItem(REASONING_MODE_KEY) === '1';
  state.reasoningType = localStorage.getItem(REASONING_TYPE_KEY) || state.reasoningType || 'medium';
  state.reasoningProvider = normalizeReasoningProvider(localStorage.getItem(REASONING_PROVIDER_KEY) || state.reasoningProvider || 'auto');
  state.reasoningPersist = localStorage.getItem(REASONING_PERSIST_KEY) !== '0';
  updateReasoningControls();
}

function openReasoningMenu() {
  const menu = $('reasoningMenu');
  const btn = $('reasoningMenuBtn');
  if (!menu) return;
  menu.classList.add('show');
  menu.setAttribute('aria-hidden', 'false');
  btn?.setAttribute('aria-expanded', 'true');
}

function closeReasoningMenu() {
  const menu = $('reasoningMenu');
  const btn = $('reasoningMenuBtn');
  if (!menu) return;
  menu.classList.remove('show');
  menu.setAttribute('aria-hidden', 'true');
  btn?.setAttribute('aria-expanded', 'false');
}

function toggleReasoningMenu() {
  const menu = $('reasoningMenu');
  if (menu?.classList.contains('show')) closeReasoningMenu();
  else openReasoningMenu();
}

$('reasoningToggle')?.addEventListener('click', () => setReasoningMode(!state.reasoningMode));
$('reasoningMenuBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleReasoningMenu();
});
document.querySelectorAll('[data-reasoning-type]')?.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setReasoningType(btn.dataset.reasoningType);
    if (!state.reasoningMode) setReasoningMode(true);
    closeReasoningMenu();
  });
});
document.querySelectorAll('[data-reasoning-provider]')?.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setReasoningProvider(btn.dataset.reasoningProvider);
    if (!state.reasoningMode) setReasoningMode(true);
    closeReasoningMenu();
  });
});
document.addEventListener('click', closeReasoningMenu);
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
window.visualViewport?.addEventListener('resize', () => { scheduleAutoResize(); scrollToBottom(false); });
window.addEventListener('resize', () => {
  scheduleAutoResize();
});
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
$('sessionPromptLoadGlobalBtn')?.addEventListener('click', loadGlobalPromptToSessionInput);
$('sessionPromptClearBtn')?.addEventListener('click', clearSessionPromptInput);
$('sessionPromptCancelBtn')?.addEventListener('click', closeSessionPromptPanel);
$('sessionPromptSaveBtn')?.addEventListener('click', saveSessionPrompt);
$('sessionPromptBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('sessionPromptPanel');
  if (panel?.classList.contains('show')) closeSessionPromptPanel();
  else openSessionPromptPanel();
});
document.addEventListener('click', (e) => {
  const panel = $('sessionPromptPanel');
  if (panel?.classList.contains('show') && !panel.contains(e.target) && e.target.id !== 'sessionPromptBtn' && !$('sessionPromptBtn')?.contains(e.target)) {
    closeSessionPromptPanel();
  }
});
$('closeConfigBtn').addEventListener('click', closeConfigModal);
document.querySelectorAll('[data-close-modal]').forEach(el => el.addEventListener('click', closeConfigModal));
document.addEventListener('click', () => closeAllCustomSelects());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeAllCustomSelects(); closeConfigModal(); closeImagePreview(); }
});

enhanceConfigSelects();
loadConfig();
loadAppVersion();
loadReasoningPreference();
loadSessions();
loadSessionSidebarCollapsed();
loadLastGeneratedImage();
renderActiveSession();
updateSendAvailability();
updateModeUi(state.mode, state.autoMode);
requestAnimationFrame(() => document.body.classList.remove('app-booting'));

function persistBeforePageLeave() {
  state.pageUnloading = true;
  // 页面卸载时不再反写 DOM 到缓存；历史与 display 在真实状态变化时已保存。
}

window.addEventListener('beforeunload', persistBeforePageLeave);
window.addEventListener('pagehide', persistBeforePageLeave);
