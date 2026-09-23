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
    const rootRef = options.root || root;
    const documentRef = options.document || rootRef?.document;
    const service = options.service || resolvePresenceService(rootRef);
    const storage = options.storage !== undefined ? options.storage : rootRef?.sessionStorage;
    const clientId = options.clientId || (typeof service?.loadClientId === 'function' ? service.loadClientId(storage) : '');
    let active = false;
    let session = 0;
    let stopStream = null;
    let abortController = null;
    let detachPagehide = null;

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

    // Releases the current session: the pending pagehide hook, the stream and
    // its abort signal. Safe to call when no session is open.
    function releaseSession() {
      detachPagehide?.();
      detachPagehide = null;
      const controller = abortController;
      const stream = stopStream;
      abortController = null;
      stopStream = null;
      try { controller?.abort(); } catch {}
      try { stream?.(); } catch {}
    }

    // Each start() opens a new session owning one snapshot request and one SSE
    // stream. Stopping bumps the session id, so a late response from a
    // replaced session can never repaint the badge.
    function start() {
      if (active) return stopStream;
      if (!service || indicators().length === 0) return null;
      active = true;
      session += 1;
      const currentSession = session;
      const isCurrentSession = () => active && currentSession === session;
      // The live stream is authoritative: the snapshot is requested before the
      // stream connects, so a snapshot that resolves after an SSE count must
      // not overwrite the newer number and freeze the badge on a stale value.
      let liveCountApplied = false;

      if (typeof service.fetchSnapshot === 'function') {
        try {
          Promise.resolve(service.fetchSnapshot()).then(count => {
            if (!isCurrentSession() || liveCountApplied) return;
            if (Number.isFinite(count)) renderCount(count);
          }).catch(() => {});
        } catch {}
      }

      if (typeof service.connectPresence === 'function') {
        abortController = new AbortController();
        const controller = abortController;
        const abortOnPagehide = () => controller.abort();
        if (typeof rootRef?.addEventListener === 'function') {
          rootRef.addEventListener('pagehide', abortOnPagehide, { once: true });
          detachPagehide = () => rootRef.removeEventListener?.('pagehide', abortOnPagehide);
        }
        stopStream = service.connectPresence({
          clientId,
          onCount: count => {
            if (!isCurrentSession()) return;
            liveCountApplied = true;
            renderCount(count);
          },
          signal: controller.signal,
        });
      }
      return stopStream;
    }

    function stop() {
      active = false;
      session += 1;
      releaseSession();
    }

    return { start, stop };
  }

  // A bfcache restore fires pageshow without re-running the page scripts, so a
  // stream torn down by pagehide must be re-established: otherwise the
  // restored tab silently drops out of the online count and keeps showing the
  // number it saw before it left. online covers the same restart once the
  // browser regains connectivity.
  function bindPresenceLifecycle(controller, options = {}) {
    const rootRef = options.root || root;
    controller.start();
    rootRef?.addEventListener?.('pagehide', () => controller.stop());
    rootRef?.addEventListener?.('pageshow', () => controller.start());
    rootRef?.addEventListener?.('online', () => controller.start());
    return controller;
  }

  function bind() {
    bindPresenceLifecycle(createPresenceController());
  }

  const api = Object.freeze({ resolvePresenceService, createPresenceController, bindPresenceLifecycle, bind });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
