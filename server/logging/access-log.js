'use strict';

const path = require('node:path');
const {
  envFlag,
  positiveInteger,
  now,
  traceId,
  redactString,
  resolveFilePath,
  createFileWriter,
} = require('./logger');

const ACCESS_SCHEMA_VERSION = 'access.v1';
const DEFAULT_ACCESS_RELATIVE_PATH = path.join('temp', 'logs', 'access.ndjson');
const DEFAULT_ACCESS_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_ACCESS_ROTATIONS = 3;

function accessLogEnabled(env = process.env) {
  return envFlag(env.CHATUI_ACCESS_LOG, true); // enabled by default
}

function getClientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return String(req.socket?.remoteAddress || '');
}

function resolveAccessFile(rootPath = process.cwd()) {
  return resolveFilePath(
    process.env.CHATUI_ACCESS_LOG_FILE || DEFAULT_ACCESS_RELATIVE_PATH,
    rootPath,
  );
}

function createAccessLogger({
  root = process.cwd(),
  enabled = accessLogEnabled(),
  maxBytes = positiveInteger(process.env.CHATUI_ACCESS_LOG_MAX_BYTES, DEFAULT_ACCESS_MAX_BYTES),
  rotations = positiveInteger(process.env.CHATUI_ACCESS_LOG_ROTATIONS, DEFAULT_ACCESS_ROTATIONS),
} = {}) {
  const resolvedFile = resolveAccessFile(root);
  const writer = createFileWriter(resolvedFile, { maxBytes, rotations, enabled });

  if (enabled) {
    console.log('[access-log] file=' + resolvedFile + ' enabled=true maxBytes=' + maxBytes + ' rotations=' + rotations);
  }

  function log(req, res, { statusCode = 0, durationMs = 0, route = '', traceId: tId = '', requestBytes = 0, responseBytes = 0 } = {}) {
    if (!enabled) return false;
    try {
      const timestampMs = now();
      const line = {
        schema_version: ACCESS_SCHEMA_VERSION,
        timestamp: new Date(timestampMs).toISOString(),
        trace_id: String(tId || traceId()),
        method: String(req.method || 'GET').toUpperCase(),
        path: String(req.pathname || req.url || '').split('?')[0],
        query: redactString(String(req.url || '').includes('?') ? String(req.url || '').split('?')[1] || '' : ''),
        status: Number(statusCode) || 0,
        duration_ms: Math.round(Math.max(0, Number(durationMs) || 0)),
        client_ip: getClientIp(req),
        user_agent: redactString(String(req.headers?.['user-agent'] || '').slice(0, 512)),
        content_type: String(req.headers?.['content-type'] || '').slice(0, 256),
        referer: redactString(String(req.headers?.referer || req.headers?.referrer || '').slice(0, 1024)),
        request_bytes: Number(requestBytes) || 0,
        response_bytes: Number(responseBytes) || 0,
        route: String(route || ''),
        timestamp_ms: timestampMs,
      };
      return writer.writeLine(line);
    } catch {
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
  ACCESS_SCHEMA_VERSION,
  DEFAULT_ACCESS_RELATIVE_PATH,
  accessLogEnabled,
  resolveAccessFile,
  createAccessLogger,
};
