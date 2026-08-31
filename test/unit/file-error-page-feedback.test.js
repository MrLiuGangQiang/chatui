'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('../../client/core/http');

function appFunctionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `app.js must define ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.ok(end > start, `app.js must define ${nextName} after ${name}`);
  return source.slice(start, end);
}

function testInvalidUploadedFileErrorHasActionableChinesePageMessage() {
  const upstream = 'Request failed: Bad Request, error: The file you uploaded is badly formatted or corrupted. Please fix the file and try again., code: invalid_file, type: invalid_request_error';
  assert.strictEqual(
    http.normalizeUpstreamErrorMessage(upstream),
    '上传的文件格式不正确或文件已损坏，无法被接口读取。请确认文件可正常打开后重新导出或重新上传。',
  );
  assert.strictEqual(
    http.normalizeError(null, { error: { code: 'invalid_file' } }),
    '上传的文件格式不正确或文件已损坏，无法被接口读取。请确认文件可正常打开后重新导出或重新上传。',
  );
}

function testRunErrorsAlwaysReachTheVisiblePageToast() {
  const source = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const showRunError = appFunctionSource(source, 'showRunError', 'cleanupStalePendingDisplay');
  assert.ok(
    showRunError.includes('const a=t?.message||String(t);toast?.(a);'),
    'run failures must surface the final error text through the visible toast before updating chat history',
  );
  assert.ok(
    showRunError.includes('updateSessionDisplayItem(e,s,"error",a'),
    'run failures must remain persisted in the session display history',
  );
}

module.exports = [
  testInvalidUploadedFileErrorHasActionableChinesePageMessage,
  testRunErrorsAlwaysReachTheVisiblePageToast,
];
