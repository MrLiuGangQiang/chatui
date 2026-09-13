'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createErrorLogger } = require('../../server/logging/server-log');

async function testErrorLoggerPersistsValidationStageWithoutDuplicatingErrorFields() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatui-error-stage-'));
  const file = path.join(dir, 'error.ndjson');
  const logger = createErrorLogger({ root: dir, enabled: true });
  // The logger resolves its default path under root; use the returned path so
  // the assertion remains independent of process-level log configuration.
  const error = new Error('bad request');
  error.code = 'IMAGE_ROLE_MAP_MISMATCH';
  error.statusCode = 400;
  logger.log(error, { source: 'image_job_rejected', stage: 'execution_protocol', statusCode: 400, code: 'duplicate-context' });
  await logger.flush();
  const actualFile = logger.filePath || file;
  const record = JSON.parse(await fs.readFile(actualFile, 'utf8'));
  assert.strictEqual(record.context, 'image_job_rejected');
  assert.strictEqual(record.stage, 'execution_protocol');
  assert.strictEqual(record.error.code, 'IMAGE_ROLE_MAP_MISMATCH');
  assert.strictEqual(record.error.statusCode, 400);
  assert.ok(!Object.prototype.hasOwnProperty.call(record, 'statusCode'));
  await logger.close();
  await fs.rm(dir, { recursive: true, force: true });
}

module.exports = [testErrorLoggerPersistsValidationStageWithoutDuplicatingErrorFields];
