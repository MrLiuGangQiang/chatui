'use strict';

// Redis presence service regression coverage with a fake Redis client. These
// tests pin the multi-instance failure modes the in-memory service cannot
// catch: the global count must live in the shared sorted set, a heartbeat may
// arrive on a different instance than the SSE owner, and count changes must be
// fanned out through pub/sub to other instances.

const assert = require('assert');
const { createRedisPresenceService } = require('../../server/services/presence.redis');

function makeRedis() {
  const members = new Map(); // member -> score
  const published = [];
  return {
    members,
    published,
    async zadd(key, score, member) {
      members.set(member, Number(score));
      return 1;
    },
    async zcard(key) {
      return members.size;
    },
    async zrem(key, ...membersToRemove) {
      let removed = 0;
      for (const member of membersToRemove) {
        if (members.delete(member)) removed += 1;
      }
      return removed;
    },
    async zremrangebyscore(key, min, max) {
      let removed = 0;
      for (const [member, score] of members) {
        if (score <= Number(max)) {
          members.delete(member);
          removed += 1;
        }
      }
      return removed;
    },
    async zscore(key, member) {
      return members.has(member) ? String(members.get(member)) : null;
    },
    async publish(channel, message) {
      published.push({ channel, message });
      return 1;
    },
  };
}

function makeSubscriber() {
  const handlers = {};
  return {
    subscribed: [],
    handlers,
    on(event, fn) { handlers[event] = fn; return this; },
    off(event, fn) { if (handlers[event] === fn) delete handlers[event]; return this; },
    async subscribe(channel) { this.subscribed.push(channel); return 1; },
    async unsubscribe(channel) { return 1; },
    emit(event, channel, message) { handlers[event]?.(channel, message); },
  };
}

function makeResponse(writes = []) {
  return {
    write(chunk) { writes.push(String(chunk)); return true; },
    flushHeaders() {},
    end() {},
  };
}

async function testRedisJoinCountsFromSharedSortedSet() {
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis });
  assert.strictEqual(await service.count(), 0);

  await service.join('pres-client-aaa', makeResponse());
  await service.join('pres-client-bbb', makeResponse());
  assert.strictEqual(await service.count(), 2);
  assert.strictEqual(redis.members.size, 2, 'both clientIds must be in the shared sorted set');
  const snapshot = await service.snapshot();
  assert.strictEqual(snapshot.count, 2);
  assert.strictEqual(typeof snapshot.timestamp, 'number');
}

async function testRedisDuplicateClientIdReusesLocalSlotWithoutDoubleCount() {
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis });
  const first = makeResponse();
  await service.join('pres-client-aaa', first);
  assert.strictEqual(await service.count(), 1);

  const replacement = makeResponse();
  const result = await service.join('pres-client-aaa', replacement);
  assert.deepStrictEqual(result, { joined: false, count: 1 });
  assert.strictEqual(await service.count(), 1);
  assert.strictEqual(redis.members.size, 1, 'reconnecting the same tab must reuse one global slot');
}

async function testRedisHeartbeatCanArriveOnAnotherInstance() {
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis, ttlMs: 100, now: () => 1000 });
  await service.join('pres-client-aaa', makeResponse());
  // Another instance only knows the clientId, not this process's SSE response.
  assert.strictEqual(await service.touch('pres-client-aaa'), true);
  assert.strictEqual(redis.members.get('pres-client-aaa'), 1000, 'the heartbeat must refresh the shared score');
}

async function testRedisSweepRemovesStaleSlotsAndEndsLocalConnections() {
  let now = 1000;
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis, ttlMs: 500, now: () => now });
  const aliveWrites = [];
  const staleWrites = [];
  await service.join('pres-client-alive', makeResponse(aliveWrites));
  await service.join('pres-client-stale', makeResponse(staleWrites));

  now += 400;
  await service.touch('pres-client-alive');
  now += 300; // stale=700ms, alive=300ms
  assert.strictEqual(await service.sweep(), 1, 'sweep must evict only the stale global slot');
  assert.strictEqual(await service.count(), 1);
  assert.strictEqual(redis.members.has('pres-client-stale'), false);
}

async function testRedisLeaveRemovesSlotAndPublishesCount() {
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis });
  await service.join('pres-client-aaa', makeResponse());
  await service.join('pres-client-bbb', makeResponse());
  redis.published.length = 0;

  assert.strictEqual(await service.leave('pres-client-aaa'), true);
  assert.strictEqual(await service.count(), 1);
  assert.strictEqual(redis.members.has('pres-client-aaa'), false);
  assert.ok(redis.published.some(event => event.message.includes('"count":1')), 'leave must publish the corrected global count');
  assert.strictEqual(await service.leave('pres-client-aaa'), false, 'leaving an unknown id must be a no-op');
}

async function testRedisCloseAllEndsLocalConnectionsAndRemovesTheirSlots() {
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis });
  let ended = 0;
  const res = { write() { return true; }, flushHeaders() {}, end() { ended += 1; } };
  await service.join('pres-client-aaa', res);
  await service.join('pres-client-bbb', res);

  assert.strictEqual(await service.closeAll(), 2);
  assert.strictEqual(ended, 2, 'every local presence connection must be ended on shutdown');
  assert.strictEqual(await service.count(), 0);
  assert.strictEqual(redis.members.size, 0, 'closeAll must remove the local clientIds from Redis');
}

async function testRedisStartBroadcastsPublishedCountToLocalSubscribers() {
  const redis = makeRedis();
  const subscriber = makeSubscriber();
  const service = createRedisPresenceService({ redis, subscriber, now: () => 4321 });
  const writes = [];
  await service.join('pres-client-aaa', makeResponse(writes));

  await service.start();
  assert.ok(subscriber.subscribed.includes('chatui:presence:events'), 'the service must subscribe to the presence channel');

  subscriber.emit('message', 'chatui:presence:events', JSON.stringify({ count: 5, timestamp: 4321 }));
  assert.ok(writes.at(-1).includes('"count":5'), 'a pub/sub count change must be written to every local SSE subscriber');
}

async function testRedisSamePrincipalAcrossInstancesCountsOnce() {
  const redis = makeRedis();
  const instanceA = createRedisPresenceService({ redis, instanceId: 'instance-a' });
  const instanceB = createRedisPresenceService({ redis, instanceId: 'instance-b' });
  await instanceA.join('pres-client-tab-a', makeResponse(), 'principal-device-1');
  await instanceB.join('pres-client-tab-b', makeResponse(), 'principal-device-1');
  assert.strictEqual(await instanceA.count(), 1, 'the same device on two instances must count once');
  assert.strictEqual(redis.members.size, 1, 'the shared sorted set must hold a single principal slot');
}

async function testRedisLeaveRemovesPrincipalOnlyAfterLastLocalConnection() {
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis });
  const first = makeResponse();
  const second = makeResponse();
  await service.join('pres-client-tab-a', first, 'principal-device-1');
  await service.join('pres-client-tab-b', second, 'principal-device-1');
  assert.strictEqual(await service.count(), 1);
  assert.strictEqual(await service.leave('pres-client-tab-a', first), true);
  assert.strictEqual(await service.count(), 1, 'closing one tab must keep the device online');
  assert.strictEqual(await service.leave('pres-client-tab-b', second), true);
  assert.strictEqual(await service.count(), 0, 'closing the last tab must release the device slot');
  assert.strictEqual(redis.members.size, 0);
}

async function testRedisHeartbeatRefreshesPrincipalScoreOnAnotherInstance() {
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis, ttlMs: 100, now: () => 1000 });
  await service.join('pres-client-tab-a', makeResponse(), 'principal-device-1');
  assert.strictEqual(await service.touch('pres-client-zzz', 'principal-device-1'), true);
  assert.strictEqual(redis.members.get('principal-device-1'), 1000, 'a heartbeat must refresh the principal score in the shared set');
}

async function testRedisLocalSweepEvictsStaleSocketByLocalLastSeen() {
  let now = 1000;
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis, ttlMs: 500, now: () => now });
  let ended = 0;
  const res = { write() { return true; }, flushHeaders() {}, end() { ended += 1; } };
  await service.join('pres-client-stale', res, 'principal-device-1');
  now += 600; // local lastSeen is now 600ms old (> ttl)
  assert.strictEqual(await service.sweep(), 1, 'the stale global slot must be swept');
  assert.strictEqual(ended, 1, 'the local socket whose lastSeen expired must be ended');
  assert.strictEqual(await service.count(), 0);
}

async function testRedisJoinReconnectWithRotatedPrincipalDropsOldSlot() {
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis });
  const first = makeResponse();
  const replacement = makeResponse();
  await service.join('pres-client-aaa', first, 'principal-old');
  assert.strictEqual(await service.count(), 1);
  await service.join('pres-client-aaa', replacement, 'principal-new');
  assert.strictEqual(await service.count(), 1, 'reconnecting with a rotated principal must not double count');
  assert.strictEqual(redis.members.has('principal-old'), false, 'the rotated-away principal slot must not linger');
  assert.strictEqual(redis.members.has('principal-new'), true);
}

async function testRedisJoinBroadcastsLocallyWithoutWaitingForPubSub() {
  const redis = makeRedis();
  const service = createRedisPresenceService({ redis, instanceId: 'instance-a' });
  const firstWrites = [];
  const secondWrites = [];
  await service.join('pres-client-aaa', makeResponse(firstWrites));
  await service.join('pres-client-bbb', makeResponse(secondWrites));
  assert.ok(firstWrites[0].includes('"count":1'), 'the first join must be written locally before any pub/sub round trip');
  assert.ok(firstWrites[1].includes('"count":2'), 'the second join must refresh the first local subscriber');
  assert.ok(secondWrites[0].includes('"count":2'), 'the second join must refresh the joining subscriber');
}
module.exports = [
  testRedisJoinCountsFromSharedSortedSet,
  testRedisDuplicateClientIdReusesLocalSlotWithoutDoubleCount,
  testRedisHeartbeatCanArriveOnAnotherInstance,
  testRedisSweepRemovesStaleSlotsAndEndsLocalConnections,
  testRedisLeaveRemovesSlotAndPublishesCount,
  testRedisCloseAllEndsLocalConnectionsAndRemovesTheirSlots,
  testRedisStartBroadcastsPublishedCountToLocalSubscribers,
  testRedisJoinBroadcastsLocallyWithoutWaitingForPubSub,
  testRedisSamePrincipalAcrossInstancesCountsOnce,
  testRedisLeaveRemovesPrincipalOnlyAfterLastLocalConnection,
  testRedisHeartbeatRefreshesPrincipalScoreOnAnotherInstance,
  testRedisLocalSweepEvictsStaleSocketByLocalLastSeen,
  testRedisJoinReconnectWithRotatedPrincipalDropsOldSlot,
];