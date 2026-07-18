'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const packageJson = require('../../package.json');
const { checkProject } = require('../../scripts/check-project');
const { checkArchitecture, readBaseline } = require('../../scripts/check-architecture');
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


function testArchitectureCheckFreezesLegacyGrowth() {
  const current = checkArchitecture();
  assert.ok(current.appJsBytes <= current.appJsMaxBytes);
  const baseline = readBaseline();
  assert.ok(current.withScopes <= Object.values(baseline.legacyWithScopes).reduce((sum, count) => sum + count, 0));
  assert.ok(current.globalNamespaceExports <= baseline.maxGlobalNamespaceExports);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-architecture-check-'));
  try {
    fs.mkdirSync(path.join(root, 'client'), { recursive: true });
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app.js'), 'ok', 'utf8');
    const fixtureBaseline = { appJsMaxBytes: 2, maxGlobalNamespaceExports: 0, legacyWithScopes: {} };
    assert.doesNotThrow(() => checkArchitecture({ root, baseline: fixtureBaseline }));

    fs.writeFileSync(path.join(root, 'client', 'new-workflow.js'), 'with (deps) {}', 'utf8');
    assert.throws(() => checkArchitecture({ root, baseline: fixtureBaseline }), /New or expanded with-scopes are forbidden/);

    fs.writeFileSync(path.join(root, 'client', 'new-workflow.js'), 'window.ChatUINewFeature = {};', 'utf8');
    assert.throws(() => checkArchitecture({ root, baseline: fixtureBaseline }), /browser global namespace exports grew/);

    fs.writeFileSync(path.join(root, 'client', 'new-workflow.js'), '', 'utf8');
    fs.writeFileSync(path.join(root, 'app.js'), 'too large', 'utf8');
    assert.throws(() => checkArchitecture({ root, baseline: fixtureBaseline }), /root app\.js grew/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = [
  testProjectToolingChecksStaticAndPackageContracts,
  testArchitectureCheckFreezesLegacyGrowth,
  testReleaseVerificationRequiresMatchingSemverTag,
];
