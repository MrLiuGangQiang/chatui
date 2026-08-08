'use strict';

const { createRequestTraceLogger } = require('./request-trace');
const { createAccessLogger } = require('./access-log');
const { createServerLogger, createErrorLogger } = require('./server-log');
const { createTraceContext, traceId, now } = require('./logger');

/**
 * Create all loggers for the application.
 * Returns a unified logging object.
 */
function createLoggers({ root = process.cwd() } = {}) {
  const serverLog = createServerLogger({ root });
  const errorLog = createErrorLogger({ root });
  const accessLog = createAccessLogger({ root });
  const requestTrace = createRequestTraceLogger({ root });

  return Object.freeze({
    serverLog,
    errorLog,
    accessLog,
    requestTrace,
    // Helper to create a new trace context (for call-chain correlation)
    newTrace: (parentSpan) => createTraceContext(parentSpan),
  });
}

module.exports = {
  createLoggers,
  createTraceContext,
  traceId,
  now,
};
