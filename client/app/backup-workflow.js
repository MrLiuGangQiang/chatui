(function initChatUIAppBackupWorkflow(root) {
  'use strict';

  const BACKUP_FORMAT = 'chatui-backup';
  const BACKUP_VERSION = 5;
  const PORTABLE_MEDIA_VERSION = 2;
  const SUPPORTED_BACKUP_VERSIONS = new Set([1, PORTABLE_MEDIA_VERSION, 3, 4, BACKUP_VERSION]);
  // Media is encoded in the JSON archive, so allow normal image/file backups
  // while still bounding a malformed import before it is read into memory.
  const MAX_BACKUP_FILE_BYTES = 200 * 1024 * 1024;
  const MAX_BACKUP_SESSIONS = 2000;
  const MAX_BACKUP_MEDIA_ITEMS = 10000;

  function cloneJson(value, fallback = null) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
  }

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function asText(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function safeDatePart(value) {
    return String(value).padStart(2, '0');
  }

  function backupFileName(now = new Date()) {
    return `chatui-backup-${now.getFullYear()}${safeDatePart(now.getMonth() + 1)}${safeDatePart(now.getDate())}-${safeDatePart(now.getHours())}${safeDatePart(now.getMinutes())}${safeDatePart(now.getSeconds())}.json`;
  }

  function normalizeMediaKey(value, index = 0) {
    const key = asText(value).trim();
    if (!key || key.length > 300 || /[\u0000-\u001f\s]/.test(key)) {
      throw new Error(`第 ${index + 1} 个媒体文件缺少有效 ID`);
    }
    return key;
  }

  function isBase64DataUrl(value) {
    return typeof value === 'string'
      && /^data:[^,]*;base64,[a-z0-9+/]*={0,2}$/i.test(value);
  }

  function normalizeBackupMedia(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error('备份文件中的附件或图片数据格式不正确');
    if (value.length > MAX_BACKUP_MEDIA_ITEMS) throw new Error(`备份文件媒体数量超过 ${MAX_BACKUP_MEDIA_ITEMS} 个`);
    const keys = new Set();
    return value.map((item, index) => {
      if (!isRecord(item)) throw new Error(`第 ${index + 1} 个媒体文件格式不正确`);
      const key = normalizeMediaKey(item.key, index);
      if (keys.has(key)) throw new Error('备份文件包含重复的媒体文件 ID');
      if (!isBase64DataUrl(item.dataUrl)) throw new Error(`第 ${index + 1} 个媒体文件无法读取`);
      keys.add(key);
      return { key, dataUrl: item.dataUrl };
    });
  }

  function normalizeImportedSession(value, index = 0) {
    if (!isRecord(value)) throw new Error(`第 ${index + 1} 个会话格式不正确`);
    const id = asText(value.id).trim();
    if (!id || id.length > 200) throw new Error(`第 ${index + 1} 个会话缺少有效 ID`);
    if (!Array.isArray(value.messages)) throw new Error(`第 ${index + 1} 个会话缺少消息记录`);
    const messages = repairImportedMediaMarkup(cloneJson(value.messages, null));
    if (!Array.isArray(messages)) throw new Error(`第 ${index + 1} 个会话消息无法读取`);
    return {
      id,
      title: asText(value.title, '新对话').slice(0, 200),
      customTitle: asText(value.customTitle).slice(0, 200),
      systemPrompt: asText(value.systemPrompt),
      hasSystemPromptOverride: !!value.hasSystemPromptOverride,
      imageStylePrompt: asText(value.imageStylePrompt),
      hasImageStylePromptOverride: !!value.hasImageStylePromptOverride,
      promptDraft: asText(value.promptDraft).slice(0, 20000),
      reasoningMode: value.reasoningMode === undefined || value.reasoningMode === null ? undefined : !!value.reasoningMode,
      reasoningType: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.reasoningType) ? value.reasoningType : '',
      pendingClarification: isRecord(value.pendingClarification) ? repairImportedMediaMarkup(cloneJson(value.pendingClarification, null)) : null,
      createdAt: Number(value.createdAt) || Date.now(),
      updatedAt: Number(value.updatedAt) || Date.now(),
      snapshotUpdatedAt: 0,
      persistenceUpdatedAt: 0,
      messages,
      // Running jobs cannot safely continue after an export/import boundary.
      display: [],
      lastGeneratedImage: repairImportedMediaMarkup(cloneJson(value.lastGeneratedImage, null)),
      busy: false,
    };
  }

  function backupShapeText(value) {
    if (!isRecord(value)) return Array.isArray(value) ? 'array' : typeof value;
    const keys = Object.keys(value).slice(0, 8);
    return keys.length ? keys.join(', ').slice(0, 160) : 'empty object';
  }

  function unsupportedBackupError(backup) {
    const format = isRecord(backup) && backup.format !== undefined ? String(backup.format).slice(0, 80) : 'missing';
    const version = isRecord(backup) && backup.version !== undefined ? String(backup.version).slice(0, 40) : 'missing';
    return new Error(`这不是受支持的 ChatUI 备份文件（检测到 format=${format}、version=${version}，字段：${backupShapeText(backup)}）`);
  }

  function unwrapBackup(backup) {
    if (!isRecord(backup)) return backup;
    // A few local builds and download helpers wrapped the archive in a named
    // property. Unwrap only objects that still contain a session list so an
    // arbitrary configuration object can never be mistaken for a backup.
    for (const key of ['backup', 'archive', 'data']) {
      if (isRecord(backup[key]) && Array.isArray(backup[key].sessions)) return backup[key];
    }
    return backup;
  }

  function normalizeBackupVersion(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = asText(value).trim().replace(/^v/i, '');
    return /^\d+(?:\.0+)?$/.test(text) ? Number(text) : NaN;
  }

  function repairImportedMediaMarkup(value) {
    if (typeof value === 'string') {
      // Older snapshots sometimes stored an HTML string after JSON escaping
      // it twice. The stray backslash becomes part of the IndexedDB key.
      return value.includes('indexeddb://') && value.includes('\\"')
        ? value.replace(/\\"/g, '"')
        : value;
    }
    if (Array.isArray(value)) return value.map(item => repairImportedMediaMarkup(item));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repairImportedMediaMarkup(item)]));
    return value;
  }

  function normalizeBackup(backup) {
    backup = unwrapBackup(backup);
    if (!isRecord(backup)) {
      throw unsupportedBackupError(backup);
    }
    const version = normalizeBackupVersion(backup.version);
    const currentFormat = backup.format === BACKUP_FORMAT && SUPPORTED_BACKUP_VERSIONS.has(version);
    // Early local builds exported the same session/config body before a format
    // marker was added. Keep those backups importable, but never accept a
    // differently marked schema that may require a newer migration path.
    const legacyFormat = !backup.format
      && Array.isArray(backup.sessions)
      && (isRecord(backup.configuration) || isRecord(backup.config) || isRecord(backup.settings)
        // The session-only format was briefly emitted without a format marker.
        // It is safe to accept because it contains no configuration payload.
        || backup.sessions.length > 0);
    if (!currentFormat && !legacyFormat) throw unsupportedBackupError(backup);
    if (!Array.isArray(backup.sessions)) {
      throw new Error('备份文件缺少配置或会话数据');
    }
    if (!backup.sessions.length) throw new Error('备份文件中没有可恢复的会话');
    if (backup.sessions.length > MAX_BACKUP_SESSIONS) throw new Error(`备份文件会话数超过 ${MAX_BACKUP_SESSIONS} 个`);
    const sessionIds = new Set();
    const sessions = backup.sessions.map((session, index) => {
      const normalized = normalizeImportedSession(session, index);
      if (sessionIds.has(normalized.id)) throw new Error('备份文件包含重复的会话 ID');
      sessionIds.add(normalized.id);
      return normalized;
    });
    const requestedActiveId = asText(backup.activeSessionId).trim();
    const media = currentFormat && version >= PORTABLE_MEDIA_VERSION ? normalizeBackupMedia(backup.media) : [];
    const referencedKeys = collectBackupMediaKeys(sessions);
    if (currentFormat && version >= PORTABLE_MEDIA_VERSION && referencedKeys.length) {
      const includedKeys = new Set(media.map(item => item.key));
      const missingKeys = referencedKeys.filter(key => !includedKeys.has(key));
      if (missingKeys.length) {
        throw new Error(`备份文件缺少 ${missingKeys.length} 个附件或图片数据，请在原浏览器重新导出`);
      }
    }
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      sessions,
      activeSessionId: sessionIds.has(requestedActiveId) ? requestedActiveId : sessions[0].id,
      media,
    };
  }

  function createBackupArchive({ sessions = [], activeSessionId = '', exportedAt = new Date().toISOString(), media = [] } = {}) {
    const normalizedSessions = sessions.map((session, index) => normalizeImportedSession(session, index));
    if (!normalizedSessions.length) throw new Error('当前没有可导出的会话');
    const activeId = normalizedSessions.some(session => session.id === activeSessionId) ? activeSessionId : normalizedSessions[0].id;
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt,
      sessions: normalizedSessions,
      activeSessionId: activeId,
      media: normalizeBackupMedia(media),
    };
  }

  function parseBackupText(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('备份文件为空');
    let parsed;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('备份文件不是有效的 JSON'); }
    return normalizeBackup(parsed);
  }

  function createBackupWorkflow(deps = {}) {
    const state = deps.state || {};
    const windowRef = deps.window || root?.window || root;
    const documentRef = deps.document || root?.document;
    const isSessionBusy = deps.isSessionBusy || (() => false);
    const clearSessionSnapshots = deps.clearSessionSnapshots || (async () => {});
    const commitSession = deps.commitSession || (async () => {});
    const flushSessionSnapshots = deps.flushSessionSnapshots || (async () => {});
    const collectIndexedDbKeys = deps.collectIndexedDbKeys || defaultCollectIndexedDbKeys;
    const getImageBlob = deps.getImageBlob;
    const putImageBlob = deps.putImageBlob;
    const clearImageDb = deps.clearImageDb || (async () => {});
    const blobToDataUrl = deps.blobToDataUrl || (blob => readBlobAsDataUrl(blob, FileReaderCtor));
    const dataUrlToBlob = deps.dataUrlToBlob || (value => readDataUrlAsBlob(value, windowRef?.fetch || root?.fetch));
    const saveSessionsMeta = deps.saveSessionsMeta || (() => {});
    const toast = deps.toast || (() => {});
    const reload = deps.reload || (() => windowRef?.location?.reload?.());
    const FileReaderCtor = deps.FileReader || windowRef?.FileReader || root?.FileReader;
    const makeBlob = deps.makeBlob || (parts => new Blob(parts, { type: 'application/json;charset=utf-8' }));
    const createObjectUrl = deps.createObjectUrl || (blob => windowRef?.URL?.createObjectURL?.(blob));
    const revokeObjectUrl = deps.revokeObjectUrl || (url => windowRef?.URL?.revokeObjectURL?.(url));

    function assertNoRunningTasks() {
      if ((state.sessions || []).some(session => isSessionBusy(session?.id))) {
        throw new Error('有会话正在生成内容，请结束或等待任务完成后再导入');
      }
    }

    function referencedMediaKeys(sessions = []) {
      return collectBackupMediaKeys(sessions, collectIndexedDbKeys);
    }

    async function buildBackupMedia(sessions = []) {
      const keys = referencedMediaKeys(sessions);
      if (!keys.length) return [];
      if (typeof getImageBlob !== 'function') throw new Error('当前浏览器无法读取本地附件或图片');
      const media = [];
      const missing = [];
      for (const key of keys) {
        const blob = await getImageBlob(key);
        if (!blob) {
          missing.push(key);
          continue;
        }
        const dataUrl = await blobToDataUrl(blob);
        if (!isBase64DataUrl(dataUrl)) throw new Error(`媒体文件 ${key} 无法写入备份`);
        media.push({ key, dataUrl });
      }
      if (missing.length) throw new Error(`有 ${missing.length} 个本地附件或图片缓存已丢失，无法生成完整备份`);
      return media;
    }

    async function buildBackup() {
      await flushSessionSnapshots();
      const sessions = state.sessions || [];
      return createBackupArchive({
        sessions,
        activeSessionId: state.activeSessionId,
        media: await buildBackupMedia(sessions),
      });
    }

    async function downloadBackup() {
      const archive = await buildBackup();
      const contents = `${JSON.stringify(archive, null, 2)}\n`;
      if (utf8ByteLength(contents) > MAX_BACKUP_FILE_BYTES) {
        throw new Error('备份文件超过 200 MB，请减少附件或图片后再导出');
      }
      const blob = makeBlob([contents]);
      const url = createObjectUrl(blob);
      if (!url || !documentRef?.createElement) throw new Error('当前浏览器不支持下载备份文件');
      const link = documentRef.createElement('a');
      link.href = url;
      link.download = backupFileName();
      link.style.display = 'none';
      documentRef.body?.appendChild?.(link);
      link.click();
      link.remove?.();
      windowRef?.setTimeout?.(() => revokeObjectUrl(url), 0);
      toast('备份已导出，请妥善保管文件');
      return archive;
    }

    async function restoreBackup(backup) {
      assertNoRunningTasks();
      const normalized = normalizeBackup(backup);
      const media = await decodeBackupMedia(normalized.media);
      await flushSessionSnapshots();
      await clearSessionSnapshots();
      await restoreBackupMedia(media);
      state.disposedSessionIds?.clear?.();
      state.sessions = normalized.sessions;
      state.activeSessionId = normalized.activeSessionId;
      const activeSession = state.sessions.find(session => session.id === state.activeSessionId) || state.sessions[0];
      state.messages = activeSession?.messages || [];
      state.lastGeneratedImage = activeSession?.lastGeneratedImage || null;
      state.attachments = [];
      const committed = await Promise.all(state.sessions.map(session => commitSession(session)));
      if (committed.some(result => result === null)) {
        throw new Error('导入的会话内容未能保存，请重试');
      }
      saveSessionsMeta();
      await flushSessionSnapshots();
      return { ...normalized, restoredMediaCount: media.length };
    }

    async function restoreBackupMedia(media = []) {
      await clearImageDb();
      if (!media.length) return;
      for (const item of media) await putImageBlob(item.key, item.blob);
      // IndexedDB transaction completion alone is not enough to prove that the
      // image store used by the renderer can see the imported value. Read every
      // key through that same path before committing/reloading the session.
      if (typeof getImageBlob === 'function') {
        for (const item of media) {
          const restored = await getImageBlob(item.key);
          if (!restored) throw new Error(`媒体文件 ${item.key} 写入本地存储失败`);
        }
      }
    }

    async function decodeBackupMedia(media = []) {
      if (!media.length) return [];
      if (typeof putImageBlob !== 'function') throw new Error('当前浏览器无法恢复本地附件或图片');
      const decoded = [];
      for (const item of media) {
        const blob = await dataUrlToBlob(item.dataUrl);
        if (!blob) throw new Error(`媒体文件 ${item.key} 无法恢复`);
        decoded.push({ key: item.key, blob });
      }
      return decoded;
    }

    async function readImportFile(file) {
      if (!file) throw new Error('请选择备份文件');
      if (Number(file.size || 0) > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件不能超过 200 MB');
      if (typeof file.text === 'function') return parseBackupText(await file.text());
      if (typeof FileReaderCtor !== 'function') throw new Error('当前浏览器无法读取备份文件');
      const text = await new Promise((resolve, reject) => {
        const reader = new FileReaderCtor();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取备份文件失败'));
        try { reader.readAsText(file, 'utf-8'); } catch { reject(new Error('读取备份文件失败')); }
      });
      return parseBackupText(text);
    }

    async function importBackupFile(file) {
      const backup = await readImportFile(file);
      const accepted = windowRef?.confirm?.('导入会覆盖当前浏览器中的所有会话，并恢复会话中的图片和附件。当前 API 配置、模型配置及自定义 Header 不会改变。确认继续吗？');
      if (!accepted) return false;
      const restored = await restoreBackup(backup);
      const mediaText = restored.restoredMediaCount ? `，已恢复 ${restored.restoredMediaCount} 个附件或图片` : '';
      toast(`备份已恢复${mediaText}，正在重新加载`);
      reload();
      return restored;
    }

    return Object.freeze({ buildBackup, downloadBackup, readImportFile, restoreBackup, importBackupFile, referencedMediaKeys });
  }

  function defaultCollectIndexedDbKeys(value, keys = new Set(), seen = new WeakSet()) {
    if (!value) return keys;
    if (typeof value === 'string') {
      const pattern = /indexeddb:\/\/([^"'<>`\\\s]+)/g;
      let match;
      while ((match = pattern.exec(value))) keys.add(match[1]);
      return keys;
    }
    if (typeof value !== 'object' || seen.has(value)) return keys;
    seen.add(value);
    Object.values(value).forEach(item => defaultCollectIndexedDbKeys(item, keys, seen));
    return keys;
  }

  function collectBackupMediaKeys(sessions = [], collectKeys = defaultCollectIndexedDbKeys) {
    const keys = new Set();
    // Scan the complete persisted session record rather than just the current
    // message fields. Older snapshots keep media descriptors in presentation,
    // pending-clarification, or compatibility display fields.
    (Array.isArray(sessions) ? sessions : []).forEach(session => collectKeys(session, keys));
    return [...keys];
  }

  function readBlobAsDataUrl(blob, FileReaderCtor) {
    if (typeof FileReaderCtor !== 'function') return Promise.reject(new Error('当前浏览器无法读取本地附件或图片'));
    return new Promise((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取本地附件或图片失败'));
      try { reader.readAsDataURL(blob); } catch { reject(new Error('读取本地附件或图片失败')); }
    });
  }

  function readDataUrlAsBlob(value, fetchImpl) {
    if (typeof fetchImpl !== 'function') return Promise.reject(new Error('当前浏览器无法恢复本地附件或图片'));
    return fetchImpl(value).then(response => {
      if (!response?.ok) throw new Error('媒体文件无法恢复');
      return response.blob();
    });
  }

  function utf8ByteLength(value) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).byteLength;
    return unescape(encodeURIComponent(value)).length;
  }

  const api = Object.freeze({
    BACKUP_FORMAT,
    BACKUP_VERSION,
    MAX_BACKUP_FILE_BYTES,
    backupFileName,
    createBackupArchive,
    normalizeBackupMedia,
    normalizeBackup,
    parseBackupText,
    createBackupWorkflow,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.ChatUIApp?.appContext?.registerWorkflowModule?.('backup', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
