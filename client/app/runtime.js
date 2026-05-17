(function(){
  function setDisplayedVersion(version, doc = document) {
    const value = String(version || '').trim();
    if (!value) return '';
    const label = value.startsWith('v') ? value : `v${value}`;
    doc.querySelectorAll('[data-app-version]').forEach(node => { node.textContent = label; });
    const railConfigBtn = doc.getElementById('railConfigBtn');
    if (railConfigBtn) {
      railConfigBtn.title = `模型配置 · ${label}`;
      railConfigBtn.setAttribute('aria-label', `模型配置，当前版本 ${label}`);
    }
    return label;
  }

  async function loadAppVersion({ fetchImpl = fetch, setVersion = setDisplayedVersion, fallback = '1.1.1' } = {}) {
    try {
      const res = await fetchImpl('/api/version', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return setVersion((await res.json()).version);
    } catch {
      return setVersion(fallback);
    }
  }

  function createDoneSound({ AudioContextImpl = window.AudioContext || window.webkitAudioContext, logger = console } = {}) {
    let audioCtx = null;
    async function unlockDoneSound() {
      try {
        if (!AudioContextImpl) return null;
        if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContextImpl();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        return audioCtx;
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
    runtime: Object.freeze({ setDisplayedVersion, loadAppVersion, createDoneSound }),
  });
})();
