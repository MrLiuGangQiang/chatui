'use strict';

// Redis-backed presence for multi-instance deployments.
//
// The global online set lives in a Redis sorted set keyed by the principal
// owner key (one slot per browser/device, not per tab): score is the last-seen
// timestamp. Each process still keeps a local Map<clientId, {res,
// principalKey, lastSeen}> because an SSE response object belongs to one Node
// process only; Redis stores "who is online globally (deduplicated by
// device)", while the local map stores "which sockets this process must write
// to" and "which principals this process still holds".
//
// Cross-instance deduplication requires all instances to share
// CHATUI_PRINCIPAL_SECRET so the same browser resolves to the same principal
// key on every instance. A heartbeat may arrive on a different instance than
// the SSE owner; the shared sorted set is what keeps the device alive
// globally.
//
// Count changes are fanned out through Redis pub/sub so a join/leave/sweep on
// one instance refreshes SSE subscribers on every other instance. The wire
// contract (GET /api/presence, GET /api/presence/stream, POST
// /api/presence/heartbeat) is unchanged.

const { normalizePresenceClientId, normalizePrincipalKey, PRESENCE_TTL_MS } = require('./presence.service');

const DEFAULT_REDIS_KEY = 'chatui:presence:clients';
const DEFAULT_REDIS_CHANNEL = 'chatui:presence:events';

let presenceInstanceCounter = 0;
function makePresenceInstanceId() {
  const pid = typeof process !== 'undefined' && process.pid ? process.pid : 0;
  presenceInstanceCounter += 1;
  return String(pid) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '-' + presenceInstanceCounter;
}

function framePresence(payload) {
  return `event: presence\ndata: ${JSON.stringify(payload)}\n\n`;
}

function broadcastToLocal(sessions, payload) {
  const frame = framePresence(payload);
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

function createRedisPresenceService({
  redis,
  subscriber = redis,
  ttlMs = PRESENCE_TTL_MS,
  now = Date.now,
  key = DEFAULT_REDIS_KEY,
  channel = DEFAULT_REDIS_CHANNEL,
  instanceId = makePresenceInstanceId(),
} = {}) {
  if (!redis) throw new TypeError('createRedisPresenceService requires a redis client');
  const local = new Map(); // clientId -> { res, principalKey, lastSeen }

  function normalizeClientId(value) {
    return normalizePresenceClientId(value);
  }

  // The global slot identity: principal key when the request carried a
  // principal cookie, otherwise the clientId (anonymous/non-browser clients).
  function globalMember(clientId, principalKey) {
    return normalizePrincipalKey(principalKey) || clientId;
  }

  function hasLocalPrincipal(principal) {
    for (const session of local.values()) {
      if (session.principalKey === principal) return true;
    }
    return false;
  }

  async function count() {
    const value = Number(await redis.zcard(key));
    return Number.isFinite(value) ? value : 0;
  }

  async function snapshot() {
    return { count: await count(), timestamp: now() };
  }

  async function publishCount() {
    let payload;
    try {
      payload = await snapshot();
    } catch {
      return;
    }
    try {
      await redis.publish(channel, JSON.stringify({ ...payload, instanceId }));
    } catch {}
    // Local SSE subscribers must not wait for their own pub/sub message, and
    // self-published messages are filtered out by the subscriber below.
    broadcast(payload);
  }

  function broadcast(payload) {
    return broadcastToLocal(local, payload);
  }

  async function join(clientId, res, principalKey) {
    const id = normalizeClientId(clientId);
    if (!id || !res) return null;
    const member = globalMember(id, principalKey);
    const existing = local.get(id);
    const previousPrincipal = existing?.principalKey;
    if (existing) {
      local.delete(id);
      try { existing.res?.end(); } catch {}
    }
    local.set(id, { res, principalKey: member, lastSeen: now() });
    const previous = await count();
    try {
      await redis.zadd(key, now(), member);
      // A reconnect with a rotated principal must not leave the old device
      // slot behind once this process no longer holds it.
      if (previousPrincipal && previousPrincipal !== member && !hasLocalPrincipal(previousPrincipal)) {
        await redis.zrem(key, previousPrincipal);
      }
    } catch (error) {
      local.delete(id);
      throw error;
    }
    const current = await count();
    if (current !== previous) await publishCount();
    return { joined: !existing, count: current };
  }

  async function touch(clientId, principalKey) {
    const id = normalizeClientId(clientId);
    if (!id) return false;
    const member = globalMember(id, principalKey);
    const nowMs = now();
    const session = local.get(id);
    if (session) session.lastSeen = nowMs;
    // A heartbeat may arrive on a different instance than the SSE owner; the
    // shared sorted set is what keeps the client alive globally.
    await redis.zadd(key, nowMs, member);
    return true;
  }

  async function leave(clientId, res) {
    const id = normalizeClientId(clientId);
    if (!id) return false;
    const session = local.get(id);
    if (!session) return false;
    if (res && session.res !== res) return false;
    local.delete(id);
    const previous = await count();
    // Only the last connection of a principal may release its global slot.
    // Other instances keep the slot alive through their own tabs' heartbeats.
    if (!hasLocalPrincipal(session.principalKey)) {
      try { await redis.zrem(key, session.principalKey); } catch {}
    }
    const current = await count();
    if (current !== previous) await publishCount();
    return true;
  }

  async function sweep(nowMs = now()) {
    const threshold = nowMs - ttlMs;
    let removed = 0;
    try {
      removed = Number(await redis.zremrangebyscore(key, '-inf', threshold)) || 0;
    } catch {}
    // Local backstop: evict sockets whose own lastSeen exceeded TTL and drop
    // their principal slot when this process no longer holds it. A global slot
    // may be briefly absent while another instance's tab still refreshes it,
    // so local sockets are never ended just because their member is missing.
    const ids = [...local.keys()];
    for (const id of ids) {
      const session = local.get(id);
      if (!session || nowMs - Number(session.lastSeen || 0) > ttlMs) {
        local.delete(id);
        if (session && !hasLocalPrincipal(session.principalKey)) {
          try { await redis.zrem(key, session.principalKey); } catch {}
        }
        try { session?.res?.end(); } catch {}
      }
    }
    if (removed > 0) await publishCount();
    return removed;
  }

  async function closeAll() {
    const principals = new Set();
    const closed = local.size;
    for (const session of local.values()) {
      try { session?.res?.end(); } catch {}
      if (session?.principalKey) principals.add(session.principalKey);
    }
    local.clear();
    if (principals.size) {
      try { await redis.zrem(key, ...principals); } catch {}
      try { await publishCount(); } catch {}
    }
    return closed;
  }

  async function start() {
    const onMessage = (receivedChannel, message) => {
      if (receivedChannel !== channel) return;
      try {
        const payload = JSON.parse(message);
        if (payload?.instanceId === instanceId) return;
        const value = Number(payload?.count);
        if (Number.isFinite(value)) {
          broadcast({ count: value, timestamp: Number(payload?.timestamp) || now() });
        }
      } catch {}
    };
    subscriber.on('message', onMessage);
    await subscriber.subscribe(channel);
    return async function stop() {
      subscriber.off('message', onMessage);
      try { await subscriber.unsubscribe(channel); } catch {}
    };
  }

  return { count, snapshot, normalizeClientId, join, touch, leave, sweep, closeAll, broadcast, start };
}

module.exports = { createRedisPresenceService };
