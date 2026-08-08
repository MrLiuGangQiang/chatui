'use strict';

const path = require('node:path');
const {
  envFlag,
  positiveInteger,
  now,
  resolveFilePath,
  createFileWriter,
  serialiseError,
} = require('./logger');

const SERVER_SCHEMA_VERSION = 'server.v1';
const DEFAULT_SERVER_RELATIVE_PATH = path.join('temp', 'logs', 'server.ndjson');
const DEFAULT_SERVER_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_SERVER_ROTATIONS = 3;

const ERROR_SCHEMA_VERSION = 'error.v1';
const DEFAULT_ERROR_RELATIVE_PATH = path.join('temp', 'logs', 'error.ndjson');
const DEFAULT_ERROR_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_ERROR_ROTATIONS = 5;

function serverLogEnabled(env = process.env) {
  return envFlag(env.CHATUI_SERVER_LOG, true);
}

function errorLogEnabled(env = process.env) {
  return envFlag(env.CHATUI_ERROR_LOG, true);
}

function resolveServerFile(rootPath = process.cwd()) {
  return resolveFilePath(
    process.env.CHATUI_SERVER_LOG_FILE || DEFAULT_SERVER_RELATIVE_PATH,
    rootPath,
  );
}

function resolveErrorFile(rootPath = process.cwd()) {
  return resolveFilePath(
    process.env.CHATUI_ERROR_LOG_FILE || DEFAULT_ERROR_RELATIVE_PATH,
    rootPath,
  );
}

function createServerLogger({
  root = process.cwd(),
  enabled = serverLogEnabled(),
  maxBytes = positiveInteger(process.env.CHATUI_SERVER_LOG_MAX_BYTES, DEFAULT_SERVER_MAX_BYTES),
  rotations = positiveInteger(process.env.CHATUI_SERVER_LOG_ROTATIONS, DEFAULT_SERVER_ROTATIONS),
} = {}) {
  const resolvedFile = resolveServerFile(root);
  const writer = createFileWriter(resolvedFile, { maxBytes, rotations, enabled });

  if (enabled) {
    console.log('[server-log] file=' + resolvedFile + ' enabled=true');
  }

  function event(type, data = {}) {
    if (!enabled) return false;
    try {
      const timestampMs = now();
      return writer.writeLine({
        schema_version: SERVER_SCHEMA_VERSION,
        timestamp: new Date(timestampMs).toISOString(),
        event: type,
        pid: process.pid,
        ...data,
        timestamp_ms: timestampMs,
      });
    } catch {
      return false;
    }
  }

  return Object.freeze({
    enabled: !!enabled,
    filePath: resolvedFile,
    started: (opts = {}) => event('server.started', opts),
    stopped: (opts = {}) => event('server.stopped', opts),
    config: (opts = {}) => event('server.config', opts),
    event,
  });
}

function createErrorLogger({
  root = process.cwd(),
  enabled = errorLogEnabled(),
  maxBytes = positiveInteger(process.env.CHATUI_ERROR_LOG_MAX_BYTES, DEFAULT_ERROR_MAX_BYTES),
  rotations = positiveInteger(process.env.CHATUI_ERROR_LOG_ROTATIONS, DEFAULT_ERROR_ROTATIONS),
} = {}) {
  const resolvedFile = resolveErrorFile(root);
  const writer = createFileWriter(resolvedFile, { maxBytes, rotations, enabled });

  if (enabled) {
    console.log('[error-log] file=' + resolvedFile + ' enabled=true');
  }

  function log(err, context = {}) {
    if (!enabled) return false;
    try {
      const timestampMs = now();
      return writer.writeLine({
        schema_version: ERROR_SCHEMA_VERSION,
        timestamp: new Date(timestampMs).toISOString(),
        error: serialiseError(err),
        context: String(context.source || context.route || '').slice(0, 256),
        trace_id: String(context.traceId || ''),
        timestamp_ms: timestampMs,
      });
    } catch {
      // Last-resort: write to stderr
      if (process.env.CHATUI_VERBOSE_LOGS === '1') {
        console.error('[error-log] write failure:', err?.message);
      }
      return false;
    }
  }

  return Object.freeze({
    enabled: !!enabled,
    filePath: resolvedFile,
    log,
  });
}

module.exports = {
  SERVER_SCHEMA_VERSION,
  ERROR_SCHEMA_VERSION,
  DEFAULT_SERVER_RELATIVE_PATH,
  DEFAULT_ERROR_RELATIVE_PATH,
  serverLogEnabled,
  errorLogEnabled,
  resolveServerFile,
  resolveErrorFile,
  createServerLogger,
  createErrorLogger,
};
