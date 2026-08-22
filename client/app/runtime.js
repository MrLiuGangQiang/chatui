(function(){
  function setDisplayedVersion(version, doc = document) {
    const value = String(version || '').trim();
    if (!value) return '';
    const label = value.startsWith('v') ? value : `v${value}`;
    const compactLabel = label.replace(/^v/i, '');
    doc.querySelectorAll('[data-app-version]').forEach(node => {
      if (node.classList?.contains('sidebar-version-badge')) {
        node.title = `当前版本 ${label}`;
        node.setAttribute('aria-label', `当前版本 ${label}`);
        node.dataset.versionLabel = label;
        const textNode = node.querySelector?.('.sidebar-version-text');
        if (textNode) textNode.textContent = compactLabel;
        return;
      }
      node.textContent = label;
    });
    const railConfigBtn = doc.getElementById('railConfigBtn');
    if (railConfigBtn) {
      railConfigBtn.title = `模型配置 · ${label}`;
      railConfigBtn.setAttribute('aria-label', `模型配置，当前版本 ${label}`);
    }
    return label;
  }

  function normalizeRuntimeIdentity(value = {}) {
    const sourceRevision = String(value?.sourceRevision || value?.source_revision || '').trim();
    return sourceRevision ? {
      version: String(value?.version || '').trim(),
      gitSha: String(value?.gitSha || value?.git_sha || '').trim(),
      sourceRevision,
    } : null;
  }

  async function loadAppVersion({ fetchImpl = fetch, setVersion = setDisplayedVersion, fallback = '', runtimeService = window.ChatUIServices?.runtime || window.ChatUIRuntimeService } = {}) {
    try {
      const freshness = await ensureCurrentRuntimeBuild({ fetchImpl, runtimeService });
      if (freshness.reloading) return false;
      const version = freshness.identity?.version
        || (runtimeService?.requestAppVersion
          ? await runtimeService.requestAppVersion({ fetchImpl })
          : await (async () => {
            const res = await fetchImpl('/api/version', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return (await res.json()).version;
          })());
      setVersion(version);
      return true;
    } catch {
      setVersion(fallback);
      return true;
    }
  }

  async function ensureCurrentRuntimeBuild({
    fetchImpl = fetch,
    locationRef = window.location,
    entryIdentity = window.__CHATUI_ENTRY_IDENTITY,
    runtimeService = window.ChatUIServices?.runtime || window.ChatUIRuntimeService,
  } = {}) {
    const entry = normalizeRuntimeIdentity(entryIdentity);
    try {
      const server = normalizeRuntimeIdentity(runtimeService?.requestRuntimeIdentity
        ? await runtimeService.requestRuntimeIdentity({ fetchImpl })
        : await (async () => {
          const res = await fetchImpl('/api/version', { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })());
      if (!server) return Object.freeze({ reloading: false, identity: null, reason: 'server-identity-unavailable' });
      if (!entry || entry.sourceRevision !== server.sourceRevision) {
        const target = `/__chatui/${encodeURIComponent(server.sourceRevision)}`;
        if (typeof locationRef?.replace === 'function') locationRef.replace(target);
        return Object.freeze({ reloading: true, identity: server, target });
      }
      window.__CHATUI_RUNTIME_IDENTITY = server;
      return Object.freeze({ reloading: false, identity: server, reason: 'current' });
    } catch {
      return Object.freeze({ reloading: false, identity: entry, reason: 'version-check-failed' });
    }
  }

  function createDoneSound({ AudioContextImpl = window.AudioContext || window.webkitAudioContext, userActivation = window.navigator?.userActivation, logger = console } = {}) {
    let audioCtx = null;
    async function unlockDoneSound({ userGesture = false } = {}) {
      try {
        if (!AudioContextImpl) return null;
        if (audioCtx?.state === 'running') return audioCtx;
        if (!userGesture || userActivation?.isActive === false) return null;
        if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContextImpl();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        return audioCtx.state === 'running' ? audioCtx : null;
      } catch (err) {
        logger.warn?.('unlock done sound failed', err);
        return null;
      }
    }

    async function playDoneSound() {
      try {
        const ctx = await unlockDoneSound();
        if (!ctx) return;
        const start = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.setValueAtTime(0.0001, start);
        master.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
        master.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
        master.connect(ctx.destination);
        [740, 988].forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const t = start + 0.13 * idx;
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(0.9, t + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
          osc.connect(gain);
          gain.connect(master);
          osc.start(t);
          osc.stop(t + 0.2);
          setTimeout(() => gain.disconnect(), 500);
        });
        setTimeout(() => master.disconnect(), 700);
      } catch (err) {
        logger.warn?.('play done sound failed', err);
      }
    }

    return { unlockDoneSound, playDoneSound };
  }

  window.ChatUIApp = Object.freeze({
    ...(window.ChatUIApp || {}),
    runtime: Object.freeze({ setDisplayedVersion, loadAppVersion, ensureCurrentRuntimeBuild, createDoneSound }),
  });
})();
