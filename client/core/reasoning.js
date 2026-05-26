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

function normalizeContentText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeContentText(item?.text || item?.content || item?.output_text || item?.message || item?.delta || item))
      .filter(Boolean)
      .join('');
  }
  if (typeof value === 'object') {
    const output = Array.isArray(value.output)
      ? value.output.filter(item => !/reason/i.test(String(item?.type || item?.role || '')))
      : '';
    return normalizeContentText(
      value.text ||
      value.content ||
      value.output_text ||
      value.message ||
      value.delta ||
      value.response ||
      output ||
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
  let content = normalizeContentText(
    delta.content ||
    delta.text ||
    delta.output_text ||
    message.content ||
    message.text ||
    message.output_text ||
    event?.output_text ||
    (typeof event?.delta === 'string' ? event.delta : '') ||
    event?.content ||
    event?.text ||
    ''
  );
  if (!content && Array.isArray(event?.output)) {
    content = event.output
      .filter(item => !/reason/i.test(String(item?.type || item?.role || '')))
      .map(item => normalizeContentText(item?.content || item?.text || item?.output_text || ''))
      .join('');
  }
  const outputReasoning = !reasoning && Array.isArray(event?.output)
    ? normalizeReasoningText(event.output.filter(item => /reason/i.test(String(item?.type || item?.role || '')) || item?.summary || item?.reasoning || item?.thinking))
    : '';
  return { content, reasoning: reasoning || outputReasoning };
}

function reasoningBudgetTokens(level = 'medium') {
  return { low: 1024, medium: 4096, high: 8192, xhigh: 16384 }[level] || 4096;
}

module.exports = { normalizeReasoningText, normalizeContentText, extractStreamDelta, reasoningBudgetTokens };
