(function initChatUIPresenceService(root) {
  'use strict';

  // Browser-side presence client. Each tab carries its own stable clientId
  // persisted in sessionStorage: a reload in the same tab reuses the id (no
  // double count), while a second tab gets its own id and is counted
  // separately. The SSE stream is the "online" signal; a periodic heartbeat
  // keeps the server-side lastSeen fresh so the presence sweeper never evicts
  // a healthy but quiet tab.
  //
  // This module intentionally registers through the module registry instead of
  // adding a window.ChatUI* namespace export: the architecture baseline for
  // browser global namespace exports is already at its budget.

  const REGISTRY_SYMBOL = Symbol.for('chatui.module-registry.v1');
  const STORAGE_KEY = 'chatui-presence-client-id-v1';
  const HEARTBEAT_INTERVAL_MS = 30 * 1000;
  const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

  let memoryClientId = null;

  function makeClientId() {
    return `pres-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // Each storage instance (sessionStorage per tab) owns its own id: a reload in
  // the same tab reuses it, while a different tab gets a different id so tabs
  // are counted separately instead of fighting over one server slot. The
  // in-memory fallback is only used when storage is unavailable (private mode).
  function loadClientId(storage) {
    try {
      const existing = storage?.getItem?.(STORAGE_KEY);
      if (existing && CLIENT_ID_PATTERN.test(existing)) return existing;
      const id = makeClientId();
      storage?.setItem?.(STORAGE_KEY, id);
      return id;
    } catch {
      if (!memoryClientId) memoryClientId = makeClientId();
      return memoryClientId;
    }
  }

  function defaultFetch() {
    return typeof root?.fetch === 'function' ? root.fetch.bind(root) : fetch;
  }

  async function fetchSnapshot({ fetchImpl = defaultFetch() } = {}) {
    try {
      const response = await fetchImpl('/api/presence', { headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      const payload = await response.json();
      const count = Number(payload?.count);
      return Number.isFinite(count) ? count : null;
    } catch {
      return null;
    }
  }

  async function sendHeartbeat({ clientId, fetchImpl = defaultFetch() } = {}) {
    try {
      const response = await fetchImpl('/api/presence/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // Opens the presence SSE stream and keeps it alive with a bounded backoff
  // reconnect, mirroring job-service's stream handling. Returns a stop()
  // function that tears down the stream, reconnect timer and heartbeat timer.
  function connectPresence({ clientId, onCount = () => {}, onStatus = () => {}, fetchImpl = defaultFetch(), signal } = {}) {
    const id = clientId || loadClientId(root?.sessionStorage);
    let stopped = false;
    let reader = null;
    let reconnectTimer = null;
    let heartbeatTimer = null;
    let reconnects = 0;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(heartbeatTimer);
      try { reader?.cancel(); } catch {}
      if (signal) signal.removeEventListener('abort', stop);
    };
    if (signal?.aborted) { stop(); return stop; }
    signal?.addEventListener('abort', stop, { once: true });

    const scheduleReconnect = () => {
      if (stopped) return;
      onStatus('disconnected');
      const delay = Math.min(1000 + 250 * reconnects, 5000);
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (stopped) return;
      reconnects += 1;
      const url = `/api/presence/stream?clientId=${encodeURIComponent(id)}`;
      fetchImpl(url, { headers: { Accept: 'text/event-stream' } })
        .then(response => {
          if (stopped) return;
          if (!response.ok || !response.body) return scheduleReconnect();
          reconnects = 0;
          onStatus('connected');
          const decoder = new TextDecoder();
          reader = response.body.getReader();
          let leftover = '';
          const buffer = { event: '', data: '' };
          const handleLine = line => {
            if (line.startsWith('event: ')) buffer.event = line.slice(7).trim();
            else if (line.startsWith('data: ')) buffer.data += line.slice(6);
            else if (line === '') {
              if (buffer.event === 'presence' && buffer.data) {
                try {
                  const payload = JSON.parse(buffer.data);
                  const count = Number(payload?.count);
                  if (Number.isFinite(count)) onCount(count);
                } catch {}
              }
              buffer.event = '';
              buffer.data = '';
            }
          };
          const pump = () => {
            if (stopped) return;
            reader.read().then(({ done, value }) => {
              if (stopped) return;
              if (done) return scheduleReconnect();
              leftover += decoder.decode(value, { stream: true });
              const lines = leftover.split('\n');
              leftover = lines.pop() || '';
              for (const line of lines) handleLine(line);
              pump();
            }).catch(() => scheduleReconnect());
          };
          pump();
        })
        .catch(() => scheduleReconnect());
    };

    heartbeatTimer = setInterval(() => {
      sendHeartbeat({ clientId: id, fetchImpl });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    connect();
    return stop;
  }

  const api = Object.freeze({
    STORAGE_KEY,
    makeClientId,
    loadClientId,
    fetchSnapshot,
    sendHeartbeat,
    connectPresence,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('presenceService', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));