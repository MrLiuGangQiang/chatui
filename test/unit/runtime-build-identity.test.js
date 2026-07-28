'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  computeRuntimeSourceRevision,
  createBuildIdentity,
  isDockerRuntimeFile,
  runtimeSourceFiles,
} = require('../../server/build-identity');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-runtime-identity-'));
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.mkdirSync(path.join(root, 'client'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vendor', 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}');
  fs.writeFileSync(path.join(root, 'server.js'), 'require("./server/app")');
  fs.writeFileSync(path.join(root, 'server', 'app.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(root, 'client', 'app.js'), 'window.ChatUI = {};\n');
  return root;
}

function testRuntimeSourceRevisionTracksExactlyDockerRuntimeCode() {
  const root = makeFixture();
  try {
    const before = computeRuntimeSourceRevision(root);
    assert.match(before, /^sha256:[a-f0-9]{64}$/);
    assert.deepStrictEqual(runtimeSourceFiles(root), ['client/app.js', 'package.json', 'server.js', 'server/app.js']);

    fs.writeFileSync(path.join(root, 'vendor', 'chunks', 'ignored.js'), 'ignored');
    fs.writeFileSync(path.join(root, 'client', 'notes.md'), 'ignored');
    assert.strictEqual(computeRuntimeSourceRevision(root), before, 'Docker-excluded files must not change runtime identity');

    fs.writeFileSync(path.join(root, 'client', 'app.js'), 'window.ChatUI = {};\r\n');
    assert.strictEqual(computeRuntimeSourceRevision(root), before, 'platform line endings must not make identical source look like a different image');

    fs.writeFileSync(path.join(root, 'client', 'app.js'), 'window.ChatUI = { fixed: true };');
    assert.notStrictEqual(computeRuntimeSourceRevision(root), before, 'a browser runtime change must change image identity');
    assert.strictEqual(isDockerRuntimeFile('vendor/chunks/a.js'), false);
    assert.strictEqual(isDockerRuntimeFile('client/app.js'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testInjectedImageIdentityFailsClosedOnSourceMismatch() {
  const root = makeFixture();
  try {
    const sourceRevision = computeRuntimeSourceRevision(root);
    const identity = createBuildIdentity({
      root,
      version: '1.2.3',
      env: { CHATUI_BUILD_SHA: 'abc123', CHATUI_SOURCE_REVISION: sourceRevision },
    });
    assert.deepStrictEqual(identity, {
      version: '1.2.3', gitSha: 'abc123', sourceRevision, dirty: false, mode: 'image',
    });
    assert.throws(() => createBuildIdentity({
      root,
      version: '1.2.3',
      env: { CHATUI_BUILD_SHA: 'abc123', CHATUI_SOURCE_REVISION: 'sha256:wrong' },
    }), /runtime source mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testReleaseWorkflowsVerifyThenPromoteOneDigest() {
  const root = path.resolve(__dirname, '../..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(root, '.github/workflows/dockerhub.yml'), 'utf8');
  const preview = fs.readFileSync(path.join(root, 'scripts/preview-release.js'), 'utf8');

  assert.match(dockerfile, /CHATUI_SOURCE_REVISION=\$\{CHATUI_SOURCE_REVISION\}/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/);
  assert.match(ci, /Verify exact container identity and assets/);
  assert.ok(ci.includes(`VERSION="$(node -p "require('./package.json').version")"`),
    'CI must resolve a non-empty package version without passing escaped quotes to Node');
  assert.ok(ci.includes('test -n "$VERSION"'),
    'CI must fail before building when the candidate version is empty');
  assert.ok(!ci.includes('require(\\"./package.json\\")'),
    'CI must not use a shell expression that silently writes an empty version output');
  assert.match(ci, /CHATUI_SOURCE_REVISION=\$\{\{ steps\.identity\.outputs\.source_revision \}\}/);
  assert.match(release, /Build once and push immutable candidates/);
  assert.match(release, /Pull and verify the exact candidate digest/);
  assert.match(release, /Promote the verified digest without rebuilding/);
  assert.match(release, /imagetools create/);
  assert.match(release, /verify-release-ref\.js/);
  assert.match(preview, /release preview requires a clean committed worktree/);
}

module.exports = [
  testRuntimeSourceRevisionTracksExactlyDockerRuntimeCode,
  testInjectedImageIdentityFailsClosedOnSourceMismatch,
  testReleaseWorkflowsVerifyThenPromoteOneDigest,
];
