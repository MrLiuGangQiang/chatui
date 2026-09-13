'use strict';

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const MAX_WRITE_CHUNK_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

function unrefTimer(timer) {
  try { timer?.unref?.(); } catch {}
  return timer;
}

function utf8Chunks(value, maxBytes = MAX_WRITE_CHUNK_BYTES) {
  const text = String(value || '');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return [text];
  const chunks = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === start) end = Math.min(start + maxBytes, bytes.length);
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return chunks;
}

function createSseWriter(res, options = {}) {
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : DEFAULT_HEARTBEAT_MS;
  const drainTimeoutMs = Number.isFinite(options.drainTimeoutMs) ? options.drainTimeoutMs : DEFAULT_DRAIN_TIMEOUT_MS;
  const maxFrameBytes = Number.isFinite(options.maxFrameBytes) ? options.maxFrameBytes : MAX_FRAME_BYTES;
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};

  let closed = false;
  let closing = false;
  let activeFrame = null;
  let blocked = false;
  let drainListener = null;
  let drainTimer = null;
  let drainTimerToken = 0;
  let heartbeatTimer = null;
  let closeNotified = false;
  let responseCloseListener = null;
  let responseErrorListener = null;

  function clearDrainTimer() {
    if (!drainTimer) return;
    clearTimeoutImpl(drainTimer);
    drainTimer = null;
    drainTimerToken += 1;
  }

  function removeDrainListener() {
    if (!drainListener) return;
    try {
      if (typeof res.removeListener === 'function') res.removeListener('drain', drainListener);
      else res.off?.('drain', drainListener);
    } catch {}
    drainListener = null;
  }

  function clearHeartbeat() {
    if (!heartbeatTimer) return;
    clearIntervalImpl(heartbeatTimer);
    heartbeatTimer = null;
  }

  function removeResponseListeners() {
    try {
      if (responseCloseListener && typeof res.removeListener === 'function') res.removeListener('close', responseCloseListener);
      if (responseErrorListener && typeof res.removeListener === 'function') res.removeListener('error', responseErrorListener);
    } catch {}
    responseCloseListener = null;
    responseErrorListener = null;
  }

  function notifyClosed(reason) {
    if (closeNotified) return;
    closeNotified = true;
    onClose(reason);
  }

  function endResponse(reason = 'close') {
    if (closed) return;
    closed = true;
    clearHeartbeat();
    clearDrainTimer();
    removeDrainListener();
    removeResponseListeners();
    activeFrame = null;
    blocked = false;
    try { res.end?.(); } catch {}
    notifyClosed(reason);
  }

  function destroyResponse(reason = 'destroy') {
    if (closed) return;
    closed = true;
    clearHeartbeat();
    clearDrainTimer();
    removeDrainListener();
    removeResponseListeners();
    activeFrame = null;
    blocked = false;
    try {
      if (typeof res.destroy === 'function') res.destroy();
      else res.end?.();
    } catch {}
    notifyClosed(reason);
  }

  function finishFrame() {
    const frame = activeFrame;
    activeFrame = null;
    try { frame?.onAccepted?.(); } catch (error) { destroyResponse(error); return; }
    if (closing && !activeFrame && !blocked) endResponse('finish');
  }

  function pump() {
    if (closed || blocked || !activeFrame) return;
    while (!closed && !blocked && activeFrame) {
      const frame = activeFrame;
      if (frame.index >= frame.chunks.length) {
        finishFrame();
        return;
      }
      const chunk = frame.chunks[frame.index];
      let accepted = true;
      try {
        accepted = res.write(chunk) !== false;
      } catch (error) {
        destroyResponse(error);
        return;
      }
      frame.index += 1;
      if (!accepted) {
        blocked = true;
        drainListener = () => {
          if (closed) return;
          blocked = false;
          clearDrainTimer();
          removeDrainListener();
          pump();
        };
        try {
          if (typeof res.once === 'function') res.once('drain', drainListener);
          else if (typeof res.on === 'function') res.on('drain', drainListener);
          else {
            destroyResponse(new Error('SSE response cannot observe drain'));
            return;
          }
        } catch (error) {
          destroyResponse(error);
          return;
        }
        const token = ++drainTimerToken;
        drainTimer = unrefTimer(setTimeoutImpl(() => {
          if (token === drainTimerToken && blocked) destroyResponse('drain-timeout');
        }, drainTimeoutMs));
        return;
      }
    }
  }

  function enqueue(frame, onAccepted) {
    if (closed || closing || activeFrame) return false;
    const text = String(frame || '');
    if (Buffer.byteLength(text, 'utf8') > maxFrameBytes) {
      destroyResponse('frame-too-large');
      return false;
    }
    activeFrame = {
      chunks: utf8Chunks(text),
      index: 0,
      onAccepted,
    };
    pump();
    return true;
  }

  function heartbeat() {
    if (closed || closing || blocked || activeFrame) return false;
    return enqueue(': keepalive\n\n');
  }

  function finish() {
    if (closed) return;
    closing = true;
    clearHeartbeat();
    if (!activeFrame && !blocked) endResponse('finish');
  }

  function abort(reason = 'abort') {
    destroyResponse(reason);
  }

  if (typeof res.once === 'function') {
    responseCloseListener = () => destroyResponse('response-close');
    responseErrorListener = error => destroyResponse(error || 'response-error');
    try {
      res.once('close', responseCloseListener);
      res.once('error', responseErrorListener);
    } catch {}
  }
  heartbeatTimer = unrefTimer(setIntervalImpl(heartbeat, heartbeatMs));

  return {
    enqueue,
    heartbeat,
    finish,
    close: finish,
    abort,
    destroy: abort,
    isClosed: () => closed,
    isBlocked: () => blocked,
    isIdle: () => !closed && !blocked && !activeFrame,
    hasPending: () => !!activeFrame || blocked,
  };
}

module.exports = {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  MAX_WRITE_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  createSseWriter,
};
