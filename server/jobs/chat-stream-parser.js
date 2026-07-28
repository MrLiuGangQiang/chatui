const { normalizeContentText, normalizeReasoningText } = require('./reasoning');

function markFirstToken(job, elapsedSince = () => 1) {
  if (job.firstTokenMs === null || job.firstTokenMs === undefined) {
    job.firstTokenMs = elapsedSince(job.serverStartAtMs);
  }
}

function dataTextFromSseEvent(eventText = '') {
  return String(eventText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n')
    .trim();
}

function extractStreamDelta(data = {}) {
  const delta = data?.choices?.[0]?.delta || data?.choices?.[0]?.message || {};
  return {
    content: normalizeContentText(delta.content || delta.text || delta.output_text || data?.output_text || data?.content || data?.text || data?.message || data?.response || data?.output || ''),
    reasoning: normalizeReasoningText(delta.reasoning_content || delta.reasoning || data?.reasoning_content || data?.reasoning || data?.reasoning_delta || ''),
  };
}

function streamErrorMessage(data = {}) {
  const type = String(data?.type || '').toLowerCase();
  const error = data?.error || data?.response?.error;
  if (!error && !/(?:^|\.)(?:failed|error)$/.test(type)) return '';
  return String(error?.message || error?.code || error || data?.message || '上游流式响应失败').slice(0, 1000);
}

function updateChatJobFromStreamChunk(job, text, { notify = true, notifyChatStreamJob = () => {}, elapsedSince = () => 1, extractDelta = extractStreamDelta } = {}) {
  job.buffer = (job.buffer || '') + text;
  const events = job.buffer.split(/\r?\n\r?\n/);
  job.buffer = events.pop() || '';
  const message = job.data.choices[0].message;
  let chunkContent = '';
  let chunkReasoning = '';
  for (const eventText of events) {
    const dataText = dataTextFromSseEvent(eventText);
    if (!dataText || dataText === '[DONE]') continue;
    try {
      const parsed = JSON.parse(dataText);
      const streamError = streamErrorMessage(parsed);
      if (streamError) {
        job.streamError = streamError;
        continue;
      }
      const { content, reasoning } = extractDelta(parsed);
      if (content || reasoning) markFirstToken(job, elapsedSince);
      if (content) { message.content += content; chunkContent += content; }
      if (reasoning) { message.reasoning_content += reasoning; chunkReasoning += reasoning; }
      job.updatedAt = Date.now();
      if (notify && (content || reasoning)) notifyChatStreamJob(job);
    } catch {}
  }
  if (chunkContent || chunkReasoning) {
    job.streamSeq = (job.streamSeq || 0) + 1;
    job.streamDelta = { content: chunkContent, reasoning: chunkReasoning };
    return true;
  }
  return false;
}

module.exports = { dataTextFromSseEvent, extractStreamDelta, streamErrorMessage, markFirstToken, updateChatJobFromStreamChunk };
