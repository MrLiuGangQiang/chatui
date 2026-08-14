const { normalizeContentText, normalizeReasoningText } = require('./reasoning');
const { webSourcesMarkdown } = require('../proxy/responses-stream');

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

function updateChatJobFromStreamChunk(job, text, { notify = true, notifyChatStreamJob = () => {}, elapsedSince = () => 1, extractDelta = extractStreamDelta } = {}) {
  job.buffer = (job.buffer || '') + text;
  const events = job.buffer.split(/\r?\n\r?\n/);
  job.buffer = events.pop() || '';
  const message = job.data.choices[0].message;
  let chunkContent = '';
  let chunkReasoning = '';
  let streamDone = false;
  for (const eventText of events) {
    const dataText = dataTextFromSseEvent(eventText);
    if (!dataText || dataText === '[DONE]') continue;
    try {
      const { content, reasoning, sources = [], done = false } = extractDelta(JSON.parse(dataText));
      if (!Array.isArray(job.webSearchSources)) job.webSearchSources = [];
      const knownSourceUrls = new Set(job.webSearchSources.map(source => source.url));
      for (const source of sources) {
        const url = String(source?.url || '').trim();
        if (!url || knownSourceUrls.has(url)) continue;
        knownSourceUrls.add(url);
        job.webSearchSources.push({ url, title: String(source?.title || url) });
      }
      streamDone ||= done === true;
      if (content || reasoning) markFirstToken(job, elapsedSince);
      if (content) { message.content += content; chunkContent += content; }
      if (reasoning) { message.reasoning_content += reasoning; chunkReasoning += reasoning; }
      job.updatedAt = Date.now();
      if (notify && (content || reasoning)) notifyChatStreamJob(job);
    } catch {}
  }
  if (streamDone && !job.webSearchSourcesEmitted) {
    const markdown = webSourcesMarkdown(job.webSearchSources);
    if (markdown) { message.content += markdown; chunkContent += markdown; }
    job.webSearchSourcesEmitted = true;
  }
  if (chunkContent || chunkReasoning) {
    job.streamSeq = (job.streamSeq || 0) + 1;
    job.streamDelta = { content: chunkContent, reasoning: chunkReasoning };
    return true;
  }
  return false;
}

module.exports = { dataTextFromSseEvent, extractStreamDelta, markFirstToken, updateChatJobFromStreamChunk };
