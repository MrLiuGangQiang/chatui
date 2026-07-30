'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  incrementVersion,
  parseVersion,
  readVersion,
} = require('../../scripts/version-source');
const { prepareRelease } = require('../../scripts/prepare-release');

function fixtureRoot(version = '1.10.7') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-version-source-'));
  fs.mkdirSync(path.join(root, 'docs', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(root, 'version.json'), `${JSON.stringify({ version }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'fixture', version: '0.0.1', private: true }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'fixture', version: '0.0.1', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '0.0.1' } },
  }, null, 2)}\n`);
  return root;
}

function testVersionIncrementUsesPatchBeforeMinorCarry() {
  assert.strictEqual(incrementVersion('1.10.7'), '1.10.8');
  assert.strictEqual(incrementVersion('1.10.98'), '1.10.99');
  assert.strictEqual(incrementVersion('1.10.99'), '1.11.0');
}

function testVersionSourceRejectsInvalidStoredValues() {
  for (const value of ['', '1.2', '1.2.100', '1.-1.2', '01.2.3', '1.02.3']) {
    assert.throws(() => parseVersion(value), /version must match|patch component/);
  }
  const root = fixtureRoot('1.2.100');
  try { assert.throws(() => readVersion({ root }), /patch component/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testPrepareReleaseUpdatesCanonicalSourceMirrorsAndNotes() {
  const root = fixtureRoot('1.10.99');
  try {
    const result = prepareRelease({ root });
    assert.strictEqual(result.version, '1.11.0');
    assert.strictEqual(readVersion({ root }), '1.11.0');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.strictEqual(packageJson.version, '1.11.0');
    assert.strictEqual(packageLock.version, '1.11.0');
    assert.strictEqual(packageLock.packages[''].version, '1.11.0');
    const notesPath = path.join(root, 'docs', 'releases', 'v1.11.0.md');
    assert.ok(fs.existsSync(notesPath));
    assert.match(fs.readFileSync(notesPath, 'utf8'), /^# ChatUI v1\.11\.0/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testPrepareReleaseFailsBeforeWritingWhenTargetNotesExist() {
  const root = fixtureRoot('1.10.99');
  const notesPath = path.join(root, 'docs', 'releases', 'v1.11.0.md');
  fs.writeFileSync(notesPath, '# existing\n', 'utf8');
  try {
    assert.throws(() => prepareRelease({ root }), /release notes already exist/);
    assert.strictEqual(readVersion({ root }), '1.10.99');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.0.1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

module.exports = [
  testVersionIncrementUsesPatchBeforeMinorCarry,
  testVersionSourceRejectsInvalidStoredValues,
  testPrepareReleaseUpdatesCanonicalSourceMirrorsAndNotes,
  testPrepareReleaseFailsBeforeWritingWhenTargetNotesExist,
];
