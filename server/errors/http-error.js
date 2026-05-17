class HttpError extends Error {
  constructor(status, message, code = 'HTTP_ERROR', detail = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.detail = detail;
  }
}

function errorPayload(message, code = 'ERROR', detail = null) {
  const error = { code, message };
  if (detail !== undefined && detail !== null) error.detail = detail;
  return { error };
}

module.exports = { HttpError, errorPayload };
