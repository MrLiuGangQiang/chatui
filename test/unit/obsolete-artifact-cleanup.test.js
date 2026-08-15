'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const REMOVED_OBSOLETE_ARTIFACTS = Object.freeze([
  'client/core/messages.js',
  'client/domain/types.js',
  'docs/manual-chat-image-acceptance-test.md',
  'docs/manual-chat-image-core-acceptance-test.md',
  'docs/route-logic-explained.md',
  'server/errors/app-error.js',
  'shared/changes-log.js',
]);

function testRemovedObsoleteArtifactsDoNotReturn() {
  for (const relativePath of REMOVED_OBSOLETE_ARTIFACTS) {
    assert.strictEqual(
      fs.existsSync(path.join(repositoryRoot, relativePath)),
      false,
      `obsolete artifact must remain removed: ${relativePath}`,
    );
  }
}

function testCanonicalEntrypointsDoNotReexportRetiredCode() {
  const coreIndex = fs.readFileSync(path.join(repositoryRoot, 'client/core/index.js'), 'utf8');
  assert.doesNotMatch(coreIndex, /require\(['"]\.\/messages['"]\)/, 'the core facade must not reload the retired duplicate message helpers');

  const jobHandlers = require('../../server/jobs/chat-image');
  assert.deepStrictEqual(Object.keys(jobHandlers).sort(), ['createJobHandlers'], 'the job composition module must expose only its supported entrypoint');

  const httpErrors = require('../../server/errors/http-error');
  assert.deepStrictEqual(
    Object.keys(httpErrors).sort(),
    ['AppError', 'errorPayload', 'normalizeError', 'toErrorPayload'].sort(),
    'the canonical HTTP error module must own the complete error API',
  );
}

module.exports = [
  testRemovedObsoleteArtifactsDoNotReturn,
  testCanonicalEntrypointsDoNotReexportRetiredCode,
];
