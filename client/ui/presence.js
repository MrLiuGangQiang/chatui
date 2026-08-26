(function initChatUIPresence(root) {
  'use strict';

  // Renders a compact online-user badge. Every element carrying
  // [data-presence-indicator] is kept in sync, so the same controller can
  // drive badges in the topbar utility cluster and anywhere else. Badges stay
  // hidden until the first count arrives (snapshot or SSE event) so they never
  // flash "0" before the page knows the server is reachable.
  //
  // The controller is dependency-injectable so unit tests can drive it with a
  // fake document and a fake presence service.

  const REGISTRY_SYMBOL = Symbol.for('chatui.module-registry.v1');

  function resolvePresenceService(rootLike = root) {
    return rootLike?.[REGISTRY_SYMBOL]?.get('presenceService') || null;
  }

  function createPresenceController(options = {}) {
    const documentRef = options.document || root?.document;
    const service = options.service || resolvePresenceService(options.root || root);
    const storage = options.storage !== undefined ? options.storage : root?.sessionStorage;
    const clientId = options.clientId || (typeof service?.loadClientId === 'function' ? service.loadClientId(storage) : '');
    let active = false;
    let stop = null;

    function indicators() {
      return documentRef?.querySelectorAll?.('[data-presence-indicator]') || [];
    }

    function renderCount(count) {
      const value = Math.max(0, Number(count) || 0);
      const label = value === 1 ? '1 人在线' : `${value} 人在线`;
      for (const indicator of indicators()) {
        const countEl = indicator.querySelector?.('[data-presence-count]');
        if (countEl) countEl.textContent = String(value);
        indicator.title = label;
        indicator.setAttribute('aria-label', label);
        indicator.hidden = false;
      }
    }

    function start() {
      if (active) return stop;
      if (!service || indicators().length === 0) return null;
      active = true;
      if (typeof service.fetchSnapshot === 'function') {
        service.fetchSnapshot().then(count => {
          if (Number.isFinite(count)) renderCount(count);
        }).catch(() => {});
      }
      if (typeof service.connectPresence === 'function') {
        const controller = new AbortController();
        if (typeof root?.addEventListener === 'function') {
          root.addEventListener('pagehide', () => controller.abort(), { once: true });
        }
        stop = service.connectPresence({ clientId, onCount: renderCount, signal: controller.signal });
      }
      return stop;
    }

    return { start, stop: () => { if (stop) stop(); active = false; } };
  }

  function bind() {
    createPresenceController().start();
  }

  const api = Object.freeze({ resolvePresenceService, createPresenceController, bind });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));