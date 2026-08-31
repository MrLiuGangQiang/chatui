'use strict';

// Online-user presence tracking.
//
// "Online" is defined as an open browser (device): the count is the number of
// distinct HMAC-signed principal cookies (one per browser) with at least one
// live SSE subscription to /api/presence/stream. Each tab still carries its
// own stable clientId (generated once per tab and persisted in sessionStorage)
// so a reload reuses the same slot and reconnects after a network blip are
// never double counted; the clientId only manages the SSE connection
// lifecycle. The server derives the principal owner key from the request
// principal cookie, so multiple tabs of the same browser collapse into one
// online slot instead of being counted separately.
//
// The in-memory service is deliberately single-instance: a single ChatUI
// process serves all tabs, matching the existing usage-statistics model where
// optional PostgreSQL is the only external store. Multi-instance deployments
// should configure REDIS_URL so server/services/presence.redis.js can keep the
// global count in a shared Redis sorted set keyed by principal; the local
// in-memory table below still owns each process's live SSE response objects.
// Multi-instance deduplication requires all instances to share
// CHATUI_PRINCIPAL_SECRET so the same browser maps to the same principal key.

const { principalOwnerKey } = require('../security/request-principal');

const PRESENCE_TTL_MS = Number(process.env.PRESENCE_TTL_MS || 120 * 1000);
const PRESENCE_SWEEP_INTERVAL_MS = Number(process.env.PRESENCE_SWEEP_INTERVAL_MS || 30 * 1000);
const PRESENCE_KEEPALIVE_INTERVAL_MS = Number(process.env.PRESENCE_KEEPALIVE_INTERVAL_MS || 15 * 1000);
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

// Browser tabs generate ids that only contain URL-safe characters; rejecting
// anything else keeps the stream URL and heartbeat body strict.
function normalizePresenceClientId(value) {
  const raw = String(value || '').trim();
  return CLIENT_ID_PATTERN.test(raw) ? raw : null;
}

// The principal owner key is a 32-byte HMAC derivation; base64url is a stable,
// URL-safe canonical form for the session table and the Redis sorted set.
function normalizePrincipalKey(value) {
  if (Buffer.isBuffer(value)) return value.toString('base64url');
  const raw = String(value || '').trim();
  return raw ? raw : null;
}

function principalKeyFromPrincipal(principal) {
  const key = principalOwnerKey(principal);
  return key ? key.toString('base64url') : null;
}

function createPresenceService({ ttlMs = PRESENCE_TTL_MS, now = Date.now } = {}) {
  const sessions = new Map(); // clientId -> { res, lastSeen, principalKey }

  // Counts distinct online identities. A session's identity is its principal
  // key when present (browser tabs collapse to one device) and falls back to
  // the clientId for anonymous/non-browser connections so they are never
  // silently dropped.
  function count() {
    const identities = new Set();
    for (const [clientId, session] of sessions) {
      if (!session?.res) continue;
      identities.add(session.principalKey || clientId);
    }
    return identities.size;
  }

  function snapshot() {
    return { count: count(), timestamp: now() };
  }

  function normalizeClientId(value) {
    return normalizePresenceClientId(value);
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

  function join(clientId, res, principalKey) {
    const id = normalizeClientId(clientId);
    if (!id || !res) return null;
    const key = normalizePrincipalKey(principalKey) || id;
    const previous = count();
    const existing = sessions.get(id);
    if (existing) {
      // A tab reconnecting after a network blip: retire the stale connection so
      // the slot is reused instead of being double counted.
      sessions.delete(id);
      try { existing.res?.end(); } catch {}
    }
    sessions.set(id, { res, lastSeen: now(), principalKey: key });
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
    // Both the in-memory and Redis-backed services share this sweeper. The
    // in-memory sweep is synchronous while the Redis sweep is async, so route
    // the result through Promise.resolve and swallow async rejections.
    try {
      Promise.resolve(service.sweep()).catch(() => {});
    } catch {}
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  createPresenceService,
  startPresenceSweeper,
  normalizePresenceClientId,
  normalizePrincipalKey,
  principalKeyFromPrincipal,
  PRESENCE_TTL_MS,
  PRESENCE_SWEEP_INTERVAL_MS,
  PRESENCE_KEEPALIVE_INTERVAL_MS,
};
