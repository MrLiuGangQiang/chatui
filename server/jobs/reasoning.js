function normalizeReasoningText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => normalizeReasoningText(item?.text || item?.content || item?.summary || item?.reasoning || item?.thinking || item)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    return normalizeReasoningText(value.text || value.content || value.summary || value.reasoning || value.thinking || value.reasoning_content || value.thinking_content || value.reasoning_details || value.output_text || '');
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

module.exports = { normalizeReasoningText, normalizeContentText };
