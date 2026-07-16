'use strict';

const assert = require('assert');
const packageJson = require('../../package.json');
const { checkProject } = require('../../scripts/check-project');
const { releaseVersion, verifyRelease } = require('../../scripts/verify-release');
const { main: runReleasePreflight } = require('../../scripts/release-preflight');

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

function testReleasePreflightUsesTheStandardCheckCommand() {
  const commands = [];
  const tag = `v${packageJson.version}`;
  runReleasePreflight([tag], {
    runCommand(command, args) { commands.push({ command, args }); },
    logger: { log() {} },
  });
  assert.deepStrictEqual(commands, [
    { command: process.execPath, args: ['scripts/check-runtime.js', '--strict'] },
    { command: process.execPath, args: ['scripts/verify-release.js', tag] },
    { command: 'npm', args: ['run', 'check'] },
  ]);
  assert.throws(() => runReleasePreflight([], { runCommand() { throw new Error('should not run'); } }), /expected a release tag/);
}

module.exports = [
  testProjectToolingChecksStaticAndPackageContracts,
  testReleaseVerificationRequiresMatchingSemverTag,
  testReleasePreflightUsesTheStandardCheckCommand,
];
