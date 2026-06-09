function errorPayload(message, code = 'ERROR', detail = null) {
  const error = { code, message };
  if (detail !== undefined && detail !== null) error.detail = detail;
  return { error };
}

module.exports = { errorPayload };
