(function initChatUICoreJobEventAggregate(root) {
  'use strict';

  function lengthOf(value) {
    return String(value ?? '').length;
  }

  function messageFromAggregate(aggregate) {
    return aggregate?.data?.choices?.[0]?.message || {};
  }

  function isTerminalStatus(status) {
    return status === 'done' || status === 'error';
  }

  function eventOwn(event, key) {
    return Object.prototype.hasOwnProperty.call(event, key);
  }

  function initialAggregate(resumeOffsets = {}) {
    const content = String(resumeOffsets.baseContent ?? '');
    const reasoning = String(resumeOffsets.baseReasoning ?? '');
    if (!content && !reasoning) return null;
    return {
      status: 'running',
      data: { choices: [{ message: { content, reasoning_content: reasoning } }] },
      metrics: {},
    };
  }

  function statusForEvent(current, event, hasData, hasDelta) {
  if (event.e !== undefined && event.e !== null && event.e !== '') return 'error';
  if (event.done) return 'done';
  if (event.status === 'done' || event.status === 'error') return event.status;
  if (typeof event.status === 'string' && event.status) return event.status;
  if (hasDelta || hasData) return 'running';
  return current?.status || 'running';
}

function applyEvent(record, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { valid: false };
  const current = record.aggregate && typeof record.aggregate === 'object' ? record.aggregate : {
    status: 'running',
    data: { choices: [{ message: { content: '', reasoning_content: '' } }] },
    metrics: {},
  };
  const hasData = eventOwn(incoming, 'data') && incoming.data && typeof incoming.data === 'object';
  const hasDelta = eventOwn(incoming, 'd') || eventOwn(incoming, 'r');
  const currentMessage = messageFromAggregate(current);
  const status = statusForEvent(current, incoming, hasData, hasDelta);
  if (isTerminalStatus(current.status) && !isTerminalStatus(status)) return { valid: true, changed: false, aggregate: current };
  let message = { ...currentMessage };
  if (hasData) {
    message = messageFromAggregate(incoming);
  } else if (incoming.z) {
    message.content = String(incoming.d ?? '');
    message.reasoning_content = String(incoming.r ?? '');
  } else {
    if (eventOwn(incoming, 'd')) message.content = String(message.content ?? '') + String(incoming.d ?? '');
    if (eventOwn(incoming, 'r')) message.reasoning_content = String(message.reasoning_content ?? '') + String(incoming.r ?? '');
  }
  const next = {
    ...current,
    status,
    data: {
      ...(hasData ? incoming.data : current.data && typeof current.data === 'object' ? current.data : {}),
      choices: [{ message }],
    },
    metrics: {
      ...(current.metrics && typeof current.metrics === 'object' ? current.metrics : {}),
      ...(incoming.metrics && typeof incoming.metrics === 'object' ? incoming.metrics : {}),
      ...(Number.isFinite(incoming.ft) ? { firstTokenMs: incoming.ft } : {}),
      ...(Number.isFinite(incoming.rt) ? { durationMs: incoming.rt } : {}),
    },
  };
  if (status === 'error') {
    next.error = typeof incoming.error === 'object' && incoming.error
      ? incoming.error
      : { message: String(incoming.e || (typeof incoming.error === 'string' ? incoming.error : incoming.error?.message) || current.error?.message || 'Managed job failed') };
  } else if (!eventOwn(incoming, 'error')) {
    next.error = current.error;
  }
  record.aggregate = next;
  return { valid: true, changed: true, aggregate: next };
}
const api = Object.freeze({
    applyEvent,
    initialAggregate,
    isTerminalStatus,
    lengthOf,
    messageFromAggregate,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  registry?.register?.('jobEventAggregate', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
