'use strict';

// Presence service regression coverage for the exact failure modes this
// feature must never reintroduce:
//  1. the online count only ever grows (stale SSE connections must be swept by
//     TTL, and a reconnecting tab must reuse its slot instead of double
//     counting);
//  2. count changes must be broadcast to every live subscriber exactly when the
//     count changes, never on quiet joins/leaves.

const assert = require('assert');
const { createPresenceService } = require('../../server/services/presence.service');

function makeResponse(writes = []) {
  return {
    write(chunk) { writes.push(String(chunk)); return true; },
    flushHeaders() {},
    end() {},
  };
}

function testJoinIncrementsCountAndBroadcasts() {
  const service = createPresenceService();
  const firstWrites = [];
  const secondWrites = [];
  const first = makeResponse(firstWrites);
  const second = makeResponse(secondWrites);

  const result = service.join('pres-client-aaa', first);
  assert.deepStrictEqual(result, { joined: true, count: 1 });
  assert.strictEqual(service.count(), 1);
  // Second subscriber must receive the join broadcast immediately.
  const result2 = service.join('pres-client-bbb', second);
  assert.strictEqual(result2.count, 2);
  assert.strictEqual(firstWrites.length, 2, 'first subscriber must see both count changes');
  assert.strictEqual(secondWrites.length, 1, 'second subscriber must see its own join broadcast');
  assert.ok(firstWrites[0].includes('"count":1'), `broadcast must carry count 1, got: ${firstWrites[0]}`);
  assert.ok(firstWrites[1].includes('"count":2'), `broadcast must carry count 2, got: ${firstWrites[1]}`);
  assert.ok(secondWrites[0].includes('"count":2'), `broadcast must carry count 2, got: ${secondWrites[0]}`);
}

function testDuplicateClientIdReusesSlotWithoutDoubleCount() {
  const service = createPresenceService();
  const writes = [];
  const first = makeResponse(writes);
  const replacement = makeResponse(writes);
  service.join('pres-client-aaa', first);
  assert.strictEqual(service.count(), 1);

  // A network blip reconnects the same tab: the slot must be reused and the
  // stale response retired, so the count stays 1.
  const result = service.join('pres-client-aaa', replacement);
  assert.deepStrictEqual(result, { joined: false, count: 1 });
  assert.strictEqual(service.count(), 1);
  assert.strictEqual(writes.length, 1, 'a quiet reconnect must not broadcast a phantom count change');
}

function testLeaveDecrementsAndBroadcasts() {
  const service = createPresenceService();
  const writes = [];
  const first = makeResponse(writes);
  const second = makeResponse(writes);
  service.join('pres-client-aaa', first);
  service.join('pres-client-bbb', second);

  assert.strictEqual(service.leave('pres-client-aaa'), true);
  assert.strictEqual(service.count(), 1);
  assert.ok(writes.at(-1).includes('"count":1'), `leave must broadcast count 1, got: ${writes.at(-1)}`);

  assert.strictEqual(service.leave('pres-client-aaa'), false, 'leaving an unknown id must be a no-op');
  assert.strictEqual(service.count(), 1);
  assert.strictEqual(writes.length, 4, 'a no-op leave must not broadcast');
}

function testSweepRemovesOnlyStaleSessionsAndBroadcasts() {
  let now = 1000;
  const service = createPresenceService({ ttlMs: 500, now: () => now });
  const writes = [];
  const alive = makeResponse(writes);
  const stale = makeResponse(writes);
  service.join('pres-client-alive', alive);
  service.join('pres-client-stale', stale);

  now += 400;
  service.touch('pres-client-alive'); // heartbeat keeps this one fresh
  now += 300; // stale session is now 700ms old (> ttl), alive is 300ms old
  assert.strictEqual(service.sweep(), 1, 'sweep must evict only the stale session');
  assert.strictEqual(service.count(), 1);
  assert.ok(writes.at(-1).includes('"count":1'), 'sweep must broadcast the corrected count');
}

function testSweepKeepsFreshSessions() {
  let now = 1000;
  const service = createPresenceService({ ttlMs: 500, now: () => now });
  const writes = [];
  const first = makeResponse(writes);
  service.join('pres-client-aaa', first);
  now += 400;
  service.touch('pres-client-aaa');
  now += 400;
  assert.strictEqual(service.sweep(), 0, 'a heartbeat-fresh session must survive the sweep');
  assert.strictEqual(service.count(), 1);
}

function testCloseAllEndsEveryConnectionAndClearsCount() {
  const service = createPresenceService();
  let ended = 0;
  const res = { write() { return true; }, flushHeaders() {}, end() { ended += 1; } };
  service.join('pres-client-aaa', res);
  service.join('pres-client-bbb', res);
  assert.strictEqual(service.closeAll(), 2);
  assert.strictEqual(ended, 2, 'every active presence connection must be ended on shutdown');
  assert.strictEqual(service.count(), 0);
}

function testNormalizeClientIdRejectsInvalidValues() {
  const service = createPresenceService();
  for (const value of [null, undefined, '', 'short', 'x'.repeat(129), 'has space', 'bad/char', 'url?query']) {
    assert.strictEqual(service.normalizeClientId(value), null, `must reject: ${JSON.stringify(value)}`);
  }
  assert.strictEqual(service.normalizeClientId('pres-abc-123'), 'pres-abc-123');
}

function testBroadcastSkipsBrokenResponsesAndCleansThemUp() {
  const service = createPresenceService();
  let failWrites = false;
  const broken = {
    write() { if (failWrites) throw new Error('socket gone'); return true; },
    flushHeaders() {},
    end() {},
  };
  const healthyWrites = [];
  const healthy = makeResponse(healthyWrites);
  service.join('pres-client-broken', broken);
  service.join('pres-client-ok', healthy);
  assert.strictEqual(service.count(), 2);

  // The next count change trips the broken socket: it must be removed instead
  // of keeping a phantom online count, and healthy subscribers still receive
  // the broadcast.
  failWrites = true;
  service.join('pres-client-third', makeResponse());
  assert.strictEqual(service.count(), 2, 'a failing subscriber must be removed, not counted forever');
  assert.ok(healthyWrites.some(w => w.includes('"count":3')), 'healthy subscribers must still receive the broadcast');
}

function testOldConnectionCloseMustNotRemoveReplacementSession() {
  const service = createPresenceService();
  const oldWrites = [];
  const newWrites = [];
  const oldRes = makeResponse(oldWrites);
  const newRes = makeResponse(newWrites);
  service.join('pres-client-aaa', oldRes);
  assert.strictEqual(service.count(), 1);

  // The same tab reconnects: the slot is replaced with the new connection.
  service.join('pres-client-aaa', newRes);
  assert.strictEqual(service.count(), 1);

  // The stale connection then closes; it must not remove the replacement.
  service.leave('pres-client-aaa', oldRes);
  assert.strictEqual(service.count(), 1, 'closing the stale connection must not remove the replacement session');
  service.leave('pres-client-aaa', newRes);
  assert.strictEqual(service.count(), 0);
}

function testLoadClientIdIsPerTabAndStableAcrossReloads() {
  const { loadClientId } = require('../../client/services/presence');
  const makeStorage = () => {
    const store = new Map();
    return {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
    };
  };
  const tabA = makeStorage();
  const tabB = makeStorage();
  const idA1 = loadClientId(tabA);
  const idA2 = loadClientId(tabA);
  const idB = loadClientId(tabB);
  assert.strictEqual(idA1, idA2, 'a reload in the same tab must reuse the same id (no double count)');
  assert.notStrictEqual(idA1, idB, 'a second tab must get its own id so tabs are counted separately');
  assert.strictEqual(tabA.getItem('chatui-presence-client-id-v1'), idA1, 'the id must be persisted in the tab storage');
}

module.exports = [
  testJoinIncrementsCountAndBroadcasts,
  testDuplicateClientIdReusesSlotWithoutDoubleCount,
  testLeaveDecrementsAndBroadcasts,
  testSweepRemovesOnlyStaleSessionsAndBroadcasts,
  testSweepKeepsFreshSessions,
  testCloseAllEndsEveryConnectionAndClearsCount,
  testNormalizeClientIdRejectsInvalidValues,
  testBroadcastSkipsBrokenResponsesAndCleansThemUp,
  testOldConnectionCloseMustNotRemoveReplacementSession,
  testLoadClientIdIsPerTabAndStableAcrossReloads,
];