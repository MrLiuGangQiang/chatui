'use strict';

const { createRequestTraceLogger } = require('./request-trace');
const { createAccessLogger } = require('./access-log');
const { createServerLogger, createErrorLogger } = require('./server-log');
const { createTraceContext, traceId, now } = require('./logger');

/**
 * Create all loggers for the application.
 * File writes are queued and batched; flush/close are the durability boundary
 * used by graceful shutdown and deterministic tests.
 */
function createLoggers({ root = process.cwd() } = {}) {
  const reportLastResort = (label, error, details = {}) => {
    console.error(`[${label}] asynchronous log write failed`, {
      name: String(error?.name || 'Error'),
      code: String(error?.code || ''),
      phase: String(details?.phase || ''),
    });
  };

  const errorLog = createErrorLogger({
    root,
    onError: (error, details) => reportLastResort('error-log', error, details),
  });

  const reportWriterError = source => (error, details = {}) => {
    const accepted = errorLog.log(error, { source, phase: details.phase || '' });
    if (!accepted) reportLastResort(source, error, details);
  };

  const serverLog = createServerLogger({ root, onError: reportWriterError('server-log') });
  const accessLog = createAccessLogger({ root, onError: reportWriterError('access-log') });
  const requestTrace = createRequestTraceLogger({ root, onError: reportWriterError('request-trace') });
  const primaryLoggers = [serverLog, accessLog, requestTrace];

  async function flush() {
    await Promise.all(primaryLoggers.map(logger => logger.flush?.()));
    await errorLog.flush?.();
  }

  async function close() {
    await Promise.all(primaryLoggers.map(logger => logger.close?.()));
    await errorLog.close?.();
  }

  function stats() {
    return Object.freeze({
      server: serverLog.stats?.() || null,
      error: errorLog.stats?.() || null,
      access: accessLog.stats?.() || null,
      request_trace: requestTrace.stats?.() || null,
    });
  }

  return Object.freeze({
    serverLog,
    errorLog,
    accessLog,
    requestTrace,
    flush,
    close,
    stats,
    // Helper to create a new trace context (for call-chain correlation)
    newTrace: parentSpan => createTraceContext(parentSpan),
  });
}

module.exports = {
  createLoggers,
  createTraceContext,
  traceId,
  now,
};