'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const REMOVED_LEGACY_MODULES = Object.freeze([
  'shared/changes-log.js',
]);

function testRemovedLegacyModulesDoNotReturn() {
  for (const relativePath of REMOVED_LEGACY_MODULES) {
    assert.strictEqual(
      fs.existsSync(path.join(repositoryRoot, relativePath)),
      false,
      `obsolete module must remain removed: ${relativePath}`,
    );
  }
}

module.exports = [
  testRemovedLegacyModulesDoNotReturn,
];
