function normalizeReasoningText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeReasoningText(item?.text || item?.content || item?.summary || item?.reasoning || item?.thinking || item))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    return normalizeReasoningText(
      value.text ||
      value.content ||
      value.summary ||
      value.reasoning ||
      value.thinking ||
      value.reasoning_content ||
      value.thinking_content ||
      value.reasoning_details ||
      value.output_text ||
      ''
    );
  }
  return String(value || '');
}

function extractStreamDelta(event) {
  const choice = event?.choices?.[0];
  const delta = choice?.delta || {};
  const message = choice?.message || {};
  const reasoning = normalizeReasoningText(
    delta.reasoning_content ||
    delta.reasoning ||
    delta.thinking ||
    delta.reasoning_details ||
    delta.thinking_content ||
    message.reasoning_content ||
    message.reasoning ||
    message.thinking ||
    message.reasoning_details ||
    message.thinking_content ||
    event?.reasoning_content ||
    event?.reasoning ||
    event?.thinking ||
    event?.reasoning_details ||
    event?.thinking_content ||
    ''
  );
  let content = delta.content || message.content || (typeof event?.delta === 'string' ? event.delta : '') || (typeof event?.content === 'string' ? event.content : '') || '';
  if (!content && Array.isArray(event?.output)) {
    content = event.output.map(item => item?.content?.map(part => part?.text || '').join('') || '').join('');
  }
  const outputReasoning = !reasoning && Array.isArray(event?.output)
    ? normalizeReasoningText(event.output.filter(item => /reason/i.test(String(item?.type || item?.role || '')) || item?.summary || item?.reasoning || item?.thinking))
    : '';
  return { content, reasoning: reasoning || outputReasoning };
}

function reasoningBudgetTokens(level = 'medium') {
  return { low: 1024, medium: 4096, high: 8192, xhigh: 16384 }[level] || 4096;
}

module.exports = { normalizeReasoningText, extractStreamDelta, reasoningBudgetTokens };
