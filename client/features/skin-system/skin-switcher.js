(function initChatUISkinSwitcher(root) {
  'use strict';

  const SKIN_STORAGE_KEY = 'openapi-chat-image-skin-v1';

  // Painter palette: wooden body with a cut-out thumb hole and five paint
  // dabs. The colours are baked in on purpose - the trigger must read as a
  // colourful palette in every skin, so CSS must not recolour this icon.
  const TRIGGER_ICON = ''
    + '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path fill-rule="evenodd" fill="#f7e6c9" stroke="#b07a4f" stroke-width="1.2" stroke-linejoin="round" d="M12 3.1c-5.2 0-9.2 3.3-9.2 7.4 0 4.3 3.9 7.3 8.7 7.3h2.2c1 0 1.7-.7 1.7-1.6 0-.5-.2-.9-.5-1.3-.3-.3-.4-.7-.4-1 0-.9.7-1.6 1.7-1.6h2c1.9 0 3.3-1.5 3.3-3.4 0-3.5-4-6.1-9.5-6.1Zm-3.4 12.7a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z"/>'
    + '<circle cx="6.8" cy="8.6" r="1.35" fill="#e2574c"/>'
    + '<circle cx="10.8" cy="6.6" r="1.35" fill="#f0a33a"/>'
    + '<circle cx="15.2" cy="7.6" r="1.35" fill="#4f9d69"/>'
    + '<circle cx="18.2" cy="10.9" r="1.35" fill="#3f7fd0"/>'
    + '<circle cx="6.2" cy="12.3" r="1.35" fill="#8a63c9"/>'
    + '</svg>';

  function resolveSkinCore(options = {}) {
    const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
    return options.skinCore
      || root?.ChatUICoreSkin
      || registry?.resolve?.('skinCore')
      || null;
  }

  function resolveSkins(options = {}, skinCore = null) {
    if (Array.isArray(options.skins) && options.skins.length) return options.skins;
    if (Array.isArray(skinCore?.SKINS) && skinCore.SKINS.length) return skinCore.SKINS;
    return [];
  }

  function resolveStorageKey(options = {}, skinCore = null) {
    return options.storageKey
      || root?.ChatUIConfig?.storageKeys?.SKIN_KEY
      || skinCore?.SKIN_STORAGE_KEY
      || SKIN_STORAGE_KEY;
  }

  function createSkinSwitcher(options = {}) {
    const doc = options.document;
    if (!doc?.createElement || !doc?.body) return null;
    const storage = options.storage || null;
    const skinCore = resolveSkinCore(options);
    const skins = resolveSkins(options, skinCore);
    const storageKey = resolveStorageKey(options, skinCore);

    let shell = null;
    let trigger = null;
    let menu = null;
    let optionNodes = new Map();
    let documentClick = null;
    let documentKeydown = null;

    const normalize = id => (typeof skinCore?.normalizeSkinId === 'function'
      ? skinCore.normalizeSkinId(id, skins)
      : (skins.some(skin => String(skin?.id) === String(id || '').trim()) ? String(id).trim() : 'default'));

    function applySkinAttribute(skinId) {
      const rootNode = doc.documentElement;
      if (!rootNode) return;
      if (typeof rootNode.setAttribute === 'function') rootNode.setAttribute('data-skin', skinId);
      else if (rootNode.dataset) rootNode.dataset.skin = skinId;
    }

    function readCurrentSkin() {
      return typeof skinCore?.readSkinId === 'function'
        ? skinCore.readSkinId(storage, storageKey, skins)
        : normalize(storage?.getItem?.(storageKey));
    }

    function syncActive(skinId) {
      optionNodes.forEach((node, optionSkinId) => {
        const active = optionSkinId === skinId;
        node.button.classList.toggle('is-active', active);
        node.button.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }

    function closeMenu() {
      if (!menu || !trigger) return;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }

    function openMenu() {
      if (!menu || !trigger) return;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    }

    function toggleMenu() {
      if (!menu) return;
      if (menu.hidden) openMenu();
      else closeMenu();
    }

    function selectSkin(skinId) {
      const normalized = normalize(skinId);
      applySkinAttribute(normalized);
      if (typeof skinCore?.writeSkinId === 'function') {
        skinCore.writeSkinId(storage, normalized, { key: storageKey, skins, onError: options.onPersistError });
      } else if (storage?.setItem) {
        try { storage.setItem(storageKey, normalized); } catch (error) { options.onPersistError?.(error); }
      }
      syncActive(normalized);
      closeMenu();
      options.onChange?.(normalized);
      return normalized;
    }

    function ensureShell() {
      const existing = doc.getElementById('skinSwitcherRoot');
      if (existing) {
        shell = existing;
        trigger = existing.querySelector('.skin-switcher-trigger');
        menu = existing.querySelector('.skin-switcher-menu');
        return;
      }

      shell = doc.createElement('div');
      shell.id = 'skinSwitcherRoot';
      shell.className = 'skin-switcher';
      shell.setAttribute('role', 'group');
      shell.setAttribute('aria-label', '皮肤切换');

      trigger = doc.createElement('button');
      trigger.type = 'button';
      trigger.className = 'skin-switcher-trigger';
      trigger.title = '切换皮肤';
      trigger.setAttribute('aria-label', '切换皮肤');
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-controls', 'skinSwitcherMenu');
      trigger.innerHTML = TRIGGER_ICON;

      menu = doc.createElement('div');
      menu.id = 'skinSwitcherMenu';
      menu.className = 'skin-switcher-menu';
      menu.hidden = true;
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', '选择皮肤');

      shell.append(trigger, menu);
      doc.body.appendChild(shell);
    }

    function renderOptions() {
      if (!menu) return;
      menu.replaceChildren();
      optionNodes.clear();
      skins.forEach((skin, index) => {
        const skinId = String(skin?.id || '').trim();
        if (!skinId) return;

        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'skin-switcher-option';
        button.dataset.skinId = skinId;
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', 'false');

        const swatch = doc.createElement('span');
        swatch.className = `skin-swatch skin-swatch-${skinId}`;
        swatch.setAttribute('aria-hidden', 'true');

        const copy = doc.createElement('span');
        copy.className = 'skin-option-copy';
        const label = doc.createElement('strong');
        label.textContent = String(skin?.label || skinId);
        const description = doc.createElement('small');
        description.textContent = String(skin?.description || '');
        copy.append(label, description);

        button.append(swatch, copy);
        button.addEventListener('click', event => {
          event.stopPropagation();
          selectSkin(skinId);
        });
        button.addEventListener('keydown', event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const buttons = [...(menu?.querySelectorAll?.('.skin-switcher-option') || [])];
          const currentIndex = buttons.indexOf(button);
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const next = buttons[(currentIndex + delta + buttons.length) % buttons.length];
          next?.focus?.();
        });

        menu.appendChild(button);
        optionNodes.set(skinId, { button, index });
      });
    }

    function refresh() {
      if (!doc.body) return;
      ensureShell();
      renderOptions();
      const current = readCurrentSkin();
      applySkinAttribute(current);
      syncActive(current);
      bind();
    }

    function bind() {
      if (!trigger || !menu || documentClick) return;
      trigger.addEventListener('click', event => {
        event.stopPropagation();
        toggleMenu();
      });
      documentClick = event => {
        if (!shell || shell.contains(event.target)) return;
        closeMenu();
      };
      documentKeydown = event => {
        if (event.key === 'Escape') closeMenu();
      };
      doc.addEventListener('click', documentClick);
      doc.addEventListener('keydown', documentKeydown);
    }

    function destroy() {
      if (documentClick) doc.removeEventListener('click', documentClick);
      if (documentKeydown) doc.removeEventListener('keydown', documentKeydown);
      documentClick = null;
      documentKeydown = null;
      shell?.remove?.();
      shell = null;
      trigger = null;
      menu = null;
      optionNodes.clear();
    }

    return Object.freeze({ refresh, selectSkin, closeMenu, openMenu, destroy });
  }

  let instance = null;
  function init(options = {}) {
    if (instance) return instance;
    const document = options.document || root?.document;
    const storage = options.storage || root?.localStorage || null;
    instance = createSkinSwitcher({ ...options, document, storage });
    if (!instance) return null;
    instance.refresh();
    return instance;
  }

  const api = Object.freeze({ init, createSkinSwitcher, resolveSkinCore, resolveSkins, resolveStorageKey });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const appContext = root?.ChatUIApp?.appContext;
  if (appContext?.registerWorkflowModule) appContext.registerWorkflowModule('skinSystem', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
