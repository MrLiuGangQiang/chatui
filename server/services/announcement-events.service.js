'use strict';

const fs = require('fs');
const { readAnnouncements, RUNTIME_ANNOUNCEMENT_FILENAME } = require('./announcements.service');
const { SECURITY_HEADERS } = require('../http/response');

const DEFAULT_ANNOUNCEMENT_DEBOUNCE_MS = 120;
const DEFAULT_ANNOUNCEMENT_HEARTBEAT_MS = 5 * 60 * 1000;

const ANNOUNCEMENT_SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'Access-Control-Allow-Origin': '*',
});

function normalizeAnnouncements(value) {
  return Array.isArray(value) ? value.slice(0, 1) : [];
}

function announcementSnapshot(announcements) {
  const items = normalizeAnnouncements(announcements);
  const version = String(items[0]?.version || '').trim();
  return {
    announcements: items,
    version,
    signature: version ? `announcement:${version}` : 'announcement:empty',
  };
}

function announcementEventFrame(snapshot) {
  const lines = ['retry: 5000'];
  if (snapshot?.version) lines.push(`id: ${snapshot.version}`);
  lines.push('event: announcement');
  lines.push(`data: ${JSON.stringify({ announcements: normalizeAnnouncements(snapshot?.announcements) })}`);
  return `${lines.join('\n')}\n\n`;
}

function createAnnouncementEvents({
  runtimeDir,
  readAnnouncementsImpl = readAnnouncements,
  watchImpl = fs.watch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  debounceMs = DEFAULT_ANNOUNCEMENT_DEBOUNCE_MS,
  heartbeatMs = DEFAULT_ANNOUNCEMENT_HEARTBEAT_MS,
} = {}) {
  const subscriptions = new Map();
  const watch = typeof watchImpl === 'function' ? watchImpl.bind(fs) : fs.watch.bind(fs);
  const schedule = typeof setTimeoutImpl === 'function' ? setTimeoutImpl : setTimeout;
  const clearSchedule = typeof clearTimeoutImpl === 'function' ? clearTimeoutImpl : clearTimeout;
  const heartbeatEvery = typeof setIntervalImpl === 'function' ? setIntervalImpl : setInterval;
  const clearHeartbeat = typeof clearIntervalImpl === 'function' ? clearIntervalImpl : clearInterval;
  const debounceDelay = Math.max(0, Number(debounceMs) || 0);
  const heartbeatDelay = Math.max(0, Number(heartbeatMs) || 0);
  let watcher = null;
  let debounceTimer = null;
  let currentSignature = null;
  let closed = false;

  function readSnapshot() {
    try {
      return announcementSnapshot(readAnnouncementsImpl({ runtimeDir }));
    } catch {
      return announcementSnapshot([]);
    }
  }

  function removeSubscription(res, { end = false } = {}) {
    const subscription = subscriptions.get(res);
    if (!subscription) return false;
    subscriptions.delete(res);
    clearHeartbeat(subscription.heartbeatTimer);
    subscription.cleanup();
    if (end) {
      try { res.end?.(); } catch {}
    }
    return true;
  }

  function writeSnapshot(res, snapshot) {
    try {
      res.write(announcementEventFrame(snapshot));
      res.flushHeaders?.();
      return true;
    } catch {
      removeSubscription(res, { end: true });
      return false;
    }
  }

  function publish(snapshot, { force = false } = {}) {
    const next = snapshot || readSnapshot();
    if (!force && next.signature === currentSignature) return 0;
    currentSignature = next.signature;
    let delivered = 0;
    for (const res of [...subscriptions.keys()]) {
      if (writeSnapshot(res, next)) delivered += 1;
    }
    return delivered;
  }

  function closeWatcher() {
    if (!watcher) return;
    const current = watcher;
    watcher = null;
    try { current.close?.(); } catch {}
  }

  function restartAfterWatcherError() {
    closeWatcher();
    for (const res of [...subscriptions.keys()]) removeSubscription(res, { end: true });
  }

  function handleWatchEvent(eventType, filename) {
    if (closed) return;
    if (filename && filename !== RUNTIME_ANNOUNCEMENT_FILENAME) return;
    if (debounceTimer) clearSchedule(debounceTimer);
    debounceTimer = schedule(() => {
      debounceTimer = null;
      if (!closed) publish(readSnapshot());
    }, debounceDelay);
    debounceTimer?.unref?.();
  }

  function ensureWatcher() {
    if (closed || watcher || !runtimeDir) return;
    try {
      watcher = watch(runtimeDir, { persistent: false }, handleWatchEvent);
      watcher?.on?.('error', restartAfterWatcherError);
    } catch {
      watcher = null;
    }
  }

  function subscribe(req, res) {
    if (closed || !res) return false;
    ensureWatcher();
    const snapshot = readSnapshot();
    currentSignature = snapshot.signature;
    res.writeHead(200, { ...SECURITY_HEADERS, ...ANNOUNCEMENT_SSE_HEADERS });
    res.flushHeaders?.();

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      subscriptions.delete(res);
      clearHeartbeat(heartbeatTimer);
      req?.removeListener?.('close', dispose);
      res?.removeListener?.('close', dispose);
    };
    const heartbeatTimer = heartbeatEvery(() => {
      if (disposed) return;
      try { res.write(': keepalive\n\n'); } catch { removeSubscription(res, { end: true }); }
    }, heartbeatDelay);
    heartbeatTimer?.unref?.();
    subscriptions.set(res, { cleanup: dispose, heartbeatTimer });
    req?.once?.('close', dispose) || req?.on?.('close', dispose);
    res?.once?.('close', dispose) || res?.on?.('close', dispose);
    writeSnapshot(res, snapshot);
    return true;
  }

  function close() {
    if (closed) return 0;
    closed = true;
    if (debounceTimer) clearSchedule(debounceTimer);
    debounceTimer = null;
    closeWatcher();
    const count = subscriptions.size;
    for (const res of [...subscriptions.keys()]) removeSubscription(res, { end: true });
    return count;
  }

  return Object.freeze({
    close,
    publish,
    readSnapshot,
    subscribe,
  });
}

module.exports = {
  ANNOUNCEMENT_SSE_HEADERS,
  DEFAULT_ANNOUNCEMENT_DEBOUNCE_MS,
  DEFAULT_ANNOUNCEMENT_HEARTBEAT_MS,
  announcementEventFrame,
  announcementSnapshot,
  createAnnouncementEvents,
};