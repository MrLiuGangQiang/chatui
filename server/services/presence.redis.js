'use strict';

// Redis-backed presence for multi-instance deployments.
//
// The global online set lives in a Redis sorted set keyed by clientId whose
// score is the last-seen timestamp. Each process still keeps a local
// Map<clientId, {res}> because an SSE response object belongs to one Node
// process only; Redis stores "who is online globally", while the local map
// stores "which sockets this process must write to".
//
// Count changes are fanned out through Redis pub/sub so a join/leave/sweep on
// one instance refreshes SSE subscribers on every other instance. The wire
// contract (GET /api/presence, GET /api/presence/stream, POST
// /api/presence/heartbeat) is unchanged.

const { normalizePresenceClientId, PRESENCE_TTL_MS } = require('./presence.service');

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
  const local = new Map(); // clientId -> { res }

  function normalizeClientId(value) {
    return normalizePresenceClientId(value);
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

  async function join(clientId, res) {
    const id = normalizeClientId(clientId);
    if (!id || !res) return null;
    const existing = local.get(id);
    if (existing) {
      local.delete(id);
      try { existing.res?.end(); } catch {}
    }
    local.set(id, { res });
    const previous = await count();
    try {
      await redis.zadd(key, now(), id);
    } catch (error) {
      local.delete(id);
      throw error;
    }
    const current = await count();
    if (current !== previous) await publishCount();
    return { joined: !existing, count: current };
  }

  async function touch(clientId) {
    const id = normalizeClientId(clientId);
    if (!id) return false;
    // A heartbeat may arrive on a different instance than the SSE owner; the
    // shared sorted set is what keeps the client alive globally.
    await redis.zadd(key, now(), id);
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
    await redis.zrem(key, id);
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
    // A local SSE response must not outlive its global slot. Query each local
    // clientId against the shared set; if another instance or the global TTL
    // removed it, end this process's socket.
    const ids = [...local.keys()];
    for (const id of ids) {
      let present = true;
      try {
        present = (await redis.zscore(key, id)) !== null;
      } catch {}
      if (!present) {
        const session = local.get(id);
        local.delete(id);
        try { session?.res?.end(); } catch {}
      }
    }
    if (removed > 0) await publishCount();
    return removed;
  }

  async function closeAll() {
    const ids = [...local.keys()];
    const closed = local.size;
    for (const session of local.values()) {
      try { session?.res?.end(); } catch {}
    }
    local.clear();
    if (ids.length) {
      try { await redis.zrem(key, ...ids); } catch {}
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