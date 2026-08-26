'use strict';

// Online-user presence tracking.
//
// "Online" is defined as an open ChatUI tab that keeps an SSE subscription to
// /api/presence/stream alive. Each tab carries its own stable clientId
// (generated once per tab and persisted in sessionStorage) so a reload reuses
// the same slot, a new tab is counted separately, and reconnects after a
// network blip are never double counted.
//
// The service is deliberately in-memory: a single ChatUI process serves all
// tabs, matching the existing usage-statistics model where optional PostgreSQL
// is the only external store. A periodic sweeper evicts subscriptions whose
// last heartbeat is older than ttlMs, because browsers and proxies can drop
// SSE connections without ever firing a close event; without the sweeper the
// count would only ever grow (the exact failure this module's tests pin).

const PRESENCE_TTL_MS = Number(process.env.PRESENCE_TTL_MS || 120 * 1000);
const PRESENCE_SWEEP_INTERVAL_MS = Number(process.env.PRESENCE_SWEEP_INTERVAL_MS || 30 * 1000);
const PRESENCE_KEEPALIVE_INTERVAL_MS = Number(process.env.PRESENCE_KEEPALIVE_INTERVAL_MS || 15 * 1000);
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function createPresenceService({ ttlMs = PRESENCE_TTL_MS, now = Date.now } = {}) {
  const sessions = new Map(); // clientId -> { res, lastSeen }

  function count() {
    return sessions.size;
  }

  function snapshot() {
    return { count: sessions.size, timestamp: now() };
  }

  // Browser tabs generate ids that only contain URL-safe characters; rejecting
  // anything else keeps the stream URL and heartbeat body strict.
  function normalizeClientId(value) {
    const raw = String(value || '').trim();
    return CLIENT_ID_PATTERN.test(raw) ? raw : null;
  }

  function broadcast(payload) {
    const frame = `event: presence\ndata: ${JSON.stringify(payload)}\n\n`;
    let delivered = 0;
    for (const [clientId, session] of sessions) {
      if (!session?.res) {
        sessions.delete(clientId);
        continue;
      }
      try {
        session.res.write(frame);
        session.res.flushHeaders?.();
        delivered += 1;
      } catch {
        sessions.delete(clientId);
        try { session.res.end(); } catch {}
      }
    }
    return delivered;
  }

  // Only announce a count change; quiet joins/leaves must not spam subscribers.
  function broadcastCount(previousCount) {
    const current = count();
    if (current === previousCount) return false;
    broadcast(snapshot());
    return true;
  }

  function join(clientId, res) {
    const id = normalizeClientId(clientId);
    if (!id || !res) return null;
    const previous = count();
    const existing = sessions.get(id);
    if (existing) {
      // A tab reconnecting after a network blip: retire the stale connection so
      // the slot is reused instead of being double counted.
      sessions.delete(id);
      try { existing.res?.end(); } catch {}
    }
    sessions.set(id, { res, lastSeen: now() });
    broadcastCount(previous);
    return { joined: !existing, count: count() };
  }

  function touch(clientId) {
    const id = normalizeClientId(clientId);
    if (!id) return false;
    const session = sessions.get(id);
    if (!session) return false;
    session.lastSeen = now();
    return true;
  }

  function leave(clientId, res) {
    const id = normalizeClientId(clientId);
    if (!id) return false;
    const session = sessions.get(id);
    if (!session) return false;
    // A stale connection that has already been replaced by a reconnect must not
    // remove the replacement session: only the exact response that owns the
    // current slot may leave it. Production callers always pass the response
    // created by their own join.
    if (res && session.res !== res) return false;
    const previous = count();
    sessions.delete(id);
    broadcastCount(previous);
    return true;
  }

  function sweep(nowMs = now()) {
    let removed = 0;
    for (const [clientId, session] of sessions) {
      if (!session || nowMs - Number(session.lastSeen || 0) > ttlMs) {
        sessions.delete(clientId);
        try { session?.res?.end(); } catch {}
        removed += 1;
      }
    }
    if (removed > 0) broadcast(snapshot());
    return removed;
  }

  function closeAll() {
    const closed = sessions.size;
    for (const session of sessions.values()) {
      try { session?.res?.end(); } catch {}
    }
    sessions.clear();
    return closed;
  }

  return { count, snapshot, normalizeClientId, join, touch, leave, sweep, closeAll, broadcast };
}

function startPresenceSweeper(service, intervalMs = PRESENCE_SWEEP_INTERVAL_MS) {
  const timer = setInterval(() => {
    try { service.sweep(); } catch {}
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  createPresenceService,
  startPresenceSweeper,
  PRESENCE_TTL_MS,
  PRESENCE_SWEEP_INTERVAL_MS,
  PRESENCE_KEEPALIVE_INTERVAL_MS,
};