const MAX_TIMER_MS = 2_147_483_647;

function integerInRange(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === 'string' && !value.trim() ? NaN : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    const fallbackNumber = Number(fallback);
    if (!Number.isFinite(fallbackNumber) || !Number.isInteger(fallbackNumber) || fallbackNumber < min || fallbackNumber > max) {
      throw new TypeError('A valid numeric fallback is required');
    }
    return fallbackNumber;
  }
  return parsed;
}

function positiveInteger(value, fallback, options = {}) {
  return integerInRange(value, fallback, { ...options, min: Math.max(1, Number(options.min) || 1) });
}

function nonNegativeInteger(value, fallback, options = {}) {
  return integerInRange(value, fallback, { ...options, min: Math.max(0, Number(options.min) || 0) });
}

function portNumber(value, fallback = 8765) {
  return integerInRange(value, fallback, { min: 1, max: 65535 });
}

function timeoutMilliseconds(value, fallback) {
  return positiveInteger(value, fallback, { max: MAX_TIMER_MS });
}

module.exports = {
  MAX_TIMER_MS,
  integerInRange,
  nonNegativeInteger,
  portNumber,
  positiveInteger,
  timeoutMilliseconds,
};
