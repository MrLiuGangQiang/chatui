'use strict';

const assert = require('assert');
const packageJson = require('../../package.json');
const { checkProject } = require('../../scripts/check-project');
const { releaseVersion, verifyRelease } = require('../../scripts/verify-release');

function testProjectToolingChecksStaticAndPackageContracts() {
  const result = checkProject();
  assert.strictEqual(result.version, packageJson.version);
  assert.strictEqual(result.staticFiles, 5);
}

function testReleaseVerificationRequiresMatchingSemverTag() {
  const tag = `v${packageJson.version}`;
  assert.strictEqual(releaseVersion(tag), packageJson.version);
  assert.strictEqual(verifyRelease(tag).tag, tag);
  assert.throws(() => releaseVersion(packageJson.version), /vMAJOR\.MINOR\.PATCH/);
}

module.exports = [
  testProjectToolingChecksStaticAndPackageContracts,
  testReleaseVerificationRequiresMatchingSemverTag,
];
