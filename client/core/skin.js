(function initChatUICoreSkin(root) {
  'use strict';

  const SKIN_STORAGE_KEY = 'openapi-chat-image-skin-v1';

  // Single source of truth: each skin id owns styles/skins/<id>/skin.css and
  // co-locates its own assets; the integrity test enforces this layout.
  const SKINS = Object.freeze([
    Object.freeze({ id: 'default', label: '默认', description: 'ChatUI 原始浅色皮肤' }),
    Object.freeze({ id: 'ink', label: '古韵', description: '暖宣纸、墨色文字与朱砂点缀' }),
    Object.freeze({ id: 'snow', label: '雪山', description: '雪线蓝天与冰川湖光的清冽配色' }),
  ]);

  function normalizeSkinId(value = '', skins = SKINS) {
    const raw = String(value || '').trim();
    return skins.some(skin => String(skin?.id) === raw) ? raw : 'default';
  }

  function resolveSkin(id = '', skins = SKINS) {
    const normalized = normalizeSkinId(id, skins);
    const source = skins.find(skin => String(skin?.id) === normalized) || skins[0] || { id: 'default' };
    return Object.freeze({ ...source, id: normalized });
  }

  // Each skin owns styles/skins/<id>/skin.css. The default skin is bundled into
  // the page stylesheet; every other skin is injected on demand, so an inactive
  // skin never reaches the document. Unknown ids resolve to default and load nothing.
  function skinStylesheetHref(id = '', skins = SKINS) {
    const normalized = normalizeSkinId(id, skins);
    return normalized === 'default' ? '' : `/styles/skins/${normalized}/skin.css`;
  }

  function readSkinId(storage, key = SKIN_STORAGE_KEY, skins = SKINS) {
    try {
      return normalizeSkinId(storage?.getItem?.(key), skins);
    } catch {
      return 'default';
    }
  }

  function writeSkinId(storage, id = '', options = {}) {
    const skins = options.skins || SKINS;
    const key = options.key || SKIN_STORAGE_KEY;
    const normalized = normalizeSkinId(id, skins);
    if (storage?.setItem) {
      try {
        storage.setItem(key, normalized);
      } catch (error) {
        if (typeof options.onError === 'function') options.onError(error);
      }
    }
    return normalized;
  }

  const api = Object.freeze({
    SKIN_STORAGE_KEY,
    SKINS,
    normalizeSkinId,
    skinStylesheetHref,
    resolveSkin,
    readSkinId,
    writeSkinId,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('skinCore', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
