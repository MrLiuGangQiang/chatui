const { normalizeContentText, normalizeReasoningText } = require('../jobs/reasoning');
const { performance } = require('perf_hooks');

function elapsedSince(startedAt, now) {
  return Math.max(1, now() - Number(startedAt || now()));
}

function parseSseEvent(eventText) {
  const lines = String(eventText || '').split(/\r?\n/);
  let event = '';
  let data = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += `${data ? '\n' : ''}${line.slice(5).trim()}`;
  }
  return data ? { event, data } : null;
}

function extractResponsesStreamDelta(event) {
  if (event && typeof event === 'object' && ('d' in event || 'r' in event)) {
    return {
      content: normalizeContentText(event.d || ''),
      reasoning: normalizeReasoningText(event.r || ''),
      done: !!event.done,
    };
  }
  const type = String(event?.type || '');
  const done = type === 'response.completed';
  if (/\.done$/i.test(type) || done) return { content: '', reasoning: '', done };
  const isReasoning = /reasoning/i.test(type);
  const isSummary = /summary/i.test(type);
  const content = normalizeContentText(
    (!isReasoning ? event?.delta : '') ||
    (!isReasoning ? event?.text : '') ||
    (!isReasoning ? event?.output_text_delta : '') ||
    (!isReasoning ? event?.response?.output_text?.delta : '') ||
    ''
  );
  const reasoningDelta = isReasoning && isSummary ? (event?.delta || event?.text || event?.content || event?.output_text || '') : '';
  const reasoning = normalizeReasoningText(
    event?.summary_text_delta ||
    event?.reasoning_summary_text_delta ||
    event?.delta_text ||
    event?.summary_text ||
    event?.reasoning_summary_text ||
    event?.summary ||
    event?.reasoning_summary ||
    reasoningDelta ||
    ''
  );
  return { content, reasoning, done: false };
}

function sseUpdate(payload) {
  return `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
}

function createResponsesCompactStreamNormalizer({ now = () => performance.now(), startedAt = now() } = {}) {
  let buffer = '';
  let done = false;
  let firstTokenNotified = false;
  const pushPayload = payload => {
    if (!payload || !Object.keys(payload).length) return '';
    return sseUpdate(payload);
  };

  const markDone = () => {
    if (done) return '';
    done = true;
    return pushPayload({ done: 1, rt: elapsedSince(startedAt, now) });
  };

  function push(text, { flush = false } = {}) {
    if (done) return '';
    buffer += String(text || '');
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    if (flush && buffer.trim()) {
      events.push(buffer);
      buffer = '';
    }
    let out = '';
    for (const eventText of events) {
      const parsed = parseSseEvent(eventText);
      if (!parsed) continue;
      if (parsed.data === '[DONE]') {
        out += markDone();
        continue;
      }
      let event;
      try { event = JSON.parse(parsed.data); } catch { continue; }
      if (parsed.event && !event.type) event.type = parsed.event;
      const delta = extractResponsesStreamDelta(event);
      const payload = {};
      if (delta.content) payload.d = delta.content;
      if (delta.reasoning) payload.r = delta.reasoning;
      if ((payload.d || payload.r) && !firstTokenNotified) {
        payload.ft = elapsedSince(startedAt, now);
        firstTokenNotified = true;
      }
      out += pushPayload(payload);
      if (delta.done) out += markDone();
    }
    return out;
  }

  function end() {
    const tail = push('', { flush: true });
    return tail + markDone();
  }

  return { push, end };
}

module.exports = {
  parseSseEvent,
  extractResponsesStreamDelta,
  createResponsesCompactStreamNormalizer,
};
