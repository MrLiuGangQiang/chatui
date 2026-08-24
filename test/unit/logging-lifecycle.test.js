'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLoggers } = require('../../server/logging');

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function testLoggingFacadeFlushesAllAcceptedRecordsBeforeCloseResolves() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-logging-lifecycle-'));
  const keys = [
    'CHATUI_ACCESS_LOG', 'CHATUI_ACCESS_LOG_FILE',
    'CHATUI_SERVER_LOG', 'CHATUI_SERVER_LOG_FILE',
    'CHATUI_ERROR_LOG', 'CHATUI_ERROR_LOG_FILE',
    'CHATUI_REQUEST_TRACE', 'CHATUI_REQUEST_TRACE_FILE',
  ];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    CHATUI_ACCESS_LOG: '1', CHATUI_ACCESS_LOG_FILE: 'logs/access.ndjson',
    CHATUI_SERVER_LOG: '1', CHATUI_SERVER_LOG_FILE: 'logs/server.ndjson',
    CHATUI_ERROR_LOG: '1', CHATUI_ERROR_LOG_FILE: 'logs/error.ndjson',
    CHATUI_REQUEST_TRACE: '1', CHATUI_REQUEST_TRACE_FILE: 'logs/trace.ndjson',
  });
  try {
    const loggers = createLoggers({ root });
    assert.strictEqual(loggers.serverLog.event('test.server', { value: 1 }), true);
    assert.strictEqual(loggers.errorLog.log(new Error('test error'), { source: 'test' }), true);
    assert.strictEqual(loggers.accessLog.log({ method: 'GET', url: '/health', headers: {}, socket: {} }, {}, {
      statusCode: 200, route: 'test', traceId: 'trace-access-test',
    }), true);
    assert.strictEqual(loggers.requestTrace.record({ event: 'test.trace', trace_id: 'trace-test' }), true);

    await loggers.close();

    assert.strictEqual(readLines(path.join(root, 'logs', 'server.ndjson'))[0].event, 'test.server');
    assert.strictEqual(readLines(path.join(root, 'logs', 'error.ndjson'))[0].context, 'test');
    assert.strictEqual(readLines(path.join(root, 'logs', 'access.ndjson'))[0].path, '/health');
    assert.strictEqual(readLines(path.join(root, 'logs', 'trace.ndjson'))[0].event, 'test.trace');
    assert.strictEqual(loggers.accessLog.log({ method: 'GET', url: '/late', headers: {}, socket: {} }, {}, {}), false);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = [testLoggingFacadeFlushesAllAcceptedRecordsBeforeCloseResolves];