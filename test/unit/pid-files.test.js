'use strict';

// Regression: the default port used to write both chatui-8765.pid and
// chatui-server.pid even though nothing consumed the second file. Pid-file
// handling is now a pure helper, so the fix is locked in by behavior: exactly
// one port-scoped pid file is written per instance.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pidFiles = require('../../server/pid-files');

function testDefaultPortWritesExactlyOnePortScopedPidFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-pid-'));
  try {
    const resolved = pidFiles.resolvePidFiles({ port: 8765, pidDir: dir });
    assert.deepStrictEqual(resolved.map(file => path.basename(file)), ['chatui-8765.pid']);
    assert.ok(!resolved.some(file => path.basename(file) === 'chatui-server.pid'), 'the redundant unversioned pid file must not be written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testNonDefaultPortKeepsPortScopedNaming() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-pid-'));
  try {
    const resolved = pidFiles.resolvePidFiles({ port: 9000, pidDir: dir });
    assert.deepStrictEqual(resolved.map(file => path.basename(file)), ['chatui-9000.pid']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testPidWritingAndOwnershipRemoval() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-pid-'));
  try {
    const [file] = pidFiles.resolvePidFiles({ port: 8765, pidDir: dir });
    pidFiles.writePidFiles([file], 4242);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '4242\n');

    // Foreign pid content must never be removed.
    fs.writeFileSync(file, '9999\n');
    pidFiles.removeOwnPidFiles([file], 4242);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '9999\n');

    // Own pid content is removed.
    fs.writeFileSync(file, '4242\n');
    pidFiles.removeOwnPidFiles([file], 4242);
    assert.ok(!fs.existsSync(file), 'the instance-owned pid file must be removed on shutdown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testPidFilesCanBeDisabled() {
  assert.deepStrictEqual(pidFiles.resolvePidFiles({ port: 8765, pidDir: '' }), []);
}

module.exports = [
  testDefaultPortWritesExactlyOnePortScopedPidFile,
  testNonDefaultPortKeepsPortScopedNaming,
  testPidWritingAndOwnershipRemoval,
  testPidFilesCanBeDisabled,
];