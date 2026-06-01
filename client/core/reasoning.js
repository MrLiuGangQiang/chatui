function normalizeReasoningText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeReasoningText(item?.text || item?.content || item?.summary || item?.reasoning || item?.thinking || item?.reasoning_content || item?.thinking_content || item?.reasoning_details || item?.output_text || item?.delta || item))
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
      value.delta ||
      value.summary_text ||
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
    delta.delta ||
    message.reasoning_content ||
    message.reasoning ||
    message.thinking ||
    message.reasoning_details ||
    message.thinking_content ||
    message.delta ||
    event?.reasoning_content ||
    event?.reasoning ||
    event?.thinking ||
    event?.reasoning_details ||
    event?.thinking_content ||
    event?.reasoning_delta ||
    event?.thinking_delta ||
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
    ? normalizeReasoningText(event.output.filter(item => /reason/i.test(String(item?.type || item?.role || '')) || item?.summary || item?.summary_text || item?.reasoning || item?.thinking))
    : '';
  return { content, reasoning: reasoning || outputReasoning };
}

function extractResponsesStreamDelta(event) {
  const type = String(event?.type || '');
  const isReasoning = /reasoning/i.test(type);
  const isSummary = /summary/i.test(type);
  const content = normalizeContentText(
    (!isReasoning ? event?.delta : '') ||
    (!isReasoning ? event?.text : '') ||
    (!isReasoning ? event?.output_text_delta : '') ||
    (!isReasoning ? event?.response?.output_text?.delta : '') ||
    (type === 'response.output_text.done' ? event?.text : '') ||
    ''
  );
  const reasoningDelta = isReasoning && isSummary
    ? (event?.delta || event?.text || event?.content || event?.output_text || '')
    : '';
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
  return { content, reasoning };
}

function reasoningBudgetTokens(level = 'medium') {
  return { low: 1024, medium: 4096, high: 8192, xhigh: 16384 }[level] || 4096;
}

module.exports = { normalizeReasoningText, normalizeContentText, extractStreamDelta, extractResponsesStreamDelta, reasoningBudgetTokens };
