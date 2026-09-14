const { SECURITY_HEADERS } = require('../http/response');
const { createSseWriter } = require('../http/sse-writer');
const { safeLog, redactUrl } = require('../logging/safe-log');
const { getJobIdFromUrl } = require('./job-url');
const { findOwnedJob, jobOwnedBy } = require('../security/job-ownership');
const { JOB_NOT_FOUND_MESSAGE, JOB_SSE_HEADERS } = require('./http-contract');
const { requestJobCancellation } = require('./cancellation');

const COMPACT_FRAME_UNITS = 8192;
const PUMP_FRAME_LIMIT = 16;
const LIVE_MERGE_MS = 25;
const activeSubscriberSets = new WeakMap();

function isTerminal(job) {
  return job.status === 'done' || job.status === 'error';
}

function jobText(job) {
  const message = job.data?.choices?.[0]?.message;
  return {
    authoritative: typeof message?.content === 'string' || typeof message?.reasoning_content === 'string',
    content: String(message?.content || ''),
    reasoning: String(message?.reasoning_content || ''),
  };
}

function compactJobFrame(job, options = {}) {
  const text = jobText(job);
  const contentOffset = Math.max(0, Number(options.contentOffset || 0) || 0);
  const reasoningOffset = Math.max(0, Number(options.reasoningOffset || 0) || 0);
  const reset = options.snapshot === true || contentOffset > text.content.length || reasoningOffset > text.reasoning.length;
  const contentStart = reset ? 0 : contentOffset;
  const reasoningStart = reset ? 0 : reasoningOffset;
  const d = text.content.slice(contentStart, contentStart + COMPACT_FRAME_UNITS);
  const r = text.reasoning.slice(reasoningStart, reasoningStart + COMPACT_FRAME_UNITS - d.length);
  const nextContentOffset = contentStart + d.length;
  const nextReasoningOffset = reasoningStart + r.length;
  const remaining = nextContentOffset < text.content.length || nextReasoningOffset < text.reasoning.length;
  const terminal = isTerminal(job) && !remaining;
  const payload = {};
  if (reset && (text.content || text.reasoning)) payload.z = 1;
  if (d) payload.d = d;
  if (r) payload.r = r;
  if (options.sendFirstToken === true && Number.isFinite(job.firstTokenMs) && job.firstTokenMs >= 0) payload.ft = job.firstTokenMs;
  if (terminal) {
    if (job.status === 'done') payload.done = 1;
    else payload.e = job.error || '任务失败';
    if (Number.isFinite(job.durationMs) && job.durationMs >= 0) payload.rt = job.durationMs;
  }
  return {
    payload: Object.keys(payload).length ? payload : null,
    contentOffset: nextContentOffset,
    reasoningOffset: nextReasoningOffset,
    terminal,
    reset,
  };
}
function publicJob(job, options = {}) {
  const metrics = {
    firstTokenMs: Number.isFinite(job.firstTokenMs) ? job.firstTokenMs : null,
    durationMs: Number.isFinite(job.durationMs) ? job.durationMs : null,
  };
  const minimalCompact = (options.live === true || options.resumeUrl) && job.compactStream === true;
  if (minimalCompact) {
    let contentOffset = 0;
    let reasoningOffset = 0;
    if (options.resumeUrl) {
      const url = new URL(options.resumeUrl, 'http://localhost');
      contentOffset = Math.max(0, Number(url.searchParams.get('contentLength') || 0) || 0);
      reasoningOffset = Math.max(0, Number(url.searchParams.get('reasoningLength') || 0) || 0);
    }
    const frame = compactJobFrame(job, {
      contentOffset,
      reasoningOffset,
      sendFirstToken: !options.resumeUrl && !job.firstTokenNotified,
    });
    return frame.payload || {};
  }
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    data: job.data || null,
    metrics,
    error: job.error ? { message: job.error } : null,
  };
}

function compactResumeSnapshot(job, req) {
  return publicJob(job, { resumeUrl: req.url });
}

function createJobEvents({
  jobSubscribers,
  writerOptions = {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setImmediateImpl = setImmediate,
  clearImmediateImpl = clearImmediate,
}) {
  const activeSubscribers = activeSubscriberSets.get(jobSubscribers) || new Set();
  activeSubscriberSets.set(jobSubscribers, activeSubscribers);
  const responseSubscribers = new WeakMap();
  function clearScheduledPump(subscriber) {
    if (subscriber.mergeTimer) clearTimeoutImpl(subscriber.mergeTimer);
    if (subscriber.immediate) clearImmediateImpl(subscriber.immediate);
    subscriber.mergeTimer = null;
    subscriber.immediate = null;
  }

  function detachBinding(subscriber, binding) {
    if (subscriber.bindings.get(binding.job.id) !== binding) return;
    const id = binding.job.id;
    subscriber.bindings.delete(id);
    subscriber.dirty.delete(binding.job);
    const set = jobSubscribers.get(id);
    set?.delete(subscriber);
    if (set && !set.size) jobSubscribers.delete(id);
  }

  function cleanupSubscriber(subscriber) {
    if (subscriber.closed) return;
    subscriber.closed = true;
    clearScheduledPump(subscriber);
    for (const binding of [...subscriber.bindings.values()]) detachBinding(subscriber, binding);
    subscriber.dirty.clear();
    subscriber.initial.length = 0;
    activeSubscribers.delete(subscriber);
    try { subscriber.req.removeListener?.('close', subscriber.onRequestClose); } catch {}
  }

  function finishIfEmpty(subscriber) {
    if (!subscriber.closed && !subscriber.bindings.size && !subscriber.initial.length) subscriber.writer.finish();
  }

  function createSubscriber(req, res) {
    const subscriber = {
      req,
      res,
      principal: req.authPrincipal,
      bindings: new Map(),
      dirty: new Set(),
      initial: [],
      mergeTimer: null,
      immediate: null,
      pumping: false,
      closed: false,
      writer: null,
    };
    if (responseSubscribers.has(res)) return responseSubscribers.get(res);
    responseSubscribers.set(res, subscriber);
    activeSubscribers.add(subscriber);
    subscriber.writer = createSseWriter(res, {
      ...writerOptions,
      onClose: () => cleanupSubscriber(subscriber),
    });
    subscriber.close = reason => {
      if (subscriber.closed) return;
      cleanupSubscriber(subscriber);
      if (reason === 'shutdown' && subscriber.writer.isIdle()) subscriber.writer.finish();
      else subscriber.writer.abort(reason);
    };
    subscriber.onRequestClose = () => subscriber.close('request-close');
    req.on?.('close', subscriber.onRequestClose);
    return subscriber;
  }

  function bindInitialJob(subscriber, job, offset) {
    const binding = {
      job,
      contentOffset: offset.contentLength,
      reasoningOffset: offset.reasoningLength,
      initial: true,
      legacyDelta: null,
      firstTokenSent: false,
    };
    subscriber.bindings.set(job.id, binding);
    if (!jobSubscribers.has(job.id)) jobSubscribers.set(job.id, new Set());
    jobSubscribers.get(job.id).add(subscriber);
    subscriber.initial.push({ id: job.id, binding });
  }

  function frameForBinding(binding) {
    const job = binding.job;
    const text = jobText(job);
    if (job.compactStream !== true) {
      return {
        payload: publicJob(job),
        contentOffset: text.content.length,
        reasoningOffset: text.reasoning.length,
        terminal: isTerminal(job),
      };
    }

    // Old metadata-only job objects retain their public delta contract. Managed
    // chat jobs always have an aggregate and never read streamDelta here.
    const legacy = !text.authoritative && !binding.initial ? binding.legacyDelta || {} : {};
    const sourceJob = text.authoritative ? job : {
      ...job,
      data: { choices: [{ message: { content: String(legacy.content || ''), reasoning_content: String(legacy.reasoning || '') } }] },
    };
    const frame = compactJobFrame(sourceJob, {
      contentOffset: text.authoritative ? binding.contentOffset : 0,
      reasoningOffset: text.authoritative ? binding.reasoningOffset : 0,
      sendFirstToken: !binding.firstTokenSent,
    });
    return { ...frame, legacy: !text.authoritative, legacySent: !text.authoritative ? { content: frame.payload?.d || '', reasoning: frame.payload?.r || '' } : null };
  }

  function hasRemaining(binding) {
    if (binding.job.compactStream !== true) return false;
    const text = jobText(binding.job);
    if (text.authoritative) return binding.contentOffset !== text.content.length || binding.reasoningOffset !== text.reasoning.length;
    return !!(binding.legacyDelta?.content || binding.legacyDelta?.reasoning);
  }

  function acceptFrame(subscriber, binding, frame) {
    if (subscriber.closed || subscriber.bindings.get(binding.job.id) !== binding) return;
    binding.contentOffset = frame.contentOffset;
    binding.reasoningOffset = frame.reasoningOffset;
    binding.initial = false;
    if (frame.legacy) {
      const current = binding.legacyDelta || {};
      const sentContent = String(frame.legacySent?.content || '');
      const sentReasoning = String(frame.legacySent?.reasoning || '');
      binding.legacyDelta = {
        content: String(current.content || '').startsWith(sentContent) ? String(current.content || '').slice(sentContent.length) : '',
        reasoning: String(current.reasoning || '').startsWith(sentReasoning) ? String(current.reasoning || '').slice(sentReasoning.length) : '',
      };
    }
    if (frame.payload?.ft !== undefined) {
      binding.firstTokenSent = true;
      binding.job.firstTokenNotified = true;
    }
    const remaining = hasRemaining(binding);
    if (frame.terminal && !remaining) detachBinding(subscriber, binding);
    else if (remaining || isTerminal(binding.job)) subscriber.dirty.add(binding.job);
    finishIfEmpty(subscriber);
    if (!subscriber.pumping) pumpSubscriber(subscriber);
  }

  function nextItem(subscriber) {
    if (subscriber.initial.length) return subscriber.initial.shift();
    while (subscriber.dirty.size) {
      const job = subscriber.dirty.values().next().value;
      subscriber.dirty.delete(job);
      const binding = subscriber.bindings.get(job.id);
      if (binding?.job === job) return { id: job.id, binding };
    }
    return null;
  }

  function pumpSubscriber(subscriber) {
    if (subscriber.closed || subscriber.pumping || !subscriber.writer.isIdle()) return;
    clearScheduledPump(subscriber);
    subscriber.pumping = true;
    let frames = 0;
    try {
      while (!subscriber.closed && subscriber.writer.isIdle() && frames < PUMP_FRAME_LIMIT) {
        const item = nextItem(subscriber);
        if (!item) break;
        const binding = item.binding;
        if (binding && subscriber.bindings.get(item.id) !== binding) continue;
        if (binding && !jobOwnedBy(binding.job, subscriber.principal)) {
          detachBinding(subscriber, binding);
          continue;
        }
        const frame = binding ? frameForBinding(binding) : { payload: { e: JOB_NOT_FOUND_MESSAGE }, contentOffset: 0, reasoningOffset: 0, terminal: true };
        if (!frame.payload) {
          if (binding) acceptFrame(subscriber, binding, frame);
          continue;
        }
        const compact = !!binding && binding.job.compactStream === true;
        const payload = binding ? frame.payload : { e: JOB_NOT_FOUND_MESSAGE };
        const body = compact ? `data: ${JSON.stringify(payload)}\n\n` : `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
        frames += 1;
        subscriber.writer.enqueue(body, () => {
          if (binding) acceptFrame(subscriber, binding, frame);
          else if (!subscriber.pumping) pumpSubscriber(subscriber);
        });
      }
    } catch (error) {
      subscriber.close(error);
    } finally {
      subscriber.pumping = false;
    }
    finishIfEmpty(subscriber);
    if (!subscriber.closed && subscriber.writer.isIdle() && (subscriber.initial.length || subscriber.dirty.size)) {
      subscriber.immediate = setImmediateImpl(() => {
        subscriber.immediate = null;
        pumpSubscriber(subscriber);
      });
    }
  }

  function adoptLegacySubscriber(legacy, job, subscribers) {
    if (!legacy || legacy.bindings || legacy.job !== job) return null;
    const req = { authPrincipal: legacy.principal, on() {}, removeListener() {} };
    const adopted = createSubscriber(req, legacy.res);
    if (adopted === legacy) return adopted;
    subscribers.delete(legacy);
    subscribers.add(adopted);
    const text = jobText(job);
    const binding = {
      job,
      contentOffset: text.authoritative ? Math.max(0, text.content.length - String(job.streamDelta?.content || '').length) : 0,
      reasoningOffset: text.authoritative ? Math.max(0, text.reasoning.length - String(job.streamDelta?.reasoning || '').length) : 0,
      initial: false,
      legacyDelta: null,
      firstTokenSent: !!job.firstTokenNotified,
    };
    adopted.bindings.set(job.id, binding);
    activeSubscribers.delete(legacy);
    return adopted;
  }

  function notifyJob(job) {
    const subscribers = jobSubscribers.get(job.id);
    if (!subscribers) return;
    for (let subscriber of [...subscribers]) {
      if (!subscriber?.bindings) subscriber = adoptLegacySubscriber(subscriber, job, subscribers);
      const binding = subscriber?.bindings?.get(job.id);
      if (!binding || binding.job !== job) continue;
      if (!jobOwnedBy(job, subscriber.principal)) {
        detachBinding(subscriber, binding);
        finishIfEmpty(subscriber);
        continue;
      }
      const authoritative = jobText(job).authoritative;
      if (!authoritative && job.streamDelta) {
        const current = binding.legacyDelta || {};
        const next = job.streamDelta || {};
        binding.legacyDelta = {
          content: String(current.content || '') + String(next.content || ''),
          reasoning: String(current.reasoning || '') + String(next.reasoning || ''),
        };
      }
      subscriber.dirty.add(job);
      if (isTerminal(job) || !authoritative) pumpSubscriber(subscriber);
      else if (!subscriber.mergeTimer && !subscriber.writer.isBlocked()) {
        subscriber.mergeTimer = setTimeoutImpl(() => {
          subscriber.mergeTimer = null;
          pumpSubscriber(subscriber);
        }, LIVE_MERGE_MS);
        subscriber.mergeTimer?.unref?.();
      }
    }
    delete job.streamDelta;
  }

  function openSubscriber(req, res) {
    if (responseSubscribers.has(res)) return responseSubscribers.get(res);
    res.writeHead(200, { ...SECURITY_HEADERS, ...JOB_SSE_HEADERS });
    res.flushHeaders?.();
    return createSubscriber(req, res);
  }

  function subscribeJob(req, res, store) {
    const id = getJobIdFromUrl(req);
    const job = findOwnedJob(store, id, req.authPrincipal);
    safeLog('[subscribeJob]', { id, found: !!job, path: redactUrl(req.url) });
    const subscriber = openSubscriber(req, res);
    if (job) {
      const parsed = new URL(req.url, 'http://localhost');
      bindInitialJob(subscriber, job, {
        contentLength: Math.max(0, Number(parsed.searchParams.get('contentLength') || 0) || 0),
        reasoningLength: Math.max(0, Number(parsed.searchParams.get('reasoningLength') || 0) || 0),
      });
    } else subscriber.initial.push({ id });
    pumpSubscriber(subscriber);
  }

  function abortJob(store, id, principal, message = '任务已停止') {
    const job = findOwnedJob(store, id, principal);
    if (!job) return null;
    if (isTerminal(job)) return job;
    requestJobCancellation(job, { message, reason: 'user_stop', code: 'JOB_STOPPED' });
    job.status = 'error';
    job.error = message;
    job.updatedAt = Date.now();
    notifyJob(job);
    return job;
  }

  function disposeJob(store, id, principal, message = '会话已删除，任务已清理') {
    const job = findOwnedJob(store, id, principal);
    if (!job) return null;
    if (!isTerminal(job)) abortJob(store, id, principal, message);
    else {
      for (const subscriber of [...(jobSubscribers.get(id) || [])]) {
        const binding = subscriber.bindings?.get(id);
        if (binding?.job !== job) continue;
        detachBinding(subscriber, binding);
        finishIfEmpty(subscriber);
      }
    }
    if (store.get(id) === job) store.delete(id);
    return job;
  }

  return { notifyJob, subscribeJob, abortJob, disposeJob };
}

function closeJobSubscribers(jobSubscribers) {
  if (!jobSubscribers) return 0;
  const unique = new Set(activeSubscriberSets.get(jobSubscribers) || []);
  for (const subscribers of jobSubscribers.values()) {
    for (const subscriber of subscribers || []) unique.add(subscriber);
    subscribers?.clear();
  }
  jobSubscribers.clear();
  activeSubscriberSets.get(jobSubscribers)?.clear();
  for (const subscriber of unique) {
    try {
      if (typeof subscriber?.close === 'function') subscriber.close('shutdown');
      else subscriber?.res?.end?.();
    } catch {}
  }
  return unique.size;
}

module.exports = { getJobIdFromUrl, publicJob, compactResumeSnapshot, createJobEvents, closeJobSubscribers };
